import { indexCategoryLimits, type PeriodDigest, shiftDate, shiftMonth, summarizePeriod } from '@hroshi/domain';
import type { Currency, IsoDate, Month, MonthBudget, RecurringPayment, SyncSourceStatus } from '@hroshi/schema';

import { composeBudget } from '../budget/compose.ts';
import { readSavingsGoal } from '../budget/store.ts';
import type { Db } from '../db.ts';
import { loadLedger } from '../ledger.ts';
import { findPlannedPayments } from '../planned/store.ts';
import { formatWhole } from '../picture.ts';
import type { PeriodKind } from './period.ts';
import { describeSyncStatus } from '../sync/runner.ts';

/** A planned payment past its due day and still not in the ledger on the day the digest goes out. */
export type OverduePayment = { name: string; amount: number; currency: Currency; days: number };

export type WeeklyDigest = {
  kind: PeriodKind;
  digest: PeriodDigest;
  reviewCount: number;
  sync: SyncSourceStatus[];
  overdue: OverduePayment[];
  /** The month's budget up to the period's last day; null until a savings goal is set. */
  budget: MonthBudget | null;
};

/** «Пропущено?» ones (far past due) are probably cancelled; nagging about them would be noise. */
const listOverdue = (payments: readonly RecurringPayment[]): OverduePayment[] =>
  payments
    .filter((payment) => !payment.late && payment.overdueDays > 0)
    .toSorted((left, right) => right.overdueDays - left.overdueDays)
    .map((payment) => ({ name: payment.name, amount: payment.amount, currency: payment.currency, days: payment.overdueDays }));

/** A month is compared with the half-year before it: long enough to absorb trips and quarterly tax. */
const BASELINE_MONTHS = 6;

const findMonthEnd = (month: Month): IsoDate => shiftDate(`${shiftMonth(month, 1)}-01`, -1);

export const composeDigest = async ({
  db,
  kind,
  to,
  today,
}: {
  db: Db;
  kind: PeriodKind;
  to: IsoDate;
  /** The day it goes out: what is overdue is judged on it, not on the period's last day. */
  today: IsoDate;
}): Promise<WeeklyDigest> => {
  const month = to.slice(0, 7);
  const period =
    kind === 'week'
      ? { from: shiftDate(to, -6), to }
      : {
          from: `${month}-01`,
          to: findMonthEnd(month),
          baselineFrom: `${shiftMonth(month, -BASELINE_MONTHS)}-01`,
          baselinePeriods: BASELINE_MONTHS,
        };
  const ledger = await loadLedger(db);
  const [reviewCount, sync, planned, goal] = await Promise.all([
    db.transaction.count({ where: { needsReview: true } }),
    describeSyncStatus(db),
    findPlannedPayments({ db, ledger, today }),
    readSavingsGoal(db),
  ]);
  return {
    kind,
    digest: summarizePeriod({
      ...period,
      transactions: ledger.transactions,
      policies: ledger.policies,
      fx: ledger.fx,
      limits: indexCategoryLimits(ledger.categories),
    }),
    reviewCount,
    sync,
    overdue: listOverdue(planned.payments),
    budget: goal === null ? null : await composeBudget({ db, ledger, goal, asOf: period.to, today }),
  };
};

const formatDay = (date: IsoDate) => new Date(`${date}T12:00:00Z`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });

const CURRENCY_SIGNS: Readonly<Record<Currency, string>> = { UAH: 'грн', EUR: '€', USD: '$', GBP: '£', USDT: 'USDT' };

/** Whole units in the digest's notation: «1 800 €», «11 100 грн». */
export const formatDigestMoney = ({ amount, currency }: { amount: number; currency: Currency }) =>
  `${formatWhole(amount)} ${CURRENCY_SIGNS[currency]}`;

export const formatEur = (value: number) => formatDigestMoney({ amount: value, currency: 'EUR' });

/** Telegram captions are capped, so the picture carries the detail and this the gist. */
const describeMonth = (date: IsoDate) => {
  const month = new Date(`${date}T12:00:00Z`).toLocaleDateString('uk-UA', { month: 'long' });
  return `${month.charAt(0).toUpperCase()}${month.slice(1)} ${date.slice(0, 4)}`;
};

/** A week shows how far into the month's budget it got; the month's close sets it against the whole month. */
const describeBudgetUse = ({ kind, budget }: { kind: PeriodKind; budget: MonthBudget }) =>
  `Бюджет місяця: ${formatEur(budget.total.spentEur)} з ${formatEur(budget.total.limitEur)}` +
  (kind === 'week' ? ` за ${budget.daysElapsed} з ${budget.daysInMonth} днів.` : '.');

export const describeCaption = ({ kind, digest, reviewCount, overdue, budget }: WeeklyDigest): string => {
  const change = digest.usualSpentEur > 0 ? Math.round((digest.spentEur / digest.usualSpentEur - 1) * 100) : null;
  const top = digest.categories[0];
  const saved = digest.incomeEur - digest.spentEur;
  const title = kind === 'week' ? `Тиждень ${formatDay(digest.from)} – ${formatDay(digest.to)}` : describeMonth(digest.from);
  return [
    `${title}: витрачено ${formatEur(digest.spentEur)}` +
      (change === null ? '.' : ` (${change >= 0 ? '+' : ''}${change}% до звичайного ${kind === 'week' ? 'тижня' : 'місяця'}).`),
    kind === 'month' && digest.incomeEur > 0
      ? `Дохід ${formatEur(digest.incomeEur)}, відкладено ${formatEur(saved)} (${Math.round((saved / digest.incomeEur) * 100)}%)` +
        (budget === null ? '.' : ` при цілі ${formatEur(budget.goalEur)}.`)
      : null,
    budget === null ? null : describeBudgetUse({ kind, budget }),
    top === undefined ? null : `Найбільше: ${top.category}, ${formatEur(top.eur)}.`,
    digest.limits.length === 0 ? null : `Орієнтир: ${digest.limits.map((limit) => limit.category).join(', ')}.`,
    overdue.length === 0
      ? null
      : `Прострочено: ${overdue.map((payment) => `${payment.name} (${formatDigestMoney(payment)}, ${payment.days} дн.)`).join(', ')}.`,
    reviewCount === 0 ? null : `На перевірці: ${reviewCount}.`,
  ]
    .filter(Boolean)
    .join('\n');
};
