import { convertToEur, findPayeeText, normalizeMerchant, toMonth } from '@hroshi/domain';
import type { IsoDate, Transaction, TransactionPage, TransactionQuery, TransactionRow } from '@hroshi/schema';

import { type Ledger, toTransactionRow } from '../ledger.ts';

const SIGN_BY_TYPE: Readonly<Record<Transaction['type'], number>> = {
  expense: -1,
  income: 1,
  transfer: 0,
  valuation: 0,
};

const matchesQuery = ({
  transaction,
  query,
  accountNames,
  fx,
}: {
  transaction: Transaction;
  query: TransactionQuery;
  accountNames: ReadonlyMap<string, string>;
  fx: Ledger['fx'];
}) => {
  const month = toMonth(transaction.date);
  if (query.type !== undefined && transaction.type !== query.type) return false;
  if (query.category !== undefined && transaction.category !== query.category) return false;
  if (query.accountId !== undefined && transaction.accountId !== query.accountId && transaction.toAccountId !== query.accountId) {
    return false;
  }
  if (query.from !== undefined && month < query.from) return false;
  if (query.to !== undefined && month > query.to) return false;
  if (query.needsReview !== undefined && transaction.needsReview !== query.needsReview) return false;
  if (query.tag !== undefined && !transaction.tags.includes(query.tag)) return false;
  if (query.payee !== undefined && normalizeMerchant(findPayeeText(transaction)).key !== query.payee) return false;
  if (query.source !== undefined && transaction.source !== query.source) return false;
  if (query.minEur !== undefined || query.maxEur !== undefined) {
    const eur = Math.abs(convertToEur({ transaction, fx }) ?? 0);
    if (query.minEur !== undefined && eur < query.minEur) return false;
    if (query.maxEur !== undefined && eur > query.maxEur) return false;
  }
  if (!query.q) return true;

  const haystack = [
    transaction.note,
    transaction.bankText,
    transaction.category,
    accountNames.get(transaction.accountId),
    transaction.toAccountId === null ? null : accountNames.get(transaction.toAccountId),
    ...transaction.tags,
  ]
    .filter(Boolean)
    .join(' ')
    .toLocaleLowerCase('uk');
  return haystack.includes(query.q.toLocaleLowerCase('uk'));
};

/** Filtering in memory keeps search, € sorting and totals consistent with the analytics. */
export const queryTransactions = ({ ledger, query }: { ledger: Ledger; query: TransactionQuery }): TransactionPage => {
  const accountNames = new Map(ledger.accounts.map((account) => [account.id, account.name]));
  const rows: TransactionRow[] = ledger.transactions
    .filter((transaction) => matchesQuery({ transaction, query, accountNames, fx: ledger.fx }))
    .map((transaction) => toTransactionRow(ledger, transaction));

  const direction = query.dir === 'asc' ? 1 : -1;
  rows.sort((left, right) =>
    query.sort === 'eur'
      ? (Math.abs(left.eur ?? 0) - Math.abs(right.eur ?? 0)) * direction
      : (left.date.localeCompare(right.date) || left.createdAt.localeCompare(right.createdAt)) * direction,
  );

  const sumEur = (pick: (row: TransactionRow) => number) => rows.reduce((sum, row) => sum + pick(row), 0);

  return {
    items: rows.slice(query.offset, query.offset + query.limit),
    total: rows.length,
    expenseEur: sumEur((row) => (row.type === 'expense' ? (row.eur ?? 0) : 0)),
    netEur: sumEur((row) => SIGN_BY_TYPE[row.type] * (row.eur ?? 0)),
    bankSince: Object.fromEntries(findBankSince(ledger)),
  };
};

/**
 * Day each bank-synced account's statement starts in the ledger. Cash and loan accounts receive
 * linked transfers too, but no bank ever reports their own spending, so they have no such day.
 */
export const findBankSince = ({ accounts, transactions }: Pick<Ledger, 'accounts' | 'transactions'>): Map<string, IsoDate> => {
  const synced = new Set(accounts.filter((account) => account.syncSource !== null).map((account) => account.id));
  const since = new Map<string, IsoDate>();
  for (const transaction of transactions) {
    if (!transaction.synced) continue;
    for (const accountId of [transaction.accountId, transaction.toAccountId]) {
      if (accountId !== null && synced.has(accountId) && !since.has(accountId)) since.set(accountId, transaction.date);
    }
  }
  return since;
};
