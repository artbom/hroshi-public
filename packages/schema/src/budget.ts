import { z } from 'zod';

import { CurrencySchema, IsoDateSchema, MonthSchema, PositiveAmountSchema } from './primitives.ts';

/** What the owner means to put aside each month, in the currency they think of it in. */
export const SavingsGoalSchema = z.object({ amount: PositiveAmountSchema, currency: CurrencySchema });
export type SavingsGoal = z.infer<typeof SavingsGoalSchema>;

/** One slice of the month's budget, in euros; what is left is `limitEur - spentEur`. */
export const BudgetLineSchema = z.object({
  limitEur: z.number(),
  spentEur: z.number(),
  /** Spent, plus the monthly payments still due and everyday spending carried on at its pace; null once the month is over. */
  projectedEur: z.number().nullable(),
});
export type BudgetLine = z.infer<typeof BudgetLineSchema>;

export const MonthBudgetSchema = z.object({
  month: MonthSchema,
  /** The last day counted: the morning report covers the month up to yesterday. */
  asOf: IsoDateSchema,
  daysElapsed: z.number().int(),
  daysInMonth: z.number().int(),
  goal: SavingsGoalSchema,
  goalEur: z.number(),
  /** Average earned income of the complete months before this one; the budget is it minus the goal. */
  usualIncomeEur: z.number(),
  /** Earned so far this month. */
  incomeEur: z.number(),
  /** Spending on `asOf` alone. */
  lastDaySpentEur: z.number(),
  total: BudgetLineSchema,
  /** Categories with an orientir, the most stretched first. */
  categories: z.array(z.object({ category: z.string(), ...BudgetLineSchema.shape })),
  /** Every category without an orientir, sharing what the budget leaves after the orientirs. */
  rest: BudgetLineSchema,
});
export type MonthBudget = z.infer<typeof MonthBudgetSchema>;

export const BudgetQuerySchema = z.object({ asOf: IsoDateSchema.optional() });

/** No goal, no budget: the budget is derived from it. */
export const BudgetSchema = z.object({ goal: SavingsGoalSchema.nullable(), budget: MonthBudgetSchema.nullable() });
export type Budget = z.infer<typeof BudgetSchema>;
