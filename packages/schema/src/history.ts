import { z } from 'zod';

import { AccountBalanceSchema } from './account.ts';
import { NetWorthSchema } from './analytics.ts';
import { BalanceCheckSchema } from './checks.ts';
import { CurrencySchema, IsoDateSchema, MonthSchema } from './primitives.ts';

export const HistoryQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(120).default(24),
});

export const BalancePointSchema = z.object({
  month: MonthSchema,
  /** Month end, or today for the running month. */
  date: IsoDateSchema,
  balance: z.number(),
  /** At the rate of `date`; null when no rate is known. */
  eur: z.number().nullable(),
  /** Rows touching the account in this month. */
  rows: z.number().int(),
  /** The ledger as a whole is too thin this month, so the back-cast balance is a guess. */
  sparse: z.boolean(),
});
export type BalancePoint = z.infer<typeof BalancePointSchema>;


export const AccountHistorySchema = z.object({
  account: AccountBalanceSchema,
  points: z.array(BalancePointSchema),
  /** Rows dated before the opening date: real flows that back-cast older balances, never the current one. */
  historyRows: z.number().int(),
  firstRowDate: IsoDateSchema.nullable(),
  /** Transfers in whose credited amount is unknown (0): they move nothing, so the history misses them. */
  unknownInflows: z.number().int(),
  check: BalanceCheckSchema.nullable(),
});
export type AccountHistory = z.infer<typeof AccountHistorySchema>;

export const NetWorthPointSchema = z.object({
  ...NetWorthSchema.shape,
  month: MonthSchema,
  date: IsoDateSchema,
  sparse: z.boolean(),
});
export type NetWorthPoint = z.infer<typeof NetWorthPointSchema>;

export const NetWorthHistorySchema = z.object({
  points: z.array(NetWorthPointSchema),
  /** Accounts that had money at some point in the range; archived ones included, their history moves money too. */
  accounts: z.number().int(),
});
export type NetWorthHistory = z.infer<typeof NetWorthHistorySchema>;

/** The bridge spans the months `from`…`month`; without `from` it is the one month. */
export const BridgeQuerySchema = z.object({ month: MonthSchema, from: MonthSchema.optional() });
export type BridgeQuery = z.infer<typeof BridgeQuerySchema>;

/** What makes up «Інше» in the bridge, so the residual is never a black box. */
export const BridgeOtherPartSchema = z.object({
  /**
   * spending: an expense category that does not count as spending («Інвестиції»); income: income that is not
   * earnings; transfers: exchange spreads and transfers whose other side is unknown; rates: the rate moving on
   * money that came and went inside the period; brokers: deposits a broker's statement lists that the tracker
   * has no transfer for (or, where the statement knows only one end, its value in place of the tracker's
   * estimate); rest: rows without a rate and rounding.
   */
  kind: z.enum(['spending', 'income', 'transfers', 'rates', 'brokers', 'rest']),
  category: z.string().nullable(),
  /** The broker account a `brokers` line is about. */
  accountId: z.string().nullable(),
  eur: z.number(),
  /** For `brokers`: the deposits and withdrawals the statement lists in the period. */
  rows: z.number().int(),
});
export type BridgeOtherPart = z.infer<typeof BridgeOtherPartSchema>;

/** One account's market move in the bridge, and where the figure comes from. */
export const BridgeValuationPartSchema = z.object({
  accountId: z.string(),
  /**
   * broker: the statement knows the value at both ends, so the move is value change minus the deposits it
   * lists; rows: the tracker's valuation records, the only market moves it knows for the account.
   */
  source: z.enum(['broker', 'rows']),
  /** broker: the statement's first deposit, when the account came alive; rows: the earliest valuation record in the period. */
  firstDate: IsoDateSchema.nullable(),
  eur: z.number(),
});
export type BridgeValuationPart = z.infer<typeof BridgeValuationPartSchema>;

/** The rate effect on one currency: the balances held at the start, revalued at the end rate. */
export const BridgeFxPartSchema = z.object({
  currency: CurrencySchema,
  balance: z.number(),
  eur: z.number(),
});
export type BridgeFxPart = z.infer<typeof BridgeFxPartSchema>;

/** Why net worth moved over a period, in EUR. */
export const NetWorthBridgeSchema = z.object({
  month: MonthSchema,
  fromMonth: MonthSchema,
  from: IsoDateSchema,
  to: IsoDateSchema,
  startEur: z.number(),
  endEur: z.number(),
  /** Income minus spending, as the month's analytics count them. */
  savingsEur: z.number(),
  /** Earnings and spending net of refunds: savings = earned − spent. */
  earnedEur: z.number(),
  spentEur: z.number(),
  /** Market moves: from a broker's statement where it knows both ends, otherwise the valuation records. */
  valuationsEur: z.number(),
  /** Per account, biggest first; parts under half a euro are left out. */
  valuationParts: z.array(BridgeValuationPartSchema),
  /** The same balances worth more or less euros because the hryvnia and the dollar moved. */
  fxEur: z.number(),
  fxParts: z.array(BridgeFxPartSchema),
  /** Everything else; `otherParts` adds up to it. */
  otherEur: z.number(),
  otherParts: z.array(BridgeOtherPartSchema),
  /** Change of the credit-card debt within the movement above. */
  creditDebtChangeEur: z.number(),
});
export type NetWorthBridge = z.infer<typeof NetWorthBridgeSchema>;
