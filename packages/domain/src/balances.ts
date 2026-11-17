import type { LedgerAccount, LedgerTransaction } from './types.ts';

/** Rounds away float noise from summing many decimal amounts; crypto needs more than cents. */
export const roundAmount = (value: number): number => Math.round(value * 1e8) / 1e8;

/** Missing toAmount means the same amount arrived; zero means unknown and moves nothing. */
export const resolveCreditedAmount = (transaction: Pick<LedgerTransaction, 'amount' | 'toAmount'>): number =>
  transaction.toAmount ?? transaction.amount;

export type BalanceEffect = { accountId: string; delta: number };

/** What a row does to each account it touches. */
export const listBalanceEffects = (transaction: LedgerTransaction): BalanceEffect[] => {
  const { accountId } = transaction;
  switch (transaction.type) {
    case 'expense':
      return [{ accountId, delta: -transaction.amount }];
    case 'income':
    case 'valuation':
      return [{ accountId, delta: transaction.amount }];
    case 'transfer':
      return [
        { accountId, delta: -transaction.amount },
        ...(transaction.toAccountId === null
          ? []
          : [{ accountId: transaction.toAccountId, delta: resolveCreditedAmount(transaction) }]),
      ];
  }
};

/**
 * Balance = opening + every row dated on or after the account's opening date.
 * Rows dated earlier are history for analytics and never move a balance, so
 * back-filled statements can be imported without disturbing current balances.
 */
export const computeBalances = ({
  accounts,
  transactions,
}: {
  accounts: readonly LedgerAccount[];
  transactions: readonly LedgerTransaction[];
}): Map<LedgerAccount['id'], number> => {
  const openingDates = new Map(accounts.map((account) => [account.id, account.openingDate]));
  const balances = new Map(accounts.map((account) => [account.id, account.openingBalance]));

  for (const transaction of transactions) {
    for (const { accountId, delta } of listBalanceEffects(transaction)) {
      const openingDate = openingDates.get(accountId);
      if (openingDate === undefined || transaction.date < openingDate) continue;
      balances.set(accountId, (balances.get(accountId) ?? 0) + delta);
    }
  }

  return new Map([...balances].map(([id, balance]) => [id, roundAmount(balance)]));
};
