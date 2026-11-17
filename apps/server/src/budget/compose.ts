import {
  aggregateMonths,
  BUDGET_INCOME_MONTHS,
  countDaysInMonth,
  indexCategoryLimits,
  listMonthsBack,
  projectMonth,
  summarizeBudget,
  toMonth,
} from '@hroshi/domain';
import type { IsoDate, MonthBudget, SavingsGoal } from '@hroshi/schema';

import type { Db } from '../db.ts';
import type { Ledger } from '../ledger.ts';
import { findPlannedPayments } from '../planned/store.ts';

/** The month of `asOf`, counted up to that day, against the budget the goal leaves. */
export const composeBudget = async ({
  db,
  ledger,
  goal,
  asOf,
  today,
}: {
  db: Db;
  ledger: Ledger;
  goal: SavingsGoal;
  asOf: IsoDate;
  /** Judges which monthly payments are still due. */
  today: IsoDate;
}): Promise<MonthBudget> => {
  const { policies, fx } = ledger;
  const month = toMonth(asOf);
  const counted = ledger.transactions.filter((transaction) => transaction.date <= asOf);
  const stats = aggregateMonths({
    months: listMonthsBack({ until: month, count: BUDGET_INCOME_MONTHS + 1 }),
    transactions: counted,
    policies,
    fx,
    currentMonth: month,
  });
  const current = stats.at(-1);
  const daysElapsed = Number(asOf.slice(8, 10));
  const daysInMonth = countDaysInMonth(month);
  const projection =
    current === undefined || daysElapsed >= daysInMonth
      ? null
      : projectMonth({ month, current, recurring: await findPlannedPayments({ db, ledger, today }), daysElapsed, daysInMonth });
  const [lastDay] = aggregateMonths({
    months: [month],
    transactions: counted.filter((transaction) => transaction.date === asOf),
    policies,
    fx,
    currentMonth: month,
  });
  const goalEur = fx.toEur(goal.amount, goal.currency, asOf);
  if (goalEur === null) throw new Error(`No ${goal.currency} rate for ${asOf}`);

  return summarizeBudget({
    asOf,
    goal,
    goalEur,
    stats,
    limits: indexCategoryLimits(ledger.categories),
    projection,
    lastDaySpentEur: lastDay?.spendEur ?? 0,
  });
};
