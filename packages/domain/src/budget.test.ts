import type { MonthStats } from '@hroshi/schema';
import { describe, expect, it } from 'vitest';

import { indexCategoryLimits, summarizeBudget } from './budget.ts';

const createStats = (overrides: Partial<MonthStats> & Pick<MonthStats, 'month'>): MonthStats => ({
  incomeEur: 8000,
  spendEur: 0,
  refundEur: 0,
  rows: 150,
  sparse: false,
  noIncome: false,
  partial: false,
  categories: {},
  ...overrides,
});

const goal = { amount: 3000, currency: 'USD' } as const;
const limits = indexCategoryLimits([
  { name: 'Продукти', monthlyLimitEur: 400 },
  { name: 'Кафе і ресторани', monthlyLimitEur: 500 },
  { name: 'Житло', monthlyLimitEur: null },
]);

const history = [
  createStats({ month: '2026-08', incomeEur: 8200 }),
  createStats({ month: '2026-09', incomeEur: 7900 }),
  createStats({ month: '2026-10', incomeEur: 8500 }),
];

describe('summarizeBudget', () => {
  it('budgets the usual income of the three months before, less the goal', () => {
    const budget = summarizeBudget({
      asOf: '2026-11-13',
      goal,
      goalEur: 2600,
      stats: [...history, createStats({ month: '2026-11', incomeEur: 2100, spendEur: 900, partial: true })],
      limits,
      projection: null,
      lastDaySpentEur: 35,
    });

    expect(budget.usualIncomeEur).toBe(8200);
    expect(budget.total).toEqual({ limitEur: 5600, spentEur: 900, projectedEur: null });
    expect(budget).toMatchObject({ month: '2026-11', daysElapsed: 13, daysInMonth: 30, incomeEur: 2100, lastDaySpentEur: 35 });
  });

  it('leaves out months too thin or without a salary to trust', () => {
    const budget = summarizeBudget({
      asOf: '2026-11-13',
      goal,
      goalEur: 2600,
      stats: [
        createStats({ month: '2026-08', incomeEur: 8200 }),
        createStats({ month: '2026-09', incomeEur: 0, noIncome: true }),
        createStats({ month: '2026-10', incomeEur: 1000, rows: 10, sparse: true }),
        createStats({ month: '2026-11' }),
      ],
      limits,
      projection: null,
      lastDaySpentEur: 0,
    });

    expect(budget.usualIncomeEur).toBe(8200);
  });

  it("falls back to the month's own income when no month before it counts", () => {
    const budget = summarizeBudget({
      asOf: '2026-11-13',
      goal,
      goalEur: 2600,
      stats: [createStats({ month: '2026-11', incomeEur: 9000 })],
      limits,
      projection: null,
      lastDaySpentEur: 0,
    });

    expect(budget.total.limitEur).toBe(6400);
  });

  it('gives the rest of the budget and of the spending to the categories without an orientir', () => {
    const budget = summarizeBudget({
      asOf: '2026-11-13',
      goal,
      goalEur: 2600,
      stats: [
        ...history,
        // A refund with no category of its own lowers the total, so it lowers the rest too.
        createStats({ month: '2026-11', spendEur: 1650, categories: { Продукти: 180, 'Кафе і ресторани': 470, Житло: 1100 } }),
      ],
      limits,
      projection: null,
      lastDaySpentEur: 0,
    });

    expect(budget.rest).toEqual({ limitEur: 5600 - 900, spentEur: 1000, projectedEur: null });
    expect(budget.categories.map(({ category, spentEur }) => [category, spentEur])).toEqual([
      ['Кафе і ресторани', 470],
      ['Продукти', 180],
    ]);
  });

  it('projects each line with the payments still due and the pace, and puts the most stretched first', () => {
    const budget = summarizeBudget({
      asOf: '2026-11-13',
      goal,
      goalEur: 2600,
      stats: [...history, createStats({ month: '2026-11', spendEur: 1750, categories: { Продукти: 300, 'Кафе і ресторани': 250, Житло: 1200 } })],
      limits,
      projection: {
        spendEur: 4000,
        expectedByCategory: { Житло: 1200 },
        paceByCategory: { Продукти: 400, 'Кафе і ресторани': 300, Житло: 350 },
      },
      lastDaySpentEur: 0,
    });

    expect(budget.categories).toEqual([
      { category: 'Продукти', limitEur: 400, spentEur: 300, projectedEur: 700 },
      { category: 'Кафе і ресторани', limitEur: 500, spentEur: 250, projectedEur: 550 },
    ]);
    expect(budget.rest.projectedEur).toBe(4000 - 1250);
    expect(budget.total.projectedEur).toBe(4000);
  });

  it('never budgets below zero when the goal outgrows the income', () => {
    const budget = summarizeBudget({
      asOf: '2026-11-13',
      goal: { amount: 10_000, currency: 'EUR' },
      goalEur: 10_000,
      stats: history,
      limits,
      projection: null,
      lastDaySpentEur: 0,
    });

    expect(budget.total.limitEur).toBe(0);
    expect(budget.rest.limitEur).toBe(0);
  });
});
