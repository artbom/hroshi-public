import {
  applyPayeeAliases,
  type CategoryPolicies,
  convertToEur,
  createFxConverter,
  type FxConverter,
  indexCategoryPolicies,
  linkChains,
} from '@hroshi/domain';
import type { Account, Category, Transaction, TransactionRow } from '@hroshi/schema';

import type { Db } from './db.ts';
import { mapAccount, mapCategory, mapTransaction, toIsoDate, toNumber } from './mappers.ts';

export type Ledger = {
  accounts: Account[];
  /** What balances and analytics count: a split row is replaced by its parts. */
  transactions: Transaction[];
  /** Split rows, kept for their bank line and for the drawer; their parts stand in for them. */
  splitParents: Transaction[];
  categories: Category[];
  policies: CategoryPolicies;
  fx: FxConverter;
  /** Row id → id of the money move it belongs to (hold and cancellations, ФОП sale legs). */
  chains: ReadonlyMap<string, string>;
};

/**
 * A part has no bank line of its own, so it reads its parent's: the payee and MCC for analytics,
 * and its share of the euros the card was charged, so the parts add up to exactly the parent's EUR.
 */
const inheritBankFacts = (transaction: Transaction, parents: readonly Transaction[]): Transaction => {
  const parent = transaction.splitOfId === null ? undefined : parents.find((candidate) => candidate.id === transaction.splitOfId);
  if (parent === undefined) return transaction;
  return {
    ...transaction,
    bankText: parent.bankText,
    mcc: parent.mcc,
    operationEur: parent.operationEur === null ? null : (parent.operationEur * transaction.amount) / parent.amount,
  };
};

/** Everything analytics needs, loaded in one go: a single user's whole ledger is small. */
export const loadLedger = async (db: Db): Promise<Ledger> => {
  const [accounts, transactions, categories, daily, yearly, aliases] = await Promise.all([
    db.account.findMany({ orderBy: [{ order: 'asc' }, { name: 'asc' }] }),
    db.transaction.findMany({ orderBy: [{ date: 'asc' }, { createdAt: 'asc' }] }),
    db.category.findMany({ orderBy: { order: 'asc' } }),
    db.fxRate.findMany(),
    db.yearlyRate.findMany(),
    db.payeeAlias.findMany({ where: { name: { not: null } } }),
  ]);
  const mappedCategories = categories.map(mapCategory);
  const mappedAccounts = accounts.map(mapAccount);
  const mapped = transactions.map(mapTransaction);
  const splitIds = new Set(mapped.flatMap((transaction) => (transaction.splitOfId === null ? [] : [transaction.splitOfId])));
  const splitParents = mapped.filter((transaction) => splitIds.has(transaction.id));
  const mappedTransactions = applyPayeeAliases({
    transactions: mapped.filter((transaction) => !splitIds.has(transaction.id)).map((transaction) => inheritBankFacts(transaction, splitParents)),
    names: new Map(aliases.flatMap((alias) => (alias.name === null ? [] : [[alias.key, alias.name]]))),
  });
  const chains = new Map(
    linkChains({
      transactions: mappedTransactions,
      passThroughIds: new Set(mappedAccounts.filter((account) => account.passThrough).map((account) => account.id)),
    }),
  );
  // The parts of one bank line read as one money move, like a hold and its release.
  for (const part of mappedTransactions) {
    if (part.splitOfId !== null && !chains.has(part.id)) chains.set(part.id, part.splitOfId);
  }

  return {
    accounts: mappedAccounts,
    transactions: mappedTransactions,
    splitParents,
    categories: mappedCategories,
    policies: indexCategoryPolicies(mappedCategories),
    fx: createFxConverter({
      daily: daily.map((rate) => ({
        date: toIsoDate(rate.date),
        currency: rate.currency,
        perEur: toNumber(rate.perEur),
        source: rate.source,
      })),
      yearly: yearly.map((rate) => ({ year: rate.year, currency: rate.currency, perEur: toNumber(rate.perEur) })),
    }),
    chains,
  };
};

/** A row as lists show it: its EUR value at the day's rate and the money move it belongs to. */
export const toTransactionRow = (ledger: Pick<Ledger, 'fx' | 'chains'>, transaction: Transaction): TransactionRow => ({
  ...transaction,
  eur: convertToEur({ transaction, fx: ledger.fx }),
  chainId: ledger.chains.get(transaction.id) ?? null,
});
