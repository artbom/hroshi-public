import { ESTIMATE_MARKER, type Month, type MonthQuality, type Transaction } from '@hroshi/schema';

import { aggregateMonths } from './aggregate.ts';
import type { CategoryPolicies } from './classify.ts';
import type { FxConverter } from './fx.ts';
import { toMonth } from './months.ts';
import type { LedgerTransaction } from './types.ts';

export type QualityTransaction = LedgerTransaction & Pick<Transaction, 'source' | 'synced' | 'needsReview'>;

type Origin = 'bank' | 'estimated' | 'zenmoney' | 'hand';

/** A bank line makes a row exact whoever typed it first; otherwise the estimate, the import, the hand. */
export const findOrigin = (transaction: Pick<QualityTransaction, 'synced' | 'note' | 'source'>): Origin => {
  if (transaction.synced) return 'bank';
  if (transaction.note?.includes(ESTIMATE_MARKER) === true) return 'estimated';
  return transaction.source === 'zenmoney' ? 'zenmoney' : 'hand';
};

const findStatus = (stats: { rows: number; partial: boolean; sparse: boolean; noIncome: boolean }): MonthQuality['status'] => {
  if (stats.rows === 0) return 'missing';
  if (stats.partial) return 'partial';
  return stats.sparse || stats.noIncome ? 'sparse' : 'complete';
};

/** Where each month's rows came from, and whether the month can be trusted in averages. */
export const assessDataQuality = ({
  months,
  transactions,
  policies,
  fx,
  currentMonth,
}: {
  months: readonly Month[];
  transactions: readonly QualityTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
  currentMonth: Month;
}): MonthQuality[] => {
  const counts = new Map(
    months.map((month) => [month, { bank: 0, estimated: 0, zenmoney: 0, hand: 0, review: 0 }]),
  );
  for (const transaction of transactions) {
    const count = counts.get(toMonth(transaction.date));
    if (count === undefined) continue;
    count[findOrigin(transaction)] += 1;
    if (transaction.needsReview) count.review += 1;
  }

  return aggregateMonths({ months, transactions, policies, fx, currentMonth }).map((stats) => {
    const count = counts.get(stats.month) ?? { bank: 0, estimated: 0, zenmoney: 0, hand: 0, review: 0 };
    return {
      month: stats.month,
      rows: stats.rows,
      ...count,
      hasIncome: !stats.noIncome,
      sparse: stats.sparse,
      partial: stats.partial,
      status: findStatus(stats),
    };
  });
};
