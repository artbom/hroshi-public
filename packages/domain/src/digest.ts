import type { IsoDate } from '@hroshi/schema';

import { type CategoryPolicies, classifyTransaction } from './classify.ts';
import type { FxConverter } from './fx.ts';
import { extractMerchant } from './merchants.ts';
import { shiftDate, toMonth } from './months.ts';
import type { LedgerTransaction } from './types.ts';

/** Weeks before a week that make "a usual week"; two months smooths out rent and trips. */
const BASELINE_WEEKS = 8;
const TOP_CATEGORIES = 6;
const TOP_MERCHANTS = 5;
const LARGEST_EXPENSES = 3;
/** A limit is worth a line once the month reaches this share of it. */
const LIMIT_ALERT_RATIO = 0.9;
/** Card holds (car rental, hotels) are released within about two weeks, often after the week ends. */
const HOLD_RELEASE_DAYS = 14;
const CANCELLATION = /^скасування/iu;

/**
 * Pairs each released hold with its purchase so neither shows up in a weekly window: a
 * 52 141 ₴ car-rental deposit returned three days later is not a big purchase of the week.
 */
const netReleasedHolds = (transactions: readonly LedgerTransaction[]): LedgerTransaction[] => {
  const releases = transactions
    .filter((transaction) => transaction.type === 'income' && CANCELLATION.test(transaction.note ?? ''))
    .map((transaction) => ({ transaction, left: transaction.amount }))
    .toSorted((left, right) => left.transaction.date.localeCompare(right.transaction.date));
  const remaining = new Map<LedgerTransaction, number>();

  for (const transaction of transactions) {
    if (transaction.type !== 'expense') continue;
    const merchant = extractMerchant(transaction.note);
    const until = shiftDate(transaction.date, HOLD_RELEASE_DAYS);
    let amount = transaction.amount;
    for (const release of releases) {
      if (amount <= 0) break;
      const { transaction: income } = release;
      if (release.left <= 0 || income.accountId !== transaction.accountId || income.date < transaction.date || income.date > until) continue;
      if (extractMerchant(income.note) !== merchant) continue;
      const used = Math.min(amount, release.left);
      amount -= used;
      release.left -= used;
    }
    remaining.set(transaction, amount);
  }
  for (const release of releases) remaining.set(release.transaction, release.left);

  return transactions.flatMap((transaction) => {
    const amount = remaining.get(transaction);
    if (amount === undefined) return [transaction];
    return amount > 0.005 ? [{ ...transaction, amount }] : [];
  });
};

export type PeriodDigest = {
  from: IsoDate;
  to: IsoDate;
  spentEur: number;
  incomeEur: number;
  usualSpentEur: number;
  categories: { category: string; eur: number; usualEur: number }[];
  merchants: { merchant: string; eur: number; count: number }[];
  largest: { date: IsoDate; merchant: string; category: string; eur: number }[];
  limits: { category: string; limitEur: number; spentEur: number }[];
};

const isWithin = (date: IsoDate, from: IsoDate, to: IsoDate) => date >= from && date <= to;

const sumValues = (totals: Map<string, number>) => [...totals.values()].reduce((total, value) => total + value, 0);

const addTo = (totals: Map<string, number>, key: string, value: number) => totals.set(key, (totals.get(key) ?? 0) + value);

/**
 * Spending of one period next to a usual week (the average of the weeks before it), with the
 * merchants, the largest purchases and the soft limits close to running out this month.
 */
export const summarizePeriod = ({
  from,
  to,
  transactions,
  policies,
  fx,
  limits,
  baselineFrom = shiftDate(from, -7 * BASELINE_WEEKS),
  baselinePeriods = BASELINE_WEEKS,
}: {
  from: IsoDate;
  to: IsoDate;
  transactions: readonly LedgerTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
  limits: ReadonlyMap<string, number>;
  /** Where "usual" starts and how many periods it spans; defaults to the eight weeks before a week. */
  baselineFrom?: IsoDate;
  baselinePeriods?: number;
}): PeriodDigest => {
  const baselineTo = shiftDate(from, -1);
  const monthStart = `${toMonth(to)}-01`;
  const spent = new Map<string, number>();
  const usual = new Map<string, number>();
  const monthSpent = new Map<string, number>();
  const merchants = new Map<string, { eur: number; count: number }>();
  const expenses: PeriodDigest['largest'] = [];
  let incomeEur = 0;

  for (const transaction of netReleasedHolds(transactions.filter((candidate) => candidate.date >= shiftDate(baselineFrom, -HOLD_RELEASE_DAYS)))) {
    const { date } = transaction;
    const inPeriod = isWithin(date, from, to);
    const inBaseline = isWithin(date, baselineFrom, baselineTo);
    const inMonth = isWithin(date, monthStart, to);
    if (!inPeriod && !inBaseline && !inMonth) continue;
    const eur = fx.toEur(transaction.amount, transaction.currency, date);
    if (eur === null) continue;
    const effect = classifyTransaction(transaction, policies);

    if (effect.kind === 'income' && inPeriod) incomeEur += eur;
    if (effect.kind !== 'spend') continue;
    const signed = effect.sign * eur;
    if (inMonth) addTo(monthSpent, effect.category, signed);
    if (inBaseline) addTo(usual, effect.category, signed / baselinePeriods);
    if (!inPeriod) continue;

    addTo(spent, effect.category, signed);
    const merchant = extractMerchant(transaction.note);
    const entry = merchants.get(merchant) ?? { eur: 0, count: 0 };
    merchants.set(merchant, { eur: entry.eur + signed, count: entry.count + (effect.sign > 0 ? 1 : 0) });
    if (effect.sign > 0) expenses.push({ date, merchant, category: effect.category, eur });
  }

  return {
    from,
    to,
    spentEur: sumValues(spent),
    incomeEur,
    usualSpentEur: sumValues(usual),
    categories: [...spent]
      .filter(([, eur]) => eur >= 0.5)
      .map(([category, eur]) => ({ category, eur, usualEur: usual.get(category) ?? 0 }))
      .toSorted((left, right) => right.eur - left.eur)
      .slice(0, TOP_CATEGORIES),
    merchants: [...merchants]
      .map(([merchant, entry]) => ({ merchant, ...entry }))
      .filter(({ eur }) => eur >= 0.5)
      .toSorted((left, right) => right.eur - left.eur)
      .slice(0, TOP_MERCHANTS),
    largest: expenses.toSorted((left, right) => right.eur - left.eur).slice(0, LARGEST_EXPENSES),
    limits: [...limits]
      .map(([category, limitEur]) => ({ category, limitEur, spentEur: Math.max(0, monthSpent.get(category) ?? 0) }))
      .filter(({ limitEur, spentEur }) => spentEur >= limitEur * LIMIT_ALERT_RATIO),
  };
};
