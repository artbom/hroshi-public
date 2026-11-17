import { z } from 'zod';

import { AccountBalanceSchema } from './account.ts';
import { CurrencySchema, IsoDateSchema, MonthSchema, SourceSchema } from './primitives.ts';
import { TransactionRowSchema } from './transaction.ts';

export const InvestmentFlowSchema = z.object({
  id: z.string(),
  date: IsoDateSchema,
  direction: z.enum(['in', 'out']),
  /** In the account currency; null when the credited amount was never learnt (toAmount 0). */
  amount: z.number().nullable(),
  /** What the other account sent or received, in its own currency. */
  counterAmount: z.number(),
  counterCurrency: CurrencySchema,
  /** The other account; for spending paid straight from this one, its category. */
  counterAccountId: z.string(),
  /** `amount`, or for an unknown credit the sent money converted at that day's rates. */
  estimate: z.number().nullable(),
  note: z.string().nullable(),
  /** Dated before the account's opening date: history, already inside the opening balance. */
  beforeOpening: z.boolean(),
  /** Another flow the same way, same amount, a few days apart: probably booked twice. */
  suspectedDuplicate: z.boolean(),
});
export type InvestmentFlow = z.infer<typeof InvestmentFlowSchema>;

export const ContributionSummarySchema = z.object({
  deposits: z.number(),
  withdrawals: z.number(),
  /** Deposits minus withdrawals, in the account currency, known amounts only. */
  net: z.number(),
  /** Flows whose credited amount is unknown. */
  unknown: z.number().int(),
  /** Flows that look booked twice; they still count. */
  duplicates: z.number().int(),
  /** `net` with unknown flows estimated at the day's rates. */
  estimatedNet: z.number(),
  /** Value minus what went in: market moves, interest, fees. */
  gain: z.number(),
  /** Gain relative to what went in; null when nothing went in. */
  gainShare: z.number().nullable(),
});
export type ContributionSummary = z.infer<typeof ContributionSummarySchema>;

export const ValuationEntrySchema = z.object({
  id: z.string(),
  date: IsoDateSchema,
  /** Signed change the valuation booked. */
  amount: z.number(),
  note: z.string().nullable(),
  source: SourceSchema,
});

export const ContributionPointSchema = z.object({
  month: MonthSchema,
  date: IsoDateSchema,
  /** Net contributions up to `date`, unknown credits estimated. */
  contributed: z.number(),
});

/** A value the account really had: at the opening, after each valuation, and now. */
export const ValuePointSchema = z.object({
  date: IsoDateSchema,
  value: z.number(),
  kind: z.enum(['opening', 'valuation', 'now', 'broker']),
});

export const HoldingSchema = z.object({
  symbol: z.string(),
  name: z.string().nullable(),
  quantity: z.number(),
  currency: z.string(),
  price: z.number().nullable(),
  /** Market value in the holding's currency. */
  value: z.number().nullable(),
  /** What the position cost, when the broker reports it. */
  cost: z.number().nullable(),
});
export type Holding = z.infer<typeof HoldingSchema>;

export const BrokerFlowKindSchema = z.enum(['deposit', 'withdrawal', 'dividend', 'tax', 'fee', 'interest', 'other']);
export type BrokerFlowKind = z.infer<typeof BrokerFlowKindSchema>;

/** A cash record from the broker's own statement. */
export const BrokerCashFlowSchema = z.object({
  date: IsoDateSchema,
  kind: BrokerFlowKindSchema,
  /** Signed: money into the account is positive. */
  amount: z.number(),
  currency: z.string(),
  note: z.string().nullable(),
  /** The security a dividend or its withholding belongs to, as the broker spells it. */
  symbol: z.string().nullable(),
  /**
   * The money as it arrived, when the broker restated it in its base currency (IBKR books a EUR
   * deposit in dollars at its own rate): what a bank transfer in the tracker is matched against.
   */
  original: z.object({ amount: z.number(), currency: z.string() }).nullable(),
});
export type BrokerCashFlow = z.infer<typeof BrokerCashFlowSchema>;

/** A sale the broker booked a profit or loss on, in the trade currency. */
export const RealizedTradeSchema = z.object({
  date: IsoDateSchema,
  symbol: z.string(),
  amount: z.number(),
  currency: z.string(),
});
export type RealizedTrade = z.infer<typeof RealizedTradeSchema>;

/**
 * A buy or sale from the broker's own trade log, in the trade currency. A currency exchange is a
 * trade too: `symbol` is the pair («EUR/USD»), the side and quantity are the first currency's, and
 * `amount` is what was paid or received in the second.
 */
export const BrokerTradeSchema = z.object({
  date: IsoDateSchema,
  symbol: z.string(),
  kind: z.enum(['security', 'currency']),
  side: z.enum(['buy', 'sell']),
  quantity: z.number(),
  price: z.number(),
  /** Quantity × price, before the commission. */
  amount: z.number(),
  currency: z.string(),
  /** Positive: what the broker charged. */
  fee: z.number().nullable(),
  /** Freedom24 charges every commission in dollars, even on a trade in euros. */
  feeCurrency: z.string().nullable(),
  /** The FIFO profit the broker booked on a sale. */
  realized: z.number().nullable(),
});
export type BrokerTrade = z.infer<typeof BrokerTradeSchema>;

/**
 * IBKR's own walk from one NAV to the next (the Flex «Change in NAV» section), in the base
 * currency: the parts the cash records do not itemise, such as currency translation.
 */
export const NavChangeSchema = z.object({
  from: IsoDateSchema,
  to: IsoDateSchema,
  startingValue: z.number(),
  endingValue: z.number(),
  depositsWithdrawals: z.number(),
  mtm: z.number(),
  realized: z.number(),
  dividends: z.number(),
  withholdingTax: z.number(),
  interest: z.number(),
  commissions: z.number(),
  forexCommissions: z.number(),
  otherFees: z.number(),
  fxTranslation: z.number(),
  netFxTrading: z.number(),
  other: z.number(),
});
export type NavChange = z.infer<typeof NavChangeSchema>;

/** What a broker's statement file says, read as is. */
export const BrokerReportSchema = z.object({
  broker: z.enum(['ibkr', 'freedom24', 'binance']),
  /** The day the statement describes. */
  asOf: IsoDateSchema,
  file: z.string(),
  currency: z.string(),
  netAssets: z.number().nullable(),
  holdings: z.array(HoldingSchema),
  cashFlows: z.array(BrokerCashFlowSchema),
  /** Daily value the broker reports, oldest first (IBKR NAV). */
  navHistory: z.array(z.object({ date: IsoDateSchema, value: z.number() })),
  /** Profits and losses of sales; null when the statement carries no trades at all. */
  realized: z.array(RealizedTradeSchema).nullable(),
  /** Every buy and sale; null when the statement carries no trade log. */
  trades: z.array(BrokerTradeSchema).nullable(),
  /** Null when the statement has no NAV walk (only IBKR can have one). */
  navChange: NavChangeSchema.nullable(),
});
export type BrokerReport = z.infer<typeof BrokerReportSchema>;

/** Contributions and returns from the broker's cash records, in the account currency. */
export const BrokerResultSchema = z.object({
  deposits: z.number(),
  withdrawals: z.number(),
  net: z.number(),
  /** Value minus net deposits: market moves, dividends, fees, FX. */
  gain: z.number(),
  gainShare: z.number().nullable(),
  /** Money-weighted annual return over the deposits, withdrawals and today's value. */
  xirr: z.number().nullable(),
  dividends: z.number(),
  taxes: z.number(),
  fees: z.number(),
  interest: z.number(),
  firstDeposit: IsoDateSchema.nullable(),
});
export type BrokerResult = z.infer<typeof BrokerResultSchema>;

export const AllTimeIssueSchema = z.enum([
  /** Credits nobody learnt; estimated at the day's rates. */
  'unknown-credits',
  /** Flows that look booked twice. */
  'duplicates',
  /** Walking back from the opening the balance goes below zero: withdrawals are missing. */
  'negative-history',
  /** No flow at all: what went in is unknown. */
  'no-flows',
  /** A large value was already there before the first flow. */
  'unexplained-start',
]);
export type AllTimeIssue = z.infer<typeof AllTimeIssueSchema>;

export const InvestmentAccountSchema = z.object({
  account: AccountBalanceSchema,
  eur: z.number().nullable(),
  /** Share of all investments in EUR. */
  share: z.number(),
  lastValuation: ValuationEntrySchema.nullable(),
  /** From the opening date on: the part of the ledger that is complete. */
  sinceOpening: ContributionSummarySchema,
  /** Every flow the ledger holds, history included; only as good as that history. */
  allTime: ContributionSummarySchema,
  /** Why the all-time figures are not a profit yet; empty when the flows explain the value. */
  allTimeIssues: z.array(AllTimeIssueSchema),
  /**
   * What the account held just before its first recorded flow, walking back from the opening:
   * money the flows do not explain (missed deposits, or growth before tracking began).
   */
  startValue: z.number().nullable(),
  valuations: z.array(ValuationEntrySchema),
  flows: z.array(InvestmentFlowSchema),
  contributions: z.array(ContributionPointSchema),
  values: z.array(ValuePointSchema),
  /** The latest statement file of the broker, when one was imported. */
  report: BrokerReportSchema.omit({ cashFlows: true, realized: true, trades: true, navChange: true }).nullable(),
  /** The broker's trade log, newest first; null when its statement has none (IBKR without a Trades section). */
  trades: z.array(BrokerTradeSchema).nullable(),
  /** Returns from the broker's own cash records; complete where the ledger is not. */
  broker: BrokerResultSchema.nullable(),
  brokerFlows: z.array(BrokerCashFlowSchema),
});
export type InvestmentAccount = z.infer<typeof InvestmentAccountSchema>;

/** Money lent to someone (or, negative, owed to someone): a receivable account. */
export const LoanSchema = z.object({
  account: AccountBalanceSchema,
  eur: z.number().nullable(),
  /** When the money left: the first flow into the receivable, else its opening date. */
  sentDate: IsoDateSchema,
  /** Opening balance plus everything lent since. */
  lent: z.number(),
  repaid: z.number(),
  ageDays: z.number().int(),
  /** The date comes from a recorded row, not just the account's opening in the tracker. */
  sentRecorded: z.boolean(),
  /** Every row on the receivable, newest first. */
  rows: z.array(TransactionRowSchema),
});
export type Loan = z.infer<typeof LoanSchema>;

/**
 * stockEtf and bondEtf are funds; VGSH-like short Treasury funds count as bonds but behave like
 * cash. Stablecoins and wallets without a breakdown are crypto.
 */
export const AssetClassSchema = z.enum(['stock', 'stockEtf', 'bondEtf', 'cash', 'crypto']);
export type AssetClass = z.infer<typeof AssetClassSchema>;

/** One line of the portfolio across brokers, valued at the broker's statement date. */
export const PositionSchema = z.object({
  key: z.string(),
  /** Ticker without the exchange suffix. */
  symbol: z.string(),
  name: z.string().nullable(),
  assetClass: AssetClassSchema,
  /** Short-term Treasuries: a bond fund that behaves like cash. */
  cashLike: z.boolean(),
  /** The tracker account the position sits in. */
  accountId: z.string(),
  /**
   * A line the statement does not list but its total implies: cash IBKR leaves out, tokens
   * Binance only prices in the wallet total, or a whole account with no statement at all.
   */
  remainder: z.enum(['cash', 'tokens', 'whole-account']).nullable(),
  quantity: z.number().nullable(),
  /** The broker's price, in `currency`. */
  price: z.number().nullable(),
  currency: z.string(),
  value: z.number(),
  eur: z.number(),
  /** What the broker says the position cost, in `currency`. */
  cost: z.number().nullable(),
  /** Cost in EUR at today's rate, so the gain is the market's, not the currency's. */
  costEur: z.number().nullable(),
  gainEur: z.number().nullable(),
  /** Share of all positions in EUR. */
  weight: z.number(),
});
export type Position = z.infer<typeof PositionSchema>;

export const AssetClassShareSchema = z.object({
  assetClass: AssetClassSchema,
  eur: z.number(),
  weight: z.number(),
});
export type AssetClassShare = z.infer<typeof AssetClassShareSchema>;

export const PortfolioPointSchema = z.object({
  date: IsoDateSchema,
  valueEur: z.number(),
  /** Net deposits so far, each in EUR at its own day's rate. */
  contributedEur: z.number(),
  /** Part of the value is modelled: no statement gives that account's value on that day. */
  estimated: z.boolean(),
  /** The same deposits and withdrawals, each buying or selling the benchmark fund at that day's close. */
  benchmarkEur: z.number().nullable(),
});
export type PortfolioPoint = z.infer<typeof PortfolioPointSchema>;

export const PortfolioHistorySchema = z.object({
  /** Accounts whose deposits are fully known; only these make a fair value-vs-deposits line. */
  accountIds: z.array(z.string()),
  /** Accounts with a modelled value between statements, and the yearly rate it grows at. */
  modelled: z.array(z.object({ accountId: z.string(), xirr: z.number() })),
  excluded: z.array(z.object({ accountId: z.string(), reason: z.enum(['no-flows', 'incomplete-flows']) })),
  points: z.array(PortfolioPointSchema),
});
export type PortfolioHistory = z.infer<typeof PortfolioHistorySchema>;

/** One money-weighted return, taken apart: the market in the accounts' currency and the currency against the euro. */
export const ReturnSplitSchema = z.object({
  eur: z.number().nullable(),
  /** The same flows and value in the accounts' own currency; null when the accounts use different ones. */
  local: z.number().nullable(),
  localCurrency: CurrencySchema.nullable(),
  /** (1 + eur) / (1 + local) − 1: what the currency's move against the euro added per year. */
  fx: z.number().nullable(),
});
export type ReturnSplit = z.infer<typeof ReturnSplitSchema>;

/** A broker's income for a calendar year, in the account currency. */
export const IncomeYearSchema = z.object({
  year: z.number().int(),
  accountId: z.string(),
  currency: CurrencySchema,
  dividends: z.number(),
  /** Tax the broker withheld, positive. */
  withholding: z.number(),
  withholdingRate: z.number().nullable(),
  /** Null when the statement has no trades to take it from. */
  realized: z.number().nullable(),
  eur: z.object({ dividends: z.number(), withholding: z.number(), realized: z.number().nullable() }),
});
export type IncomeYear = z.infer<typeof IncomeYearSchema>;

/** The index fund every result is held against. */
export const BenchmarkSchema = z.object({
  symbol: z.string(),
  name: z.string(),
  /** The cached closes span these days; a deposit before the first one buys at that first close. */
  pricesFrom: IsoDateSchema,
  pricesUntil: IsoDateSchema,
  /** What the same deposits would be worth in it today. */
  valueEur: z.number(),
  /** Money-weighted annual return of those deposits in it, in EUR. */
  xirr: z.number().nullable(),
});
export type Benchmark = z.infer<typeof BenchmarkSchema>;

export const ReturnPeriodSchema = z.enum(['ytd', '12m', 'all']);
export type ReturnPeriod = z.infer<typeof ReturnPeriodSchema>;

/** A return over a calendar span, deposits weighted by how long they were in (Modified Dietz), not annualised. */
export const PeriodReturnSchema = z.object({
  period: ReturnPeriodSchema,
  from: IsoDateSchema,
  to: IsoDateSchema,
  portfolio: z.number().nullable(),
  benchmark: z.number().nullable(),
  /** short-history: the deposits start after the period does; no-prices: the benchmark has no closes that far back. */
  missing: z.enum(['short-history', 'no-prices']).nullable(),
  /** The value at the start is modelled from the account's yearly return, not reported by the broker. */
  estimated: z.boolean(),
});
export type PeriodReturn = z.infer<typeof PeriodReturnSchema>;

export const ExposureCurrencySchema = z.enum(['USD', 'EUR', 'other']);
export type ExposureCurrency = z.infer<typeof ExposureCurrencySchema>;

/** What the money is priced in underneath: a stablecoin counts as dollars, a fund of non-US shares as other currencies. */
export const CurrencyExposureSchema = z.object({
  currency: ExposureCurrencySchema,
  eur: z.number(),
  weight: z.number(),
  /** Positions that sit here only after looking through the quote currency. */
  lookThrough: z.array(z.string()),
});
export type CurrencyExposure = z.infer<typeof CurrencyExposureSchema>;

/** Why part of a broker's result stays unexplained: the statement sections that would itemise it. */
export const ResidualCauseSchema = z.enum(['trades', 'nav-change']);
export type ResidualCause = z.infer<typeof ResidualCauseSchema>;

/**
 * The broker result taken apart, everything in EUR at today's rate: the positions' unrealised
 * gain plus booked income and costs; `other` is what the statements do not itemise.
 */
export const ResultBreakdownSchema = z.object({
  positionsGainEur: z.number(),
  realizedEur: z.number().nullable(),
  dividendsEur: z.number(),
  taxesEur: z.number(),
  feesEur: z.number(),
  interestEur: z.number(),
  /** Trade commissions the broker charges outside the purchase cost (Freedom24), and currency-exchange commissions. */
  commissionsEur: z.number(),
  /**
   * The currency inside a dollar account: positions and cash in euros moved with the rate since the
   * euros came in, exchanges at the broker's rate rather than the day's, and the broker's own rate today.
   */
  fxEur: z.number(),
  /** What remains: the sum above minus the itemised terms, per broker. */
  otherEur: z.number(),
  residual: z.array(z.object({ accountId: z.string(), eur: z.number(), missing: z.array(ResidualCauseSchema) })),
  brokerGainEur: z.number(),
  /** The broker result counts from here: the first deposit at any of those brokers. */
  brokerFrom: IsoDateSchema.nullable(),
  /** The tracker's own opening dates of the investment accounts, earliest and latest. */
  openingFrom: IsoDateSchema.nullable(),
  openingTo: IsoDateSchema.nullable(),
});
export type ResultBreakdown = z.infer<typeof ResultBreakdownSchema>;

/** The share of the portfolio the owner wants in one asset class. */
export const AllocationTargetSchema = z.object({
  assetClass: AssetClassSchema,
  share: z.number().min(0).max(1),
});
export type AllocationTarget = z.infer<typeof AllocationTargetSchema>;

export const AllocationTargetListSchema = z.array(AllocationTargetSchema);

/** Replaces every target at once; classes left out have none. Shares add up to at most 100%. */
export const SaveAllocationTargetsSchema = z.object({
  targets: AllocationTargetListSchema.refine((targets) => new Set(targets.map((target) => target.assetClass)).size === targets.length, {
    message: 'Each asset class once',
  }).refine((targets) => targets.reduce((sum, target) => sum + target.share, 0) <= 1.0001, { message: 'Targets add up to more than 100%' }),
});
export type SaveAllocationTargets = z.infer<typeof SaveAllocationTargetsSchema>;

export const InvestmentsSchema = z.object({
  valueEur: z.number(),
  /** Gains since each account's opening date, the part of the ledger that is complete. */
  sinceOpeningGainEur: z.number(),
  /** All-time net contributions with unknown credits estimated, at today's rates. */
  contributedEur: z.number(),
  gainEur: z.number(),
  /** Accounts whose returns come from broker statements, summed in EUR at today's rates. */
  brokerGainEur: z.number(),
  brokerAccounts: z.array(z.string()),
  /** Money-weighted annual return across the accounts with broker statements, in EUR. */
  brokerXirr: z.number().nullable(),
  returns: ReturnSplitSchema,
  benchmark: BenchmarkSchema.nullable(),
  periodReturns: z.array(PeriodReturnSchema),
  breakdown: ResultBreakdownSchema,
  currencyExposure: z.array(CurrencyExposureSchema),
  positions: z.array(PositionSchema),
  assetClasses: z.array(AssetClassShareSchema),
  targets: AllocationTargetListSchema,
  history: PortfolioHistorySchema,
  income: z.array(IncomeYearSchema),
  accounts: z.array(InvestmentAccountSchema),
  loans: z.array(LoanSchema),
  /** Receivables with a negative balance: what the owner owes (Splitwise). */
  debts: z.array(LoanSchema),
});
export type Investments = z.infer<typeof InvestmentsSchema>;

export const PositionParamsSchema = z.object({ key: z.string().min(1) });

export const ContributionGapParamsSchema = z.object({ accountId: z.string().min(1) });

/** A deposit or withdrawal the broker booked, with the tracker rows that could be its bank side. */
export const UnmatchedBrokerFlowSchema = z.object({
  /** In the account currency, with `original` when the broker restated it. */
  flow: BrokerCashFlowSchema,
  /** Rows of about the same money a few days around it that do not reach the account yet. */
  candidates: z.array(TransactionRowSchema),
});
export type UnmatchedBrokerFlow = z.infer<typeof UnmatchedBrokerFlowSchema>;

/**
 * Where the tracker's transfers and the broker's deposits part: the broker's records with no
 * transfer in the tracker, and tracker transfers the broker never booked.
 */
export const ContributionGapsSchema = z.object({
  accountId: z.string(),
  currency: CurrencySchema,
  brokerNet: z.number(),
  trackerNet: z.number(),
  matched: z.number().int(),
  missing: z.array(UnmatchedBrokerFlowSchema),
  extra: z.array(InvestmentFlowSchema),
});
export type ContributionGaps = z.infer<typeof ContributionGapsSchema>;

export const PositionIncomeSchema = z.object({
  date: IsoDateSchema,
  kind: z.enum(['dividend', 'tax']),
  /** Signed, in `currency`: withholding is negative. */
  amount: z.number(),
  currency: z.string(),
  eur: z.number().nullable(),
});
export type PositionIncome = z.infer<typeof PositionIncomeSchema>;

export const PositionTradeSchema = z.object({
  ...BrokerTradeSchema.shape,
  /** Shares held after this trade. */
  holding: z.number(),
  eur: z.number().nullable(),
});
export type PositionTrade = z.infer<typeof PositionTradeSchema>;

/** One position with everything its statements say about it, in its own currency and in EUR. */
export const PositionDetailSchema = z.object({
  position: PositionSchema,
  broker: BrokerReportSchema.shape.broker.nullable(),
  /** The statement date the quantity and price are true on. */
  asOf: IsoDateSchema.nullable(),
  cost: z.number().nullable(),
  gain: z.number().nullable(),
  averageCost: z.number().nullable(),
  income: z.array(PositionIncomeSchema),
  dividendsEur: z.number(),
  withholdingEur: z.number(),
  /** Null when the statement carries no trade log. */
  trades: z.array(PositionTradeSchema).nullable(),
  /** What no stored statement can tell about this position. */
  missing: z.array(z.enum(['trades', 'cost', 'price-history', 'income'])),
});
export type PositionDetail = z.infer<typeof PositionDetailSchema>;
