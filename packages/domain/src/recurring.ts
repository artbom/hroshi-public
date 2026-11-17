import type { Currency, IsoDate, Month, PlannedOverride, Recurring, RecurringPayment } from '@hroshi/schema';

import { type CategoryPolicies, classifyTransaction } from './classify.ts';
import { convertToEur, type FxConverter } from './fx.ts';
import { describePayee, findPayeeText, normalizeMerchant } from './merchants.ts';
import { countDaysBetween, shiftDate, shiftMonth, toMonth } from './months.ts';
import type { LedgerTransaction } from './types.ts';

const LOOKBACK_DAYS = 183;
const MIN_OCCURRENCES = 3;
/** Roughly monthly: rent paid on the 1st or the 30th still lands inside. */
const MIN_CADENCE_DAYS = 25;
const MAX_CADENCE_DAYS = 35;
/** Interquartile range over the median: one estimated or one-off amount does not hide a monthly bill. */
const MAX_AMOUNT_SPREAD = 0.25;
/** A merchant that also sells one-offs (Apple) is tested again on the payments close to each amount. */
const CLUSTER_TOLERANCE = MAX_AMOUNT_SPREAD / 2;
/**
 * Above about two payments a month a merchant is an everyday shop (Glovo, a supermarket): some
 * of its similar amounts always line up a month apart, which is chance, not a subscription.
 */
const MAX_CLUSTERED_OCCURRENCES = 12;
/** Overdue by more than this share of the cadence: probably stopped or moved elsewhere. */
const LATE_SHARE = 0.5;
const DAYS_PER_MONTH = 365.25 / 12;
/** A confirmed payment is settled by any payment to the payee within this share of the agreed amount. */
const CONFIRMED_MATCH_SHARE = 0.5;

type Occurrence = { date: IsoDate; amount: number; currency: Currency; eur: number; category: string; accountId: string };

const findQuantile = (sorted: readonly number[], share: number): number => {
  const position = (sorted.length - 1) * share;
  const lower = sorted[Math.floor(position)] ?? 0;
  const upper = sorted[Math.ceil(position)] ?? lower;
  return lower + (upper - lower) * (position - Math.floor(position));
};

export const findMedian = (values: readonly number[]): number =>
  findQuantile(
    values.toSorted((left, right) => left - right),
    0.5,
  );

/** Interquartile range relative to the median. */
export const measureSpread = (values: readonly number[]): number => {
  const sorted = values.toSorted((left, right) => left - right);
  const median = findQuantile(sorted, 0.5);
  return median === 0 ? Number.POSITIVE_INFINITY : (findQuantile(sorted, 0.75) - findQuantile(sorted, 0.25)) / median;
};

const measureCadence = (occurrences: readonly Occurrence[]): number => {
  const dates = [...new Set(occurrences.map((occurrence) => occurrence.date))].toSorted();
  return findMedian(dates.slice(1).map((date, index) => countDaysBetween(dates[index] ?? date, date)));
};

const isRecurring = (occurrences: readonly Occurrence[]) => {
  if (occurrences.length < MIN_OCCURRENCES) return false;
  const cadence = measureCadence(occurrences);
  return (
    cadence >= MIN_CADENCE_DAYS &&
    cadence <= MAX_CADENCE_DAYS &&
    measureSpread(occurrences.map((occurrence) => occurrence.eur)) <= MAX_AMOUNT_SPREAD
  );
};

/** The whole merchant first, then the payments grouped around each amount, biggest group first. */
const listCandidates = (occurrences: readonly Occurrence[]): (readonly Occurrence[])[] => {
  if (occurrences.length > MAX_CLUSTERED_OCCURRENCES) return [occurrences];
  const clusters = new Map<string, Occurrence[]>();
  for (const anchor of occurrences) {
    const members = occurrences.filter(
      (occurrence) => Math.abs(occurrence.eur - anchor.eur) <= anchor.eur * CLUSTER_TOLERANCE,
    );
    clusters.set(members.map((member) => `${member.date}:${member.eur}`).join('|'), members);
  }
  return [occurrences, ...[...clusters.values()].toSorted((left, right) => right.length - left.length)];
};

const describePayment = ({
  name,
  key,
  occurrences,
  today,
}: {
  name: string;
  key: string;
  occurrences: readonly Occurrence[];
  today: IsoDate;
}): RecurringPayment => {
  const byDate = occurrences.toSorted((left, right) => left.date.localeCompare(right.date));
  const latest = byDate.at(-1) ?? byDate[0];
  const currency = latest?.currency ?? 'EUR';
  const lastDate = latest?.date ?? today;
  const cadenceDays = measureCadence(byDate);
  const nextDate = shiftDate(lastDate, Math.round(cadenceDays));
  return {
    key,
    name,
    category: latest?.category ?? '',
    accountId: latest?.accountId ?? '',
    amount: findMedian(byDate.filter((occurrence) => occurrence.currency === currency).map((occurrence) => occurrence.amount)),
    currency,
    eur: findMedian(byDate.map((occurrence) => occurrence.eur)),
    occurrences: byDate.length,
    cadenceDays,
    lastDate,
    nextDate,
    late: countDaysBetween(nextDate, today) > cadenceDays * LATE_SHARE,
    status: 'detected',
    dayOfMonth: null,
    overdueDays: Math.max(0, countDaysBetween(nextDate, today)),
  };
};

const countDaysInMonth = (month: Month) => countDaysBetween(`${month}-01`, `${shiftMonth(month, 1)}-01`);

/** A due day past the month's end means its last day: the 31st falls on 30 November. */
const findDueDate = ({ month, day }: { month: Month; day: number }): IsoDate =>
  `${month}-${String(Math.min(day, countDaysInMonth(month))).padStart(2, '0')}`;

/**
 * The due date after the one a payment settled. Rent due on the 1st and paid on 29 October
 * settles November, so the next one is due in December.
 */
const findNextDueDate = ({ paidOn, day }: { paidOn: IsoDate; day: number }): IsoDate => {
  const month = toMonth(paidOn);
  const settled = [-1, 1].reduce((nearest, delta) => {
    const due = findDueDate({ month: shiftMonth(month, delta), day });
    return Math.abs(countDaysBetween(due, paidOn)) < Math.abs(countDaysBetween(nearest, paidOn)) ? due : nearest;
  }, findDueDate({ month, day }));
  return findDueDate({ month: shiftMonth(toMonth(settled), 1), day });
};

/**
 * A payment on the owner's terms. It stays expected even when history stops looking regular
 * (rent paid in cash and booked late), and it is overdue from the day he named, not from a guess.
 */
const describeConfirmed = ({
  override,
  detected,
  occurrences,
  fx,
  today,
}: {
  override: PlannedOverride;
  detected: RecurringPayment | undefined;
  occurrences: readonly Occurrence[];
  fx: FxConverter;
  today: IsoDate;
}): RecurringPayment => {
  const currency = override.currency ?? detected?.currency ?? 'EUR';
  const amount = override.amount ?? detected?.amount ?? 0;
  const eur = fx.toEur(amount, currency, today) ?? detected?.eur ?? 0;
  const matched = occurrences
    .filter((occurrence) => eur <= 0 || Math.abs(occurrence.eur - eur) <= eur * CONFIRMED_MATCH_SHARE)
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const paidOn = matched.at(-1)?.date ?? null;
  const day = override.dayOfMonth ?? Number((paidOn ?? detected?.nextDate ?? today).slice(8, 10));
  const nextDate = paidOn === null ? findDueDate({ month: toMonth(today), day }) : findNextDueDate({ paidOn, day });
  return {
    key: override.key,
    name: override.name ?? detected?.name ?? override.key,
    category: override.category ?? detected?.category ?? '',
    accountId: override.accountId ?? detected?.accountId ?? '',
    amount,
    currency,
    eur,
    occurrences: matched.length,
    cadenceDays: DAYS_PER_MONTH,
    // Never paid in the window: the previous due date stands in, so the payment reads as not yet settled.
    lastDate: paidOn ?? findDueDate({ month: shiftMonth(toMonth(nextDate), -1), day }),
    nextDate,
    late: false,
    status: 'confirmed',
    dayOfMonth: day,
    overdueDays: Math.max(0, countDaysBetween(nextDate, today)),
  };
};

/** An ignored payment keeps what detection knew about it, so the owner sees what he set aside. */
const describeIgnored = ({ override, detected }: { override: PlannedOverride; detected: RecurringPayment | undefined }): PlannedOverride => ({
  ...override,
  name: override.name ?? detected?.name ?? null,
  amount: override.amount ?? detected?.amount ?? null,
  currency: override.currency ?? detected?.currency ?? null,
  category: override.category ?? detected?.category ?? null,
  accountId: override.accountId ?? detected?.accountId ?? null,
});

/**
 * Expenses that come back about monthly at about the same amount: rent, utilities, parking,
 * subscriptions. Judged on the last half year, by payee, in EUR so a euro subscription paid
 * from a hryvnia card still looks constant.
 */
export const detectRecurring = ({
  transactions,
  policies,
  fx,
  today,
  overrides = [],
}: {
  transactions: readonly LedgerTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
  today: IsoDate;
  /** The owner's word: confirmed ones replace what detection found, ignored ones drop out. */
  overrides?: readonly PlannedOverride[];
}): Recurring => {
  const since = shiftDate(today, -LOOKBACK_DAYS);
  const byMerchant = new Map<string, { name: string; occurrences: Occurrence[] }>();

  for (const transaction of transactions) {
    if (transaction.type !== 'expense' || transaction.date < since || transaction.date > today) continue;
    const effect = classifyTransaction(transaction, policies);
    const eur = convertToEur({ transaction, fx });
    if (effect.kind !== 'spend' || eur === null) continue;
    const text = findPayeeText(transaction);
    const { key } = normalizeMerchant(text);
    const payee = describePayee({ text, category: effect.category });
    const group = byMerchant.get(key) ?? { name: payee.unnamed ? `${payee.name} · без назви` : payee.name, occurrences: [] };
    byMerchant.set(key, group);
    group.occurrences.push({
      date: transaction.date,
      amount: transaction.amount,
      currency: transaction.currency,
      eur,
      category: effect.category,
      accountId: transaction.accountId,
    });
  }

  const detected = new Map(
    [...byMerchant].flatMap(([key, { name, occurrences }]) => {
      const recurring = listCandidates(occurrences).find(isRecurring);
      return recurring === undefined ? [] : [[key, describePayment({ key, name, occurrences: recurring, today })] as const];
    }),
  );
  const overridden = new Set(overrides.map((override) => override.key));
  const confirmed = overrides
    .filter((override) => override.status === 'confirmed')
    .map((override) =>
      describeConfirmed({
        override,
        detected: detected.get(override.key),
        occurrences: byMerchant.get(override.key)?.occurrences ?? [],
        fx,
        today,
      }),
    );
  const payments = [...[...detected.values()].filter((payment) => !overridden.has(payment.key)), ...confirmed];

  return {
    payments: payments.toSorted((left, right) => right.eur - left.eur),
    monthlyEur: payments
      .filter((payment) => !payment.late)
      .reduce((sum, payment) => sum + (payment.eur * DAYS_PER_MONTH) / payment.cadenceDays, 0),
    since,
    ignored: overrides
      .filter((override) => override.status === 'ignored')
      .map((override) => describeIgnored({ override, detected: detected.get(override.key) })),
  };
};
