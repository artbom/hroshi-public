import type { AccountBalance, IsoDate, Loan, TransactionRow } from '@hroshi/schema';

import { findToday } from '../months.ts';

const DAY_MS = 86_400_000;

const countDaysBetween = (from: IsoDate, to: IsoDate) =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / DAY_MS);

/** Days past the due date while money is still out; zero before it or once settled. */
export const findDue = (account: Pick<AccountBalance, 'dueDate' | 'balance'>): { overdueDays: number } | null => {
  if (account.dueDate === null) return null;
  const late = countDaysBetween(account.dueDate, findToday());
  return { overdueDays: account.balance !== 0 && late > 0 ? late : 0 };
};

/**
 * A repayment shrinks what is owed: money coming back out of a loan someone owes me, or money
 * paid into a debt I owe.
 */
export const isRepayment = ({ row, account }: { row: TransactionRow; account: AccountBalance }) =>
  row.type === 'transfer' && (account.balance >= 0 ? row.accountId === account.id : row.toAccountId === account.id);

export const findLastRepayment = (loan: Loan): TransactionRow | undefined =>
  loan.rows.find((row) => isRepayment({ row, account: loan.account }));
