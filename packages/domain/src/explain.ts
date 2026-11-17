import type { Classification, ClassificationVerdict, Transaction } from '@hroshi/schema';

import { type CategoryPolicies, classifyTransaction, FALLBACK_CATEGORY } from './classify.ts';
import { countDaysBetween } from './months.ts';
import { findMatchingRule } from './rules.ts';
import type { LedgerTransaction, MatchableRule } from './types.ts';

export type ExplainedTransaction = LedgerTransaction & Pick<Transaction, 'source' | 'synced'>;

const ATM_MCC = 6011;
const P2P_LINE = /^binance:p2p:/u;
const P2P_NOTE = /^P2P\b/u;
/** Mono books a released hold or a refund as "Скасування. <merchant>". */
const CANCELLATION_PREFIX = /^скасування\.?\s*/iu;
/** Card holds (hotels, car rental) are released within weeks. */
const CANCELLATION_WINDOW_DAYS = 45;
/** The second leg of a ФОП sale reaches the card the same day or the next. */
const CHAIN_WINDOW_DAYS = 1;

const isBookedByRule = (transaction: ExplainedTransaction, rule: MatchableRule): boolean => {
  if (rule.category !== null) {
    return (transaction.type === 'expense' || transaction.type === 'income') && transaction.category === rule.category;
  }
  return (
    transaction.type === 'transfer' &&
    (transaction.toAccountId === rule.transferToAccountId || transaction.accountId === rule.transferToAccountId)
  );
};

const findTransferVerdict = ({
  transaction,
  rule,
  mcc,
  toLineId,
}: {
  transaction: ExplainedTransaction;
  rule: MatchableRule | undefined;
  mcc: number | null;
  toLineId: string | null;
}): ClassificationVerdict => {
  if (rule?.transferToAccountId != null) return 'rule';
  if (mcc === ATM_MCC) return 'atm';
  if (P2P_LINE.test(toLineId ?? '') || P2P_NOTE.test(transaction.note ?? '')) return 'p2p';
  return 'own-transfer';
};

/** Where an expense or income got its category when no rule speaks for it. */
const findUnruledVerdict = (transaction: ExplainedTransaction): ClassificationVerdict => {
  if (transaction.type === 'income' && CANCELLATION_PREFIX.test(transaction.note ?? '')) return 'cancellation';
  if (transaction.source === 'zenmoney') return 'imported';
  if (transaction.source === 'claude' || transaction.source === 'page') return 'manual';
  return transaction.category === FALLBACK_CATEGORY ? 'fallback' : 'manual';
};

/**
 * Why a row is booked the way it is, and how analytics count it. The rule that matches it
 * today is reported even when the owner booked it differently, so a stale rule shows up.
 */
export const explainClassification = <TRule extends MatchableRule>({
  transaction,
  rules,
  policies,
  mcc,
  texts,
  toLineId,
}: {
  transaction: ExplainedTransaction;
  rules: readonly TRule[];
  policies: CategoryPolicies;
  mcc: number | null;
  /** Every text the bank gave plus the note. */
  texts: readonly (string | null)[];
  /** Provider line of the incoming leg, which tells a P2P order apart. */
  toLineId: string | null;
}): Omit<Classification, 'rule'> & { rule: TRule | null } => {
  const effect = classifyTransaction(transaction, policies);
  if (transaction.type === 'valuation') return { verdict: 'valuation', rule: null, overridden: false, effect };

  const rule = findMatchingRule(rules, { accountId: transaction.accountId, mcc, texts });
  const overridden = rule !== undefined && !isBookedByRule(transaction, rule);
  const verdict =
    transaction.type === 'transfer'
      ? findTransferVerdict({ transaction, rule, mcc, toLineId })
      : rule?.category != null
        ? 'rule'
        : findUnruledVerdict(transaction);
  return { verdict, rule: rule ?? null, overridden, effect };
};

const toCents = (amount: number) => Math.round(amount * 100);
/** Mono turns a card purchase into instalments by refunding it as "Розстрочка на картку". */
const INSTALMENT_CONVERSION = /розстрочка на картку/iu;
const INSTALMENT_WINDOW_DAYS = 3;

export type ChainTransaction = LedgerTransaction & Pick<Transaction, 'id'>;

/**
 * Rows that are one money move in the owner's eyes: a card hold and the cancellations that
 * release it, a purchase Mono turned into instalments and its "Розстрочка на картку" refund,
 * or a ФОП currency sale that passes through the hryvnia account on its way to a card. Each
 * member maps to the id of the chain's first row.
 */
export const linkChains = ({
  transactions,
  passThroughIds,
}: {
  transactions: readonly ChainTransaction[];
  passThroughIds: ReadonlySet<string>;
}): Map<string, string> => {
  const chains = new Map<string, string>();
  const join = (anchor: ChainTransaction, member: ChainTransaction) => {
    const root = chains.get(anchor.id) ?? anchor.id;
    chains.set(anchor.id, root);
    chains.set(member.id, root);
  };

  const holds = Map.groupBy(
    transactions.filter((transaction) => transaction.type === 'expense' && transaction.note !== null),
    (transaction) => `${transaction.accountId}|${transaction.note}`,
  );
  for (const cancellation of transactions) {
    if (cancellation.type !== 'income' || !CANCELLATION_PREFIX.test(cancellation.note ?? '')) continue;
    const merchant = (cancellation.note ?? '').replace(CANCELLATION_PREFIX, '').trim();
    const hold = (holds.get(`${cancellation.accountId}|${merchant}`) ?? [])
      .filter((candidate) => {
        const days = countDaysBetween(candidate.date, cancellation.date);
        return days >= 0 && days <= CANCELLATION_WINDOW_DAYS;
      })
      .at(-1);
    if (hold !== undefined) join(hold, cancellation);
  }

  const purchases = Map.groupBy(
    transactions.filter((transaction) => transaction.type === 'expense'),
    (transaction) => `${transaction.accountId}|${toCents(transaction.amount)}`,
  );
  for (const conversion of transactions) {
    if (conversion.type !== 'income' || !INSTALMENT_CONVERSION.test(conversion.bankText ?? conversion.note ?? '')) continue;
    const purchase = (purchases.get(`${conversion.accountId}|${toCents(conversion.amount)}`) ?? []).find(
      (candidate) =>
        !chains.has(candidate.id) && Math.abs(countDaysBetween(candidate.date, conversion.date)) <= INSTALMENT_WINDOW_DAYS,
    );
    if (purchase !== undefined) join(purchase, conversion);
  }

  const outgoing = Map.groupBy(
    transactions.filter((transaction) => transaction.type === 'transfer' && passThroughIds.has(transaction.accountId)),
    (transaction) => `${transaction.accountId}|${toCents(transaction.amount)}`,
  );
  const used = new Set<string>();
  for (const inbound of transactions) {
    if (inbound.type !== 'transfer' || inbound.toAccountId === null || !passThroughIds.has(inbound.toAccountId)) continue;
    const credited = inbound.toAmount ?? inbound.amount;
    const onward = (outgoing.get(`${inbound.toAccountId}|${toCents(credited)}`) ?? []).find(
      (candidate) => !used.has(candidate.id) && Math.abs(countDaysBetween(inbound.date, candidate.date)) <= CHAIN_WINDOW_DAYS,
    );
    if (onward === undefined) continue;
    used.add(onward.id);
    join(inbound, onward);
  }
  return chains;
};
