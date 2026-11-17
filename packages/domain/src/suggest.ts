import type { CategorySuggestion, PayeeKind, SuggestionConfidence } from '@hroshi/schema';

import { FALLBACK_CATEGORY } from './classify.ts';
import { describeMcc } from './mcc.ts';
import { detectPayeeKind, findBankText, findPayeeText, normalizeMerchant } from './merchants.ts';
import type { LedgerTransaction, MatchableRule } from './types.ts';

export type SuggestionTransaction = Pick<LedgerTransaction, 'type' | 'category' | 'note' | 'bankText'> & { needsReview: boolean };

/** How the owner booked each payee before: payee key → category → rows. */
export type PayeeHistory = ReadonlyMap<string, ReadonlyMap<string, number>>;

export const indexPayeeHistory = (transactions: readonly SuggestionTransaction[]): PayeeHistory => {
  const history = new Map<string, Map<string, number>>();
  for (const transaction of transactions) {
    const { category } = transaction;
    if (transaction.needsReview || category === null || category === FALLBACK_CATEGORY) continue;
    if (transaction.type !== 'expense' && transaction.type !== 'income') continue;
    const { key } = normalizeMerchant(findPayeeText(transaction));
    const counts = history.get(key) ?? new Map<string, number>();
    history.set(key, counts);
    counts.set(category, (counts.get(category) ?? 0) + 1);
  }
  return history;
};

/** Past rows a payee needs in one category before its suggestion may be accepted unseen. */
const CONFIDENT_COUNT = 3;
/** And the share of that payee's rows the category must hold: a payee split between two is a question. */
const CONFIDENT_SHARE = 0.8;

const rateConfidence = ({ count, total }: { count: number; total: number }): SuggestionConfidence => {
  if (count >= CONFIDENT_COUNT && count / total >= CONFIDENT_SHARE) return 'high';
  return count >= 2 && count / total > 0.5 ? 'medium' : 'low';
};

/**
 * A category for a row waiting in review: what the owner chose for the same payee before,
 * else what the MCC fallback rules say. Null when neither knows; the inbox then asks.
 */
export const suggestCategory = ({
  transaction,
  history,
  rules,
  mcc,
}: {
  transaction: SuggestionTransaction;
  history: PayeeHistory;
  rules: readonly MatchableRule[];
  mcc: number | null;
}): CategorySuggestion | null => {
  const { key, name } = normalizeMerchant(findPayeeText(transaction));
  const counts = [...(history.get(key) ?? new Map<string, number>())].toSorted((left, right) => right[1] - left[1]);
  const [best] = counts;
  if (best !== undefined) {
    const [category, count] = best;
    const total = counts.reduce((sum, [, rows]) => sum + rows, 0);
    const others = total === count ? '' : `, інакше ще ${total - count}×`;
    return {
      category,
      basis: 'payee',
      reason: `Раніше «${name}» записували як «${category}» (${count}×${others})`,
      confidence: rateConfidence({ count, total }),
    };
  }
  const rule = rules
    .toSorted((left, right) => left.priority - right.priority)
    .find((candidate) => candidate.pattern === null && candidate.mcc === mcc && candidate.category !== null);
  if (rule?.category == null || mcc === null) return null;
  const label = describeMcc(mcc);
  return {
    category: rule.category,
    basis: 'mcc',
    reason: `MCC ${mcc}${label === null ? '' : ` (${label})`} зазвичай «${rule.category}»`,
    // A merchant code says what kind of shop it is, not how the owner books it.
    confidence: 'low',
  };
};

type Tally = ReadonlyMap<string, ReadonlyMap<string, number>>;

/** For how many different payees each category was chosen, per direction: per payee kind and per MCC. */
export type CategoryUse = { byKind: Tally; byMcc: Tally };

export type CategoryUseTransaction = SuggestionTransaction & { mcc: number | null };

const countPayees = (seen: ReadonlyMap<string, ReadonlySet<string>>): Tally => {
  const tally = new Map<string, Map<string, number>>();
  for (const [entry, payees] of seen) {
    const [key = '', category = ''] = entry.split('\u0000');
    const counts = tally.get(key) ?? new Map<string, number>();
    tally.set(key, counts);
    counts.set(category, payees.size);
  }
  return tally;
};

const remember = ({ seen, key, category, payee }: { seen: Map<string, Set<string>>; key: string; category: string; payee: string }) => {
  const entry = `${key}\u0000${category}`;
  const payees = seen.get(entry) ?? new Set<string>();
  seen.set(entry, payees);
  payees.add(payee);
};

/** Payees, not rows, are counted: one friend paid a hundred times must not outrank a category used for many. */
export const indexCategoryUse = (transactions: readonly CategoryUseTransaction[]): CategoryUse => {
  const byKind = new Map<string, Set<string>>();
  const byMcc = new Map<string, Set<string>>();
  for (const transaction of transactions) {
    const { category, type } = transaction;
    if (transaction.needsReview || category === null || category === FALLBACK_CATEGORY) continue;
    if (type !== 'expense' && type !== 'income') continue;
    const payee = normalizeMerchant(findPayeeText(transaction)).key;
    const kind = detectPayeeKind({ text: findBankText(transaction), mcc: transaction.mcc });
    remember({ seen: byKind, key: `${type}:${kind}`, category, payee });
    if (transaction.mcc !== null) remember({ seen: byMcc, key: `${type}:${transaction.mcc}`, category, payee });
  }
  return { byKind: countPayees(byKind), byMcc: countPayees(byMcc) };
};

const rankCounts = (counts: ReadonlyMap<string, number> | undefined): string[] =>
  [...(counts ?? new Map<string, number>())].toSorted((left, right) => right[1] - left[1]).map(([category]) => category);

/** Kinds whose MCC is a bank's generic transfer code: it says nothing about what the money was for. */
const TRANSFER_MCC_KINDS: ReadonlySet<PayeeKind> = new Set(['person', 'tax', 'own', 'cash']);

/**
 * Codes banks put on money moving rather than on a purchase: a transfer, a card top-up, a cash
 * withdrawal, a P2P push. Whatever the owner booked under them is about the people, not the code.
 */
const MONEY_MOVEMENT_MCCS: ReadonlySet<number> = new Set([4829, 6010, 6011, 6012, 6536, 6537, 6538, 6540]);

/**
 * Kinds that name their category by themselves: a tax office is taxes whoever it is. A person is not
 * such a kind: what the owner booked for other people (a friend's name, «Підробіток») says nothing
 * about a stranger.
 */
const CATEGORY_NAMING_KINDS: ReadonlySet<PayeeKind> = new Set(['tax']);

/**
 * Categories to offer in one click when the inbox has no confident guess, only from a real signal:
 * this payee's own past categories, what its kind always gets (taxes) and what its shop code usually
 * gets. Without one the list is empty, and the inbox offers a transfer and the full category picker
 * instead of the owner's most used categories dressed up as a guess.
 */
export const rankCandidateCategories = ({
  transaction,
  kind,
  history,
  use,
  isAllowed,
  limit = 3,
}: {
  transaction: CategoryUseTransaction;
  kind: PayeeKind;
  history: PayeeHistory;
  use: CategoryUse;
  /** Archived categories and ones for the other direction are left out. */
  isAllowed: (category: string) => boolean;
  limit?: number;
}): string[] => {
  const direction = transaction.type === 'income' ? 'income' : 'expense';
  const payee = rankCounts(history.get(normalizeMerchant(findPayeeText(transaction)).key));
  const byKind = CATEGORY_NAMING_KINDS.has(kind) ? rankCounts(use.byKind.get(`${direction}:${kind}`)) : [];
  const { mcc } = transaction;
  const byMcc =
    mcc === null || TRANSFER_MCC_KINDS.has(kind) || MONEY_MOVEMENT_MCCS.has(mcc) ? [] : rankCounts(use.byMcc.get(`${direction}:${mcc}`));
  return [...new Set([...payee, ...byKind, ...byMcc])].filter(isAllowed).slice(0, limit);
};
