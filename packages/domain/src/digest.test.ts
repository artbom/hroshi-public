import { describe, expect, it } from 'vitest';

import { indexCategoryPolicies } from './classify.ts';
import { summarizePeriod } from './digest.ts';
import { createFxConverter } from './fx.ts';
import type { LedgerTransaction } from './types.ts';

const policies = indexCategoryPolicies([
  { name: 'Кафе і ресторани', incomeRole: 'netting', countsAsSpending: true },
  { name: 'Зарплата/клієнт', incomeRole: 'earning', countsAsSpending: true },
]);
const fx = createFxConverter({ daily: [], yearly: [] });

const createTransaction = (overrides: Partial<LedgerTransaction>): LedgerTransaction => ({
  type: 'expense',
  date: '2026-11-04',
  accountId: 'card',
  amount: 10,
  currency: 'EUR',
  toAccountId: null,
  toAmount: null,
  toCurrency: null,
  category: 'Кафе і ресторани',
  note: 'Glovo',
  ...overrides,
});

describe('summarizePeriod', () => {
  it('compares the week with a usual week, nets refunds and flags limits near their end', () => {
    const digest = summarizePeriod({
      from: '2026-11-02',
      to: '2026-11-08',
      policies,
      fx,
      limits: new Map([['Кафе і ресторани', 100]]),
      transactions: [
        createTransaction({ amount: 60 }),
        createTransaction({ amount: 40, note: 'Takumi', date: '2026-11-05' }),
        createTransaction({ type: 'income', amount: 10, note: 'Скасування. Glovo', date: '2026-11-06' }),
        createTransaction({ type: 'income', amount: 2000, category: 'Зарплата/клієнт', note: 'Acme' }),
        createTransaction({ amount: 80, date: '2026-10-20' }),
        createTransaction({ type: 'transfer', amount: 500, category: null, toAccountId: 'cash', note: 'ATM' }),
      ],
    });

    expect(digest.spentEur).toBe(90);
    expect(digest.incomeEur).toBe(2000);
    expect(digest.usualSpentEur).toBe(10);
    expect(digest.categories).toEqual([{ category: 'Кафе і ресторани', eur: 90, usualEur: 10 }]);
    expect(digest.merchants[0]).toEqual({ merchant: 'Glovo', eur: 50, count: 1 });
    expect(digest.largest.map((expense) => expense.eur)).toEqual([50, 40]);
    expect(digest.limits).toEqual([{ category: 'Кафе і ресторани', limitEur: 100, spentEur: 90 }]);
  });
});

describe('summarizePeriod with card holds', () => {
  it('nets a hold released after the week ends against the purchase', () => {
    const digest = summarizePeriod({
      from: '2026-11-02',
      to: '2026-11-08',
      policies,
      fx,
      limits: new Map(),
      transactions: [
        createTransaction({ date: '2026-11-08', amount: 1000, note: 'JAPRAC RENT-A-CAR' }),
        createTransaction({ type: 'income', date: '2026-11-10', amount: 985, note: 'Скасування. JAPRAC RENT-A-CAR' }),
        createTransaction({ type: 'income', date: '2026-11-11', amount: 15, note: 'Скасування. JAPRAC RENT-A-CAR' }),
        createTransaction({ amount: 20, note: 'Glovo' }),
      ],
    });
    expect(digest.spentEur).toBe(20);
    expect(digest.largest.map((expense) => expense.merchant)).toEqual(['Glovo']);
  });
});

describe('summarizePeriod for a month', () => {
  it('compares with the average of the months before it', () => {
    const digest = summarizePeriod({
      from: '2026-10-01',
      to: '2026-10-31',
      baselineFrom: '2026-08-01',
      baselinePeriods: 2,
      policies,
      fx,
      limits: new Map(),
      transactions: [
        createTransaction({ date: '2026-10-10', amount: 300 }),
        createTransaction({ date: '2026-08-10', amount: 100 }),
        createTransaction({ date: '2026-09-10', amount: 300 }),
        createTransaction({ date: '2026-07-10', amount: 999 }),
      ],
    });
    expect(digest.spentEur).toBe(300);
    expect(digest.usualSpentEur).toBe(200);
  });
});
