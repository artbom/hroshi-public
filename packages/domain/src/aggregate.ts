import type { Currency, IsoDate, Month, MonthOverview, MonthStats, SpendingEffect, Trends } from '@hroshi/schema';

import { roundAmount } from './balances.ts';
import { type CategoryPolicies, classifyTransaction } from './classify.ts';
import { convertToEur, type FxConverter } from './fx.ts';
import { findBankText } from './merchants.ts';
import { countDaysBetween, listMonthsBack, shiftDate, shiftMonth, toMonth } from './months.ts';
import type { LedgerTransaction } from './types.ts';

/** Months with fewer rows were barely tracked and would distort averages. */
export const SPARSE_MONTH_ROWS = 60;

const GENERIC_REFUND_LABEL = 'Повернення';

const addTo = (record: Record<string, number>, key: string, value: number) => {
  record[key] = (record[key] ?? 0) + value;
};

const TAX_CATEGORY = 'Податки і збори';
/** The single tax and the social contribution go to the treasury («УК у …», «ГУК у …») or the tax office (ДПС). */
const QUARTERLY_TAX_PAYEE = /^(?:г?ук у(?:\s|$)|головне управління дпс)/iu;
/** A ФОП pays the quarter's tax within 50 days after it ends; anything later is an advance for the current one. */
const TAX_SETTLEMENT_DAYS = 50;
const QUARTER_MONTHS = 3;

export const isQuarterlyTax = (transaction: Pick<LedgerTransaction, 'type' | 'category' | 'note' | 'bankText'>): boolean =>
  transaction.type === 'expense' && transaction.category === TAX_CATEGORY && QUARTERLY_TAX_PAYEE.test(findBankText(transaction)?.trim() ?? '');

/** The three months a tax payment is for: the quarter just ended while it is still being settled, else its own. */
export const findTaxQuarter = (date: IsoDate): Month[] => {
  const month = toMonth(date);
  const quarterStart = shiftMonth(month, -((Number(month.slice(5, 7)) - 1) % QUARTER_MONTHS));
  const settling = countDaysBetween(shiftDate(`${quarterStart}-01`, -1), date) <= TAX_SETTLEMENT_DAYS;
  const start = settling ? shiftMonth(quarterStart, -QUARTER_MONTHS) : quarterStart;
  return Array.from({ length: QUARTER_MONTHS }, (_, index) => shiftMonth(start, index));
};

const createEmptyStats = (month: Month): MonthStats => ({
  month,
  incomeEur: 0,
  spendEur: 0,
  refundEur: 0,
  rows: 0,
  sparse: false,
  noIncome: false,
  partial: false,
  categories: {},
});

const applyEffect = ({ stats, effect, eur }: { stats: MonthStats; effect: SpendingEffect; eur: number }) => {
  switch (effect.kind) {
    case 'spend':
      addTo(stats.categories, effect.category, effect.sign * eur);
      stats.spendEur += effect.sign * eur;
      break;
    case 'income':
      stats.incomeEur += eur;
      break;
    case 'refund':
      stats.spendEur -= eur;
      stats.refundEur += eur;
      break;
    case 'none':
      break;
  }
};

export const aggregateMonths = ({
  months,
  transactions,
  policies,
  fx,
  currentMonth,
  spreadQuarterlyTax = false,
}: {
  months: readonly Month[];
  transactions: readonly LedgerTransaction[];
  policies: CategoryPolicies;
  fx: FxConverter;
  currentMonth: Month;
  /** Book each quarterly ФОП tax payment as a third in each month of the quarter it pays for. */
  spreadQuarterlyTax?: boolean;
}): MonthStats[] => {
  const byMonth = new Map(months.map((month) => [month, createEmptyStats(month)]));

  for (const transaction of transactions) {
    const own = byMonth.get(toMonth(transaction.date));
    if (own !== undefined) own.rows += 1;
    const spread = spreadQuarterlyTax && isQuarterlyTax(transaction);
    const targets = (spread ? findTaxQuarter(transaction.date).map((month) => byMonth.get(month)) : [own]).filter(
      (stats) => stats !== undefined,
    );
    if (targets.length === 0) continue;
    const eur = convertToEur({ transaction, fx });
    if (eur === null) continue;
    const effect = classifyTransaction(transaction, policies);
    const share = spread ? eur / QUARTER_MONTHS : eur;
    for (const stats of targets) applyEffect({ stats, effect, eur: share });
  }

  return [...byMonth.values()].map((stats) => ({
    ...stats,
    sparse: stats.rows < SPARSE_MONTH_ROWS,
    noIncome: stats.incomeEur <= 0,
    partial: stats.month >= currentMonth,
  }));
};

/** Averages only over months that are finished and have both income and enough rows. */
export const summarizeTrends = (months: MonthStats[]): Trends => {
  const complete = months.filter((stats) => !stats.sparse && !stats.noIncome && !stats.partial);
  const average = (pick: (stats: MonthStats) => number) =>
    complete.length === 0 ? 0 : complete.reduce((sum, stats) => sum + pick(stats), 0) / complete.length;
  const incomeEur = average((stats) => stats.incomeEur);
  const spendEur = average((stats) => stats.spendEur);

  return {
    months,
    averages: {
      incomeEur,
      spendEur,
      savedEur: incomeEur - spendEur,
      savingsRate: incomeEur > 0 ? (incomeEur - spendEur) / incomeEur : null,
      completeMonths: complete.length,
      totalMonths: months.length,
    },
  };
};

const sortCategories = (record: Record<string, number>) =>
  Object.entries(record)
    .map(([category, amount]) => ({ category, amount: roundAmount(amount) }))
    .filter(({ amount }) => amount !== 0)
    .toSorted((left, right) => right.amount - left.amount);

/** Month spending in original currencies, so the owner sees what the cards actually moved. */
export const summarizeMonthByCurrency = ({
  month,
  transactions,
  policies,
}: {
  month: Month;
  transactions: readonly LedgerTransaction[];
  policies: CategoryPolicies;
}): MonthOverview['byCurrency'] => {
  const byCurrency = new Map<Currency, { spent: number; income: number; categories: Record<string, number> }>();

  for (const transaction of transactions) {
    if (toMonth(transaction.date) !== month) continue;
    const effect = classifyTransaction(transaction, policies);
    if (effect.kind === 'none') continue;
    const bucket = byCurrency.get(transaction.currency) ?? { spent: 0, income: 0, categories: {} };
    byCurrency.set(transaction.currency, bucket);
    switch (effect.kind) {
      case 'spend':
        addTo(bucket.categories, effect.category, effect.sign * transaction.amount);
        bucket.spent += effect.sign * transaction.amount;
        break;
      case 'income':
        bucket.income += transaction.amount;
        break;
      case 'refund':
        addTo(bucket.categories, GENERIC_REFUND_LABEL, -transaction.amount);
        bucket.spent -= transaction.amount;
        break;
    }
  }

  return [...byCurrency]
    .map(([currency, bucket]) => ({
      currency,
      spent: roundAmount(bucket.spent),
      income: roundAmount(bucket.income),
      categories: sortCategories(bucket.categories),
    }))
    .toSorted((left, right) => right.categories.length - left.categories.length);
};

export const summarizeLimits = ({
  stats,
  limits,
}: {
  stats: MonthStats;
  limits: ReadonlyMap<string, number>;
}): MonthOverview['limits'] =>
  [...limits].map(([category, limitEur]) => ({
    category,
    limitEur,
    spentEur: Math.max(0, stats.categories[category] ?? 0),
  }));

export const summarizeSpendTrend = ({
  until,
  transactions,
  policies,
}: {
  until: Month;
  transactions: readonly LedgerTransaction[];
  policies: CategoryPolicies;
}): MonthOverview['spendTrend'] => {
  const months = listMonthsBack({ until, count: 12 });
  const first = months[0] ?? until;
  const totals = new Map<Currency, Map<Month, number>>();

  for (const transaction of transactions) {
    const month = toMonth(transaction.date);
    if (month < first || month > until) continue;
    const effect = classifyTransaction(transaction, policies);
    if (effect.kind !== 'spend') continue;
    const perMonth = totals.get(transaction.currency) ?? new Map<Month, number>();
    totals.set(transaction.currency, perMonth);
    perMonth.set(month, (perMonth.get(month) ?? 0) + effect.sign * transaction.amount);
  }

  return [...totals]
    .toSorted(([, left], [, right]) => right.size - left.size)
    .map(([currency, perMonth]) => ({
      currency,
      months: months.map((month) => ({ month, amount: roundAmount(Math.max(0, perMonth.get(month) ?? 0)) })),
    }));
};
