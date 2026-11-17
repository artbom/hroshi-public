import type { BrokerCashFlow, BrokerFlowKind, BrokerReport, BrokerTrade } from '@hroshi/schema';
import { z } from 'zod';

const NumberSchema = z.union([z.number(), z.string()]).pipe(z.coerce.number());

const CashFlowSchema = z.object({
  date: z.string(),
  amount: NumberSchema,
  currency: z.string(),
  type_id: z.string(),
  comment: z.string().nullish(),
});

const PositionSchema = z.object({
  i: z.string(),
  name: z.string().nullish(),
  q: NumberSchema,
  curr: z.string(),
  mkt_price: NumberSchema.nullish(),
  market_value: NumberSchema.nullish(),
  open_bal: NumberSchema.nullish(),
});

const CashBalanceSchema = z.object({ curr: z.string(), s: NumberSchema });

const TradeSchema = z.object({
  short_date: z.string(),
  instr_nm: z.string(),
  operation: z.string(),
  curr_c: z.string(),
  q: NumberSchema.nullish(),
  p: NumberSchema.nullish(),
  summ: NumberSchema.nullish(),
  commission: NumberSchema.nullish(),
  commission_currency: z.string().nullish(),
  fifo_profit: NumberSchema.nullish(),
});

const CommissionSchema = z.object({
  sum: NumberSchema,
  currency: z.string(),
  type: z.string(),
  comment: z.string().nullish(),
  datetime: z.string(),
});

const ReportSchema = z.object({
  date_end: z.string(),
  plainAccountInfoData: z.object({ base_currency: z.string() }).partial().optional(),
  account_at_end: z.object({
    account: z.object({
      net_assets: NumberSchema.nullish(),
      positions_from_ts: z.record(z.string(), z.object({ pos: z.array(PositionSchema).default([]), acc: z.array(CashBalanceSchema).default([]) })),
    }),
  }),
  cash_flows: z.object({ detailed: z.array(CashFlowSchema) }),
  trades: z.object({ detailed: z.array(TradeSchema).default([]) }).optional(),
  commissions: z.object({ detailed: z.array(CommissionSchema).default([]) }).optional(),
});

/** Trade commissions belong to their trade; the rest of the list is fees (2% on card deposits, a withdrawal charge). */
const TRADE_COMMISSION = /^For trade/u;

/**
 * Freedom24 reports a withdrawal as a block, an unblock and the final debit; only bank, card,
 * dividend, tax and fee lines are money that moved.
 */
const KINDS: Readonly<Record<string, BrokerFlowKind | ((amount: number) => BrokerFlowKind)>> = {
  card: (amount) => (amount >= 0 ? 'deposit' : 'withdrawal'),
  bank: (amount) => (amount >= 0 ? 'deposit' : 'withdrawal'),
  dividend: 'dividend',
  tax: 'tax',
  agent_fee: 'fee',
  commission: 'fee',
};

/** A currency exchange is booked as a trade in the pair: «EUR/USD». */
const CURRENCY_PAIR = /^[A-Z]{3}\/[A-Z]{3}$/u;

/** Dividend and tax comments name the security in brackets: «… (INVESCO NASDAQ 100 ETF (QQQM.US)) …», «( QQQM.US )». */
const findCommentSymbol = (comment: string | null | undefined): string | null =>
  /\(\s*([A-Z0-9-]+\.[A-Z]{2})\s*\)/u.exec(comment ?? '')?.[1] ?? null;

export const parseFreedom24Report = ({ json, file }: { json: unknown; file: string }): BrokerReport => {
  const report = ReportSchema.parse(json);
  const [book] = Object.values(report.account_at_end.account.positions_from_ts);
  const cashFlows: BrokerCashFlow[] = report.cash_flows.detailed.flatMap((flow) => {
    const kind = KINDS[flow.type_id];
    if (kind === undefined) return [];
    return [
      {
        date: flow.date.slice(0, 10),
        kind: typeof kind === 'function' ? kind(flow.amount) : kind,
        amount: flow.amount,
        currency: flow.currency,
        note: flow.comment?.trim() || null,
        symbol: findCommentSymbol(flow.comment),
        original: null,
      },
    ];
  });
  // Freedom24 books these fees only in its commissions list, never among the cash records.
  const fees: BrokerCashFlow[] = (report.commissions?.detailed ?? [])
    .filter((commission) => !TRADE_COMMISSION.test(commission.type) && commission.sum !== 0)
    .map((commission) => ({
      date: commission.datetime.slice(0, 10),
      kind: 'fee',
      amount: -commission.sum,
      currency: commission.currency,
      note: commission.comment?.trim() || commission.type,
      symbol: null,
      original: null,
    }));
  return {
    broker: 'freedom24',
    asOf: report.date_end.slice(0, 10),
    file,
    currency: report.plainAccountInfoData?.base_currency ?? 'USD',
    netAssets: report.account_at_end.account.net_assets ?? null,
    holdings: [
      ...(book?.pos ?? []).map((position) => ({
        symbol: position.i,
        name: position.name ?? null,
        quantity: position.q,
        currency: position.curr,
        price: position.mkt_price ?? null,
        value: position.market_value ?? null,
        cost: position.open_bal ?? null,
      })),
      ...(book?.acc ?? [])
        .filter((cash) => cash.s !== 0)
        .map((cash) => ({ symbol: cash.curr, name: 'Гроші', quantity: cash.s, currency: cash.curr, price: 1, value: cash.s, cost: null })),
    ],
    cashFlows: [...cashFlows, ...fees].toSorted((left, right) => left.date.localeCompare(right.date)),
    navHistory: [],
    // Freedom24 books the FIFO result on each sale; buys and currency swaps carry zero or nothing.
    realized: (report.trades?.detailed ?? [])
      .filter((trade) => trade.operation === 'sell' && (trade.fifo_profit ?? 0) !== 0)
      .map((trade) => ({ date: trade.short_date.slice(0, 10), symbol: trade.instr_nm, amount: trade.fifo_profit ?? 0, currency: trade.curr_c })),
    trades: (report.trades?.detailed ?? []).flatMap((trade): BrokerTrade[] => {
      const side = trade.operation === 'buy' || trade.operation === 'sell' ? trade.operation : null;
      if (side === null || trade.q === null || trade.q === undefined || trade.p === null || trade.p === undefined) return [];
      return [
        {
          date: trade.short_date.slice(0, 10),
          symbol: trade.instr_nm,
          side,
          quantity: trade.q,
          price: trade.p,
          amount: trade.summ ?? trade.q * trade.p,
          currency: trade.curr_c,
          kind: CURRENCY_PAIR.test(trade.instr_nm) ? 'currency' : 'security',
          fee: trade.commission ?? null,
          feeCurrency: trade.commission_currency ?? null,
          realized: side === 'sell' ? (trade.fifo_profit ?? null) : null,
        },
      ];
    }),
    navChange: null,
  };
};
