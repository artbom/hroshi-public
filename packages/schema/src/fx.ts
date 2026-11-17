import { z } from 'zod';

import { CurrencySchema, IsoDateSchema, MonthSchema } from './primitives.ts';

/**
 * Which rate converted an amount: EUR itself, a daily rate close to the date, the year's
 * average when no daily rate is near, or the newest daily rate when even the year is unknown.
 */
export const RateKindSchema = z.enum(['base', 'daily', 'yearly', 'latest']);
export type RateKind = z.infer<typeof RateKindSchema>;

export const RateUsageSchema = z.object({
  currency: CurrencySchema,
  /** Units of the currency per 1 EUR. */
  perEur: z.number(),
  kind: RateKindSchema,
  /** Day of the daily rate (daily, latest). */
  date: IsoDateSchema.nullable(),
  /** Year of the average (yearly). */
  year: z.number().int().nullable(),
  /** Where the daily rate came from, e.g. "nbu". */
  source: z.string().nullable(),
});
export type RateUsage = z.infer<typeof RateUsageSchema>;

export const HryvniaPointSchema = z.object({
  month: MonthSchema,
  /** Month end, or today for the running month. */
  date: IsoDateSchema,
  /** Hryvnias per euro on `date`; null when no rate is known. */
  uahPerEur: z.number().nullable(),
  /** Hryvnia accounts with money on them. */
  assetsUah: z.number(),
  assetsEur: z.number(),
  /** Hryvnia accounts below zero: the credit cards. Negative. */
  debtUah: z.number(),
  debtEur: z.number(),
  /** What the month's rate move did to last month's balances, in EUR: a weaker hryvnia shrinks both. */
  assetsFxEur: z.number(),
  debtFxEur: z.number(),
});
export type HryvniaPoint = z.infer<typeof HryvniaPointSchema>;

export const HryvniaExposureSchema = z.object({
  points: z.array(HryvniaPointSchema),
  /** Sum of the monthly rate effects over the range: positive on the debt is a gain. */
  assetsFxEur: z.number(),
  debtFxEur: z.number(),
});
export type HryvniaExposure = z.infer<typeof HryvniaExposureSchema>;
