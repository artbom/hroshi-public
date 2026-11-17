import type { SpendingEffect } from '@hroshi/schema';

import type { CategoryPolicy, LedgerTransaction } from './types.ts';

/** Income without a category is usually an own transfer; expense without one is still spending. */
export const FALLBACK_CATEGORY = 'Інше';

const NO_EFFECT: SpendingEffect = { kind: 'none' };

export type CategoryPolicies = ReadonlyMap<CategoryPolicy['name'], CategoryPolicy>;

export const indexCategoryPolicies = (categories: readonly CategoryPolicy[]): CategoryPolicies =>
  new Map(categories.map((category) => [category.name, category]));

/** Transfers and valuations never count. Unknown categories behave like ordinary expense categories. */
export const classifyTransaction = (
  transaction: Pick<LedgerTransaction, 'type' | 'category'>,
  policies: CategoryPolicies,
): SpendingEffect => {
  const category = transaction.category ?? FALLBACK_CATEGORY;
  const policy = policies.get(category);

  if (transaction.type === 'expense') {
    return policy?.countsAsSpending === false ? NO_EFFECT : { kind: 'spend', category, sign: 1 };
  }
  if (transaction.type !== 'income') return NO_EFFECT;

  switch (policy?.incomeRole ?? 'netting') {
    case 'earning':
      return { kind: 'income' };
    case 'refund':
      return { kind: 'refund' };
    case 'ignored':
      return NO_EFFECT;
    case 'netting':
      return { kind: 'spend', category, sign: -1 };
  }
};
