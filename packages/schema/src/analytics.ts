import { z } from 'zod';

import { RateUsageSchema } from './fx.ts';
import { CurrencySchema, MonthSchema } from './primitives.ts';

const AmountByCategorySchema = z.object({ category: z.string(), amount: z.number() });

/** How a row counts in the analytics. */
export const SpendingEffectSchema = z.discriminatedUnion('kind', [
  /** Spending in a category; refunds of that category come back with sign -1. */
  z.object({ kind: z.literal('spend'), category: z.string(), sign: z.union([z.literal(1), z.literal(-1)]) }),
  z.object({ kind: z.literal('income') }),
  /** Generic reimbursement: lowers total spending without touching a category. */
  z.object({ kind: z.literal('refund') }),
  z.object({ kind: z.literal('none') }),
]);
export type SpendingEffect = z.infer<typeof SpendingEffectSchema>;

export const MonthQuerySchema = z.object({ month: MonthSchema });

export const MonthOverviewSchema = z.object({
  month: MonthSchema,
  /** Spending in original currencies, net of refunds in the same category. */
  byCurrency: z.array(
    z.object({
      currency: CurrencySchema,
      spent: z.number(),
      income: z.number(),
      categories: z.array(AmountByCategorySchema),
    }),
  ),
  limits: z.array(z.object({ category: z.string(), limitEur: z.number(), spentEur: z.number() })),
  /** Last 12 months of spending, per original currency. */
  spendTrend: z.array(
    z.object({
      currency: CurrencySchema,
      months: z.array(z.object({ month: MonthSchema, amount: z.number() })),
    }),
  ),
});
export type MonthOverview = z.infer<typeof MonthOverviewSchema>;

export const NetWorthSchema = z.object({
  totalEur: z.number(),
  cashEur: z.number(),
  investmentsEur: z.number(),
  owedToMeEur: z.number(),
  creditDebtEur: z.number(),
  iOweEur: z.number(),
});
export type NetWorth = z.infer<typeof NetWorthSchema>;

/** Today's net worth with the rates it was converted at, so an equation in euros can name them. */
export const CurrentNetWorthSchema = z.object({ ...NetWorthSchema.shape, rates: z.array(RateUsageSchema) });
export type CurrentNetWorth = z.infer<typeof CurrentNetWorthSchema>;

export const MonthStatsSchema = z.object({
  month: MonthSchema,
  incomeEur: z.number(),
  spendEur: z.number(),
  refundEur: z.number(),
  rows: z.number().int(),
  /** Too few rows to trust the month. */
  sparse: z.boolean(),
  noIncome: z.boolean(),
  /** The month has not finished yet. */
  partial: z.boolean(),
  categories: z.record(z.string(), z.number()),
});
export type MonthStats = z.infer<typeof MonthStatsSchema>;

/** Monthly views can spread the quarterly ФОП tax over the three months it was paid for. */
const SpreadTaxSchema = z.stringbool().default(false);

export const TrendsQuerySchema = z.object({
  month: MonthSchema,
  range: z.coerce.number().int().min(1).max(120).default(12),
  spreadTax: SpreadTaxSchema,
});

export const TrendsSchema = z.object({
  months: z.array(MonthStatsSchema),
  averages: z.object({
    incomeEur: z.number(),
    spendEur: z.number(),
    savedEur: z.number(),
    savingsRate: z.number().nullable(),
    completeMonths: z.number().int(),
    totalMonths: z.number().int(),
  }),
});
export type Trends = z.infer<typeof TrendsSchema>;

export const CategoryDetailQuerySchema = z.object({
  month: MonthSchema,
  range: z.coerce.number().int().min(1).max(120).default(12),
  category: z.string().min(1),
  spreadTax: SpreadTaxSchema,
});

export const ComparisonQuerySchema = z.object({ month: MonthSchema, spreadTax: SpreadTaxSchema });

export const CategoryDetailSchema = z.object({
  category: z.string(),
  months: z.array(z.object({ month: MonthSchema, eur: z.number(), sparse: z.boolean() })),
  merchants: z.array(
    z.object({
      merchant: z.string(),
      eur: z.number(),
      key: z.string(),
      /** Set on the one entry that gathers rows the bank gave no payee for, with how many there are. */
      unnamed: z.literal(true).optional(),
      count: z.number().int().optional(),
    }),
  ),
});
export type CategoryDetail = z.infer<typeof CategoryDetailSchema>;
