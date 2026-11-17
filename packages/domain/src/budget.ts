import type { Category, IsoDate, MonthBudget, MonthComparison, MonthStats, SavingsGoal } from '@hroshi/schema';

import { countDaysInMonth, shiftMonth, toMonth } from './months.ts';

/** Salaries land on different days each month; three months even that out without lagging a raise for long. */
export const BUDGET_INCOME_MONTHS = 3;

/** Orientirs by category, in euros a month. */
export const indexCategoryLimits = (categories: readonly Pick<Category, 'name' | 'monthlyLimitEur'>[]): Map<string, number> =>
  new Map(categories.flatMap((category) => (category.monthlyLimitEur === null ? [] : [[category.name, category.monthlyLimitEur] as const])));

type Projection = Pick<NonNullable<MonthComparison['projection']>, 'spendEur' | 'expectedByCategory' | 'paceByCategory'>;

const sum = (values: readonly number[]) => values.reduce((total, value) => total + value, 0);

/** The month's own complete predecessors: a month with too few rows or no salary would drag the average down. */
const listEarnedIncome = ({ byMonth, month }: { byMonth: ReadonlyMap<string, MonthStats>; month: string }) =>
  Array.from({ length: BUDGET_INCOME_MONTHS }, (_, index) => byMonth.get(shiftMonth(month, -1 - index)))
    .filter((stats): stats is MonthStats => stats !== undefined && !stats.sparse && !stats.noIncome)
    .map((stats) => stats.incomeEur);

/**
 * The month so far against a budget of the usual income minus the savings goal: each orientir
 * category against its own limit, the rest of the spending against what the budget leaves after them.
 */
export const summarizeBudget = ({
  asOf,
  goal,
  goalEur,
  stats,
  limits,
  projection,
  lastDaySpentEur,
}: {
  asOf: IsoDate;
  goal: SavingsGoal;
  goalEur: number;
  /** The month of `asOf` and the months before it, counted up to `asOf`. */
  stats: readonly MonthStats[];
  limits: ReadonlyMap<string, number>;
  /** Where the running month is heading; null once it is over. */
  projection: Projection | null;
  lastDaySpentEur: number;
}): MonthBudget => {
  const month = toMonth(asOf);
  const byMonth = new Map(stats.map((entry) => [entry.month, entry]));
  const current = byMonth.get(month);
  const spentBy = current?.categories ?? {};
  const spendEur = current?.spendEur ?? 0;
  const incomeEur = current?.incomeEur ?? 0;
  const earned = listEarnedIncome({ byMonth, month });
  // A ledger without a full month behind it has only this month's income to go on.
  const usualIncomeEur = earned.length === 0 ? incomeEur : sum(earned) / earned.length;
  const budgetEur = Math.max(0, usualIncomeEur - goalEur);

  const project = (category: string) =>
    projection === null
      ? null
      : (spentBy[category] ?? 0) + (projection.expectedByCategory[category] ?? 0) + (projection.paceByCategory[category] ?? 0);
  const limited = [...limits.keys()];
  const projectedLimited = projection === null ? null : sum(limited.map((category) => project(category) ?? 0));
  // Refunds without a category of their own and net-negative categories land in the rest, so the lines add up to the total.
  const restSpent = spendEur - sum(limited.map((category) => spentBy[category] ?? 0));

  return {
    month,
    asOf,
    daysElapsed: Number(asOf.slice(8, 10)),
    daysInMonth: countDaysInMonth(month),
    goal,
    goalEur,
    usualIncomeEur,
    incomeEur,
    lastDaySpentEur,
    total: { limitEur: budgetEur, spentEur: spendEur, projectedEur: projection?.spendEur ?? null },
    categories: [...limits]
      .map(([category, limitEur]) => {
        const projectedEur = project(category);
        return {
          category,
          limitEur,
          spentEur: Math.max(0, spentBy[category] ?? 0),
          projectedEur: projectedEur === null ? null : Math.max(0, projectedEur),
        };
      })
      .toSorted((left, right) => (right.projectedEur ?? right.spentEur) / right.limitEur - (left.projectedEur ?? left.spentEur) / left.limitEur),
    rest: {
      limitEur: Math.max(0, budgetEur - sum([...limits.values()])),
      spentEur: Math.max(0, restSpent),
      projectedEur: projection === null || projectedLimited === null ? null : Math.max(0, projection.spendEur - projectedLimited),
    },
  };
};
