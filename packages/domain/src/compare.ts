import type { IsoDate, Month, MonthComparison, MonthStats, Recurring } from '@hroshi/schema';

import { FALLBACK_CATEGORY } from './classify.ts';
import { countDaysInMonth, shiftMonth } from './months.ts';

/** How many earlier months the "usual" level of a month is taken from. */
export const COMPARISON_MONTHS = 6;

const toTotals = (stats: MonthStats) => ({
  incomeEur: stats.incomeEur,
  spendEur: stats.spendEur,
  refundEur: stats.refundEur,
  categories: stats.categories,
});

const findExclusion = (stats: MonthStats): MonthComparison['averageMonths'][number]['reason'] => {
  if (stats.partial) return 'partial';
  if (stats.sparse) return 'sparse';
  return stats.noIncome ? 'noIncome' : 'used';
};

const averageTotals = (months: readonly MonthStats[]) => {
  const divide = (value: number) => (months.length === 0 ? 0 : value / months.length);
  const categories: Record<string, number> = {};
  for (const stats of months) {
    for (const [category, eur] of Object.entries(stats.categories)) categories[category] = (categories[category] ?? 0) + eur;
  }
  return {
    incomeEur: divide(months.reduce((sum, stats) => sum + stats.incomeEur, 0)),
    spendEur: divide(months.reduce((sum, stats) => sum + stats.spendEur, 0)),
    refundEur: divide(months.reduce((sum, stats) => sum + stats.refundEur, 0)),
    categories: Object.fromEntries(Object.entries(categories).map(([category, eur]) => [category, divide(eur)])),
  };
};

const sumByCategory = (payments: readonly { category: string; eur: number }[]): Record<string, number> => {
  const totals: Record<string, number> = {};
  for (const payment of payments) totals[payment.category] = (totals[payment.category] ?? 0) + payment.eur;
  return totals;
};

/**
 * The month's pace shared out by each category's everyday spending (recorded minus the monthly
 * payments already paid in it), so per-category forecasts sum to the month's forecast exactly.
 */
const splitPace = ({
  paceEur,
  categories,
  paidByCategory,
}: {
  paceEur: number;
  categories: Readonly<Record<string, number>>;
  paidByCategory: Readonly<Record<string, number>>;
}): Record<string, number> => {
  const weights = Object.entries(categories)
    .map(([category, eur]): [string, number] => [category, Math.max(0, eur - (paidByCategory[category] ?? 0))])
    .filter(([, weight]) => weight > 0);
  const total = weights.reduce((sum, [, weight]) => sum + weight, 0);
  if (paceEur === 0) return {};
  if (total === 0) return { [FALLBACK_CATEGORY]: paceEur };
  return Object.fromEntries(weights.map(([category, weight]) => [category, (paceEur * weight) / total]));
};

/**
 * Where a running month is heading: what is spent, the monthly payments still to come (rent
 * in cash, utilities), and everyday spending carried on at its pace so far.
 */
export const projectMonth = ({
  month,
  current,
  recurring,
  daysElapsed,
  daysInMonth,
}: {
  month: Month;
  current: Pick<MonthStats, 'spendEur' | 'incomeEur' | 'categories'>;
  recurring: Recurring | null;
  daysElapsed: number;
  daysInMonth: number;
}): MonthComparison['projection'] => {
  if (recurring === null || daysElapsed <= 0 || daysElapsed >= daysInMonth) return null;
  const start = `${month}-01`;
  const end = `${shiftMonth(month, 1)}-01`;
  const payments = recurring.payments.filter((payment) => !payment.late);
  const expected = payments.filter((payment) => payment.lastDate < start && payment.nextDate < end);
  const paidPayments = payments.filter((payment) => payment.lastDate >= start);
  const paid = paidPayments.reduce((sum, payment) => sum + payment.eur, 0);
  const expectedEur = expected.reduce((sum, payment) => sum + payment.eur, 0);
  const expectedByCategory = sumByCategory(expected);
  const everyday = Math.max(0, current.spendEur - paid);
  const paceEur = (everyday / daysElapsed) * (daysInMonth - daysElapsed);
  const paceByCategory = splitPace({ paceEur, categories: current.categories, paidByCategory: sumByCategory(paidPayments) });
  const spendEur = current.spendEur + expectedEur + paceEur;
  return { spendEur, expected, expectedEur, expectedByCategory, paceEur, paceByCategory, savedEur: current.incomeEur - spendEur };
};

/**
 * A month against its usual level (the complete months just before it) and against the same
 * month a year earlier. `stats` must hold the month, the months before it and last year's.
 */
export const compareMonth = ({
  month,
  stats,
  today,
  recurring = null,
}: {
  month: Month;
  stats: readonly MonthStats[];
  today: IsoDate;
  /** Monthly payments, to project a running month. */
  recurring?: Recurring | null;
}): MonthComparison => {
  const byMonth = new Map(stats.map((entry) => [entry.month, entry]));
  const current = byMonth.get(month);
  const previous = Array.from({ length: COMPARISON_MONTHS }, (_, index) => byMonth.get(shiftMonth(month, index - COMPARISON_MONTHS)))
    .filter((entry) => entry !== undefined);
  const averageMonths = previous.map((entry) => ({ month: entry.month, reason: findExclusion(entry) }));
  const lastYear = byMonth.get(shiftMonth(month, -12));
  const daysInMonth = countDaysInMonth(month);
  const todayMonth = today.slice(0, 7);
  const daysElapsed = month < todayMonth ? daysInMonth : month === todayMonth ? Number(today.slice(8, 10)) : 0;

  const currentTotals = current === undefined ? { incomeEur: 0, spendEur: 0, refundEur: 0, categories: {} } : toTotals(current);
  return {
    month,
    current: currentTotals,
    average: averageTotals(previous.filter((entry) => findExclusion(entry) === 'used')),
    averageMonths: averageMonths.map((entry) => ({ ...entry, used: entry.reason === 'used' })),
    lastYear: lastYear === undefined ? null : toTotals(lastYear),
    lastYearSparse: lastYear === undefined || lastYear.sparse || lastYear.noIncome,
    daysElapsed,
    daysInMonth,
    projection: projectMonth({ month, current: currentTotals, recurring, daysElapsed, daysInMonth }),
  };
};
