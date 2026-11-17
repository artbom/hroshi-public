import type { IsoDate, Month, TagSummary, TripReport, TripSpendKind, TripSummary, Transaction } from '@hroshi/schema';

import { type CategoryPolicies, classifyTransaction } from './classify.ts';
import { convertToEur, type FxConverter } from './fx.ts';
import type { LedgerTransaction } from './types.ts';

/** Rows without a merchant code (hand entries, older imports) count as «other» in a trip's breakdown. */
export type TaggedTransaction = LedgerTransaction & Pick<Transaction, 'tags'> & Partial<Pick<Transaction, 'mcc'>>;

/** A tag that marks a trip; the rest («shared», …) are plain labels. */
export const TRIP_TAG_PREFIX = 'trip:';

const isTrip = (tag: string) => tag.startsWith(TRIP_TAG_PREFIX);

const DAY_MS = 86_400_000;

/** Both ends count: a trip from the 7th to the 10th is four days. */
const countTripDays = (from: IsoDate, to: IsoDate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS) + 1;

const inRange = (mcc: number, low: number, high: number) => mcc >= low && mcc <= high;

/**
 * What a trip's money went on, read from the merchant code: rules book a whole trip under one
 * category («Подорожі»), so the category says nothing about flights versus dinners. Airlines,
 * car rental and hotels have their own code ranges (3000–3299, 3351–3441, 3501–3999).
 */
export const findTripSpendKind = (mcc: number | null): TripSpendKind => {
  if (mcc === null) return 'other';
  if (inRange(mcc, 3000, 3441) || [4011, 4111, 4112, 4121, 4131, 4411, 4511, 4784, 4789, 5541, 5542, 7512, 7519, 7523].includes(mcc)) {
    return 'transport';
  }
  if (inRange(mcc, 3501, 3999) || [6513, 7011, 7012].includes(mcc)) return 'stay';
  if (inRange(mcc, 5411, 5499) || inRange(mcc, 5811, 5814)) return 'food';
  if ([4722, 7922, 7929, 7932, 7933, 7941, 7991, 7996, 7998, 7999].includes(mcc)) return 'fun';
  return 'other';
};

type TagTotals = {
  eur: number;
  rows: number;
  from: IsoDate;
  to: IsoDate;
  categories: Map<string, number>;
  kinds: Map<TripSpendKind, number>;
};

/** Parts under half a euro are rounding, not something to read. */
const MIN_PART_EUR = 0.5;

const listParts = <TKey extends string>(parts: ReadonlyMap<TKey, number>) =>
  [...parts].filter(([, eur]) => Math.abs(eur) >= MIN_PART_EUR).toSorted(([, left], [, right]) => right - left);

/** What each tag (a trip, "shared") cost, net of refunds, how long it lasted and what its money went on, newest first. */
const summarizeTagTrips = ({
  transactions,
  policies,
  fx,
}: {
  transactions: readonly TaggedTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
}): TripSummary[] => {
  const tags = new Map<string, TagTotals>();

  for (const transaction of transactions) {
    const effect = classifyTransaction(transaction, policies);
    const eur = effect.kind === 'spend' ? convertToEur({ transaction, fx }) : null;
    for (const tag of transaction.tags) {
      const summary = tags.get(tag) ?? {
        eur: 0,
        rows: 0,
        from: transaction.date,
        to: transaction.date,
        categories: new Map(),
        kinds: new Map(),
      };
      tags.set(tag, summary);
      summary.rows += 1;
      if (transaction.date < summary.from) summary.from = transaction.date;
      if (transaction.date > summary.to) summary.to = transaction.date;
      if (effect.kind !== 'spend' || eur === null) continue;
      const signed = effect.sign * eur;
      const found = findTripSpendKind(transaction.mcc ?? null);
      // A friend's share sent back comes as a card transfer or with no merchant code at all: a return, not negative «other».
      const kind = effect.sign < 0 && found === 'other' ? 'returns' : found;
      summary.eur += signed;
      summary.categories.set(effect.category, (summary.categories.get(effect.category) ?? 0) + signed);
      summary.kinds.set(kind, (summary.kinds.get(kind) ?? 0) + signed);
    }
  }

  return [...tags]
    .map(([tag, summary]) => ({
      tag,
      eur: summary.eur,
      rows: summary.rows,
      from: summary.from,
      to: summary.to,
      days: countTripDays(summary.from, summary.to),
      categories: listParts(summary.categories).map(([category, eur]) => ({ category, eur })),
      kinds: listParts(summary.kinds).map(([kind, eur]) => ({ kind, eur })),
    }))
    .toSorted((left, right) => right.to.localeCompare(left.to));
};

/** What each tag (a trip, "shared") cost, net of refunds, newest first. */
export const summarizeTags = (input: {
  transactions: readonly TaggedTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
}): TagSummary[] => summarizeTagTrips(input).map(({ tag, eur, rows, from, to, categories }) => ({ tag, eur, rows, from, to, categories }));

/** The category trips are booked under: where most of the tagged trips' spending lands. */
const findTravelCategory = (trips: readonly TripSummary[]): string | null => {
  const totals = new Map<string, number>();
  for (const trip of trips) for (const { category, eur } of trip.categories) totals.set(category, (totals.get(category) ?? 0) + eur);
  return [...totals].toSorted(([, left], [, right]) => right - left)[0]?.[0] ?? null;
};

/**
 * Tags whose days touch the period, and the travel spending of the period that carries no trip
 * tag (flights booked months ahead, a weekend nobody tagged), so the trips' sum can be read
 * against the category's.
 */
export const summarizeTrips = ({
  transactions,
  policies,
  fx,
  from,
  to,
}: {
  transactions: readonly TaggedTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
  from: Month;
  to: Month;
}): TripReport => {
  const all = summarizeTagTrips({ transactions, policies, fx });
  const tags = all.filter((tag) => tag.to.slice(0, 7) >= from && tag.from.slice(0, 7) <= to);
  const category = findTravelCategory(all.filter((tag) => isTrip(tag.tag)));
  if (category === null) return { from, to, tags, untagged: null };
  let eur = 0;
  let rows = 0;
  for (const transaction of transactions) {
    const month = transaction.date.slice(0, 7);
    if (month < from || month > to || transaction.tags.some(isTrip)) continue;
    const effect = classifyTransaction(transaction, policies);
    if (effect.kind !== 'spend' || effect.category !== category) continue;
    eur += effect.sign * (convertToEur({ transaction, fx }) ?? 0);
    rows += 1;
  }
  return { from, to, tags, untagged: { category, eur, rows } };
};
