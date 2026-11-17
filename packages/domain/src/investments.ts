import type {
  AllTimeIssue,
  AssetClass,
  AssetClassShare,
  BrokerReport,
  ContributionSummary,
  CurrencyExposure,
  ExposureCurrency,
  Holding,
  IsoDate,
  InvestmentFlow,
  Position,
  Transaction,
} from '@hroshi/schema';

import { listBalanceEffects, roundAmount } from './balances.ts';
import type { FxConverter } from './fx.ts';
import { countDaysBetween } from './months.ts';
import type { LedgerAccount, LedgerTransaction } from './types.ts';

export type HoldingTransaction = LedgerTransaction & Pick<Transaction, 'id' | 'source'>;

const convert = ({
  fx,
  amount,
  from,
  to,
  date,
}: {
  fx: FxConverter;
  amount: number;
  from: Transaction['currency'];
  to: Transaction['currency'];
  date: IsoDate;
}): number | null => {
  if (from === to) return amount;
  const eur = fx.toEur(amount, from, date);
  const rate = fx.findRate(to, date);
  return eur === null || rate === null ? null : eur * rate;
};

/** Two flows the same way within these days and this share of each other look like one booked twice. */
const DUPLICATE_WINDOW_DAYS = 3;
const DUPLICATE_AMOUNT_SHARE = 0.01;

const flagDuplicateFlows = (flows: readonly Omit<InvestmentFlow, 'suspectedDuplicate'>[]): InvestmentFlow[] =>
  flows.map((flow) => ({
    ...flow,
    suspectedDuplicate: flows.some(
      (other) =>
        other.id !== flow.id &&
        other.direction === flow.direction &&
        other.estimate !== null &&
        flow.estimate !== null &&
        Math.abs(other.estimate - flow.estimate) <= Math.abs(flow.estimate) * DUPLICATE_AMOUNT_SHARE &&
        Math.abs(countDaysBetween(other.date, flow.date)) <= DUPLICATE_WINDOW_DAYS,
    ),
  }));

/**
 * Money moved into or out of the account, in its currency. A credit nobody learnt (toAmount 0)
 * stays unknown, with an estimate from the day's rates so contributions are not understated.
 * Spending paid straight from the account is money taken out, not a loss of the investment.
 */
export const listFlows = ({
  account,
  transactions,
  fx,
}: {
  account: Pick<LedgerAccount, 'id' | 'currency' | 'openingDate'>;
  transactions: readonly HoldingTransaction[];
  fx: FxConverter;
}): InvestmentFlow[] => flagDuplicateFlows(
  transactions.flatMap((transaction): Omit<InvestmentFlow, 'suspectedDuplicate'>[] => {
    const beforeOpening = transaction.date < account.openingDate;
    if (transaction.type === 'expense' && transaction.accountId === account.id) {
      return [
        {
          id: transaction.id,
          date: transaction.date,
          direction: 'out',
          amount: transaction.amount,
          counterAmount: transaction.amount,
          counterCurrency: transaction.currency,
          counterAccountId: transaction.category ?? '',
          estimate: transaction.amount,
          note: transaction.note,
          beforeOpening,
        },
      ];
    }
    if (transaction.type !== 'transfer') return [];
    if (transaction.toAccountId === account.id) {
      const amount = transaction.toAmount === 0 ? null : (transaction.toAmount ?? transaction.amount);
      return [
        {
          id: transaction.id,
          date: transaction.date,
          direction: 'in',
          amount,
          counterAmount: transaction.amount,
          counterCurrency: transaction.currency,
          counterAccountId: transaction.accountId,
          estimate:
            amount ??
            convert({ fx, amount: transaction.amount, from: transaction.currency, to: account.currency, date: transaction.date }),
          note: transaction.note,
          beforeOpening,
        },
      ];
    }
    if (transaction.accountId !== account.id || transaction.toAccountId === null) return [];
    return [
      {
        id: transaction.id,
        date: transaction.date,
        direction: 'out',
        amount: transaction.amount,
        counterAmount: transaction.toAmount ?? transaction.amount,
        counterCurrency: transaction.toCurrency ?? transaction.currency,
        counterAccountId: transaction.toAccountId,
        estimate: transaction.amount,
        note: transaction.note,
        beforeOpening,
      },
    ];
  }),
);

/** Signed contribution of a flow: deposits add, withdrawals take away. */
const signFlow = (flow: InvestmentFlow, pick: (flow: InvestmentFlow) => number | null) =>
  (flow.direction === 'in' ? 1 : -1) * (pick(flow) ?? 0);

/**
 * What went in and what the account made on top. `base` is the value the period starts
 * from: the opening balance for "since opening", zero for "all time".
 */
export const summarizeContributions = ({
  flows,
  value,
  base,
}: {
  flows: readonly InvestmentFlow[];
  value: number;
  base: number;
}): ContributionSummary => {
  const sum = (pick: (flow: InvestmentFlow) => number) => roundAmount(flows.reduce((total, flow) => total + pick(flow), 0));
  const estimatedNet = sum((flow) => signFlow(flow, (entry) => entry.estimate));
  const invested = base + estimatedNet;
  const gain = roundAmount(value - invested);
  return {
    deposits: sum((flow) => (flow.direction === 'in' ? (flow.amount ?? 0) : 0)),
    withdrawals: sum((flow) => (flow.direction === 'out' ? (flow.amount ?? 0) : 0)),
    net: sum((flow) => signFlow(flow, (entry) => entry.amount)),
    unknown: flows.filter((flow) => flow.amount === null).length,
    duplicates: flows.filter((flow) => flow.suspectedDuplicate).length,
    estimatedNet,
    gain,
    gainShare: invested > 0 ? gain / invested : null,
  };
};

/** Below this the walk back from the opening is rounding, not a missing flow. */
const HISTORY_GAP_TOLERANCE = 1;
/**
 * Market moves before the opening are not rows, so the walk back drifts by what the account
 * earned or lost; up to this share of the money that went in, the drift is growth, not a gap.
 */
const HISTORY_GROWTH_SHARE = 0.05;
/** A start larger than this share of the opening balance is more than rounding or a little growth. */
const UNEXPLAINED_START_SHARE = 0.25;

/**
 * Walks the flows back from the opening balance. An investment account never holds less than
 * nothing, so dipping below zero means withdrawals are missing; what is left before the first
 * flow is money no recorded flow explains. Rows carry dates, not times, so each day's flows net
 * out first: a withdrawal booked beside the deposit that funded it is not a dip.
 */
export const traceStartValue = ({
  flows,
  openingBalance,
}: {
  flows: readonly InvestmentFlow[];
  openingBalance: number;
}): { lowest: number; start: number | null } => {
  const days = Map.groupBy(
    flows.filter((entry) => entry.beforeOpening),
    (entry) => entry.date,
  );
  let balance = openingBalance;
  let lowest = openingBalance;
  for (const date of [...days.keys()].toSorted((left, right) => right.localeCompare(left))) {
    balance -= (days.get(date) ?? []).reduce((sum, flow) => sum + signFlow(flow, (entry) => entry.estimate), 0);
    lowest = Math.min(lowest, balance);
  }
  return { lowest, start: days.size === 0 ? null : roundAmount(balance) };
};

export const listAllTimeIssues = ({
  flows,
  openingBalance,
  summary,
}: {
  flows: readonly InvestmentFlow[];
  openingBalance: number;
  summary: Pick<ContributionSummary, 'unknown' | 'duplicates'>;
}): AllTimeIssue[] => {
  if (flows.length === 0) return ['no-flows'];
  const { lowest, start } = traceStartValue({ flows, openingBalance });
  const paidIn = flows.reduce((sum, flow) => sum + (flow.beforeOpening && flow.direction === 'in' ? (flow.estimate ?? 0) : 0), 0);
  const drift = Math.max(HISTORY_GAP_TOLERANCE, paidIn * HISTORY_GROWTH_SHARE);
  const issues: AllTimeIssue[] = [];
  if (lowest < -drift) issues.push('negative-history');
  else if (start !== null && start > Math.max(Math.abs(openingBalance) * UNEXPLAINED_START_SHARE, drift)) issues.push('unexplained-start');
  if (summary.unknown > 0) issues.push('unknown-credits');
  if (summary.duplicates > 0) issues.push('duplicates');
  return issues;
};

/** Net contributions up to each date, unknown credits estimated. */
export const traceContributions = ({
  flows,
  dates,
}: {
  flows: readonly InvestmentFlow[];
  dates: readonly IsoDate[];
}): number[] =>
  dates.map((date) =>
    roundAmount(
      flows.filter((flow) => flow.date <= date).reduce((total, flow) => total + signFlow(flow, (entry) => entry.estimate), 0),
    ),
  );

/**
 * A loan as the owner thinks of it: when the money left, how much went out in total (the
 * opening balance plus anything lent since) and how much came back. Every row on the
 * receivable counts, not only transfers: a shared bill booked on Splitwise is a debt too.
 * For a negative balance (the owner owes) the roles swap: borrowing pushes it down.
 */
export const describeLoan = ({
  account,
  transactions,
  today,
}: {
  account: Pick<LedgerAccount, 'id' | 'openingBalance' | 'openingDate'>;
  transactions: readonly LedgerTransaction[];
  today: IsoDate;
}) => {
  const effects = transactions.flatMap((transaction) =>
    listBalanceEffects(transaction)
      .filter((effect) => effect.accountId === account.id)
      .map((effect) => ({ date: transaction.date, delta: effect.delta })),
  );
  const current = effects.filter((effect) => effect.date >= account.openingDate);
  const balance = account.openingBalance + current.reduce((sum, effect) => sum + effect.delta, 0);
  const owedToMe = balance >= 0;
  const grows = (delta: number) => (owedToMe ? delta > 0 : delta < 0);
  const total = (pick: (delta: number) => boolean) =>
    roundAmount(current.filter((effect) => pick(effect.delta)).reduce((sum, effect) => sum + Math.abs(effect.delta), 0));
  const sent = effects.filter((effect) => grows(effect.delta)).map((effect) => effect.date).toSorted()[0];
  const sentDate = sent ?? account.openingDate;
  return {
    sentDate,
    sentRecorded: sent !== undefined,
    lent: roundAmount(Math.abs(account.openingBalance) + total(grows)),
    repaid: total((delta) => !grows(delta)),
    ageDays: countDaysBetween(sentDate, today),
  };
};

/** Funds the owner holds, by ticker; anything new falls back to what its name says. */
const FUND_CLASSES: Readonly<Record<string, AssetClass>> = {
  VGSH: 'bondEtf',
  VEA: 'stockEtf',
  VTI: 'stockEtf',
  VOO: 'stockEtf',
  QQQM: 'stockEtf',
};

/** Short-term Treasury funds move like cash: a few months of duration, no equity risk. */
const CASH_LIKE_FUNDS: ReadonlySet<string> = new Set(['VGSH']);

const CURRENCY_CODES: ReadonlySet<string> = new Set(['USD', 'EUR', 'GBP', 'UAH', 'CHF']);

/** Accounts that hold crypto without a statement to split them by asset. */
const WALLET_CLASSES: Readonly<Record<string, AssetClass>> = { walt: 'crypto', binance: 'crypto' };

/** Freedom24 suffixes the exchange («VOO.US»); IBKR and the positions table do not. */
export const stripExchange = (symbol: string) => symbol.replace(/\.(US|EU)$/u, '');

export const classifyAsset = ({
  symbol,
  name,
  broker,
}: {
  symbol: string;
  name: string | null;
  broker: BrokerReport['broker'];
}): { assetClass: AssetClass; cashLike: boolean } => {
  const ticker = stripExchange(symbol);
  const text = name ?? '';
  const cashLike = CASH_LIKE_FUNDS.has(ticker) || /short[- ]term treasur|t-bill/iu.test(text);
  if (broker === 'binance') return { assetClass: 'crypto', cashLike: false };
  if (CURRENCY_CODES.has(ticker)) return { assetClass: 'cash', cashLike: true };
  const mapped = FUND_CLASSES[ticker];
  if (mapped !== undefined) return { assetClass: mapped, cashLike };
  if (/\b(etf|fund|trust)\b/iu.test(text)) return { assetClass: /treasur|bond|aggregate/iu.test(text) ? 'bondEtf' : 'stockEtf', cashLike };
  return { assetClass: 'stock', cashLike: false };
};

/** Below this share of the account a gap between its balance and its listed positions is rounding. */
const REMAINDER_SHARE = 0.01;

/**
 * An account's positions from its latest statement, in EUR at today's rate. What the balance
 * holds beyond the listed positions becomes one more line, so the lines add up to the account.
 */
export const listPositions = ({
  account,
  eur,
  report,
  toEur,
}: {
  account: Pick<LedgerAccount, 'id' | 'currency'> & { balance: number };
  /** The account's balance in EUR today. */
  eur: number;
  report: Pick<BrokerReport, 'broker' | 'holdings'> | null;
  toEur: (amount: number, currency: string) => number | null;
}): Omit<Position, 'weight'>[] => {
  if (report === null) {
    return [
      {
        key: `${account.id}:account`,
        symbol: '',
        name: null,
        assetClass: WALLET_CLASSES[account.id] ?? 'stock',
        cashLike: false,
        accountId: account.id,
        remainder: 'whole-account',
        quantity: null,
        price: null,
        currency: account.currency,
        value: account.balance,
        eur,
        cost: null,
        costEur: null,
        gainEur: null,
      },
    ];
  }
  const listed = report.holdings.flatMap((holding: Holding): Omit<Position, 'weight'>[] => {
    const value = holding.value === null ? null : toEur(holding.value, holding.currency);
    if (holding.value === null || value === null) return [];
    const costEur = holding.cost === null ? null : toEur(holding.cost, holding.currency);
    return [
      {
        key: `${account.id}:${holding.symbol}`,
        symbol: stripExchange(holding.symbol),
        name: holding.name,
        ...classifyAsset({ symbol: holding.symbol, name: holding.name, broker: report.broker }),
        accountId: account.id,
        remainder: null,
        quantity: holding.quantity,
        price: holding.price,
        currency: holding.currency,
        value: holding.value,
        eur: value,
        cost: holding.cost,
        costEur,
        gainEur: costEur === null ? null : value - costEur,
      },
    ];
  });
  const restEur = eur - listed.reduce((sum, position) => sum + position.eur, 0);
  const listsCash = listed.some((position) => position.assetClass === 'cash');
  if (listsCash || eur === 0 || restEur < Math.abs(eur) * REMAINDER_SHARE) return listed;
  const tokens = report.broker === 'binance';
  return [
    ...listed,
    {
      key: `${account.id}:rest`,
      symbol: tokens ? '' : account.currency,
      name: null,
      assetClass: tokens ? 'crypto' : 'cash',
      cashLike: !tokens,
      accountId: account.id,
      remainder: tokens ? 'tokens' : 'cash',
      quantity: null,
      price: null,
      currency: account.currency,
      value: roundAmount((restEur / eur) * account.balance),
      eur: restEur,
      cost: null,
      costEur: null,
      gainEur: null,
    },
  ];
};

/** Weights over the whole portfolio and the split by asset class, largest first. */
export const weighPositions = (
  positions: readonly Omit<Position, 'weight'>[],
): { positions: Position[]; assetClasses: AssetClassShare[] } => {
  const total = positions.reduce((sum, position) => sum + position.eur, 0);
  const share = (value: number) => (total > 0 ? value / total : 0);
  const byClass = Map.groupBy(positions, (position) => position.assetClass);
  return {
    positions: positions
      .map((position) => ({ ...position, weight: share(position.eur) }))
      .toSorted((left, right) => right.eur - left.eur),
    assetClasses: [...byClass]
      .map(([assetClass, members]) => {
        const eur = members.reduce((sum, position) => sum + position.eur, 0);
        return { assetClass, eur, weight: share(eur) };
      })
      .toSorted((left, right) => right.eur - left.eur),
  };
};

const STABLECOINS: ReadonlySet<string> = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'DAI']);

/**
 * Securities whose quote currency hides what they move with: VEA is shares of Europe and Japan
 * bought in dollars, and Novo Nordisk's dollar receipt follows the krone, which is pegged to the euro.
 */
const LOOK_THROUGH: Readonly<Record<string, ExposureCurrency>> = { VEA: 'other', NVO: 'EUR' };

const findQuoteExposure = (currency: string): ExposureCurrency => {
  if (currency === 'USD' || STABLECOINS.has(currency)) return 'USD';
  return currency === 'EUR' ? 'EUR' : 'other';
};

const findExposure = (position: Position): { currency: ExposureCurrency; lookedThrough: boolean } => {
  const mapped = LOOK_THROUGH[position.symbol];
  if (mapped !== undefined) return { currency: mapped, lookedThrough: true };
  if (position.remainder === 'tokens') return { currency: 'other', lookedThrough: false };
  if (position.assetClass === 'crypto' && position.remainder === null && !STABLECOINS.has(position.symbol)) {
    return { currency: 'other', lookedThrough: false };
  }
  return { currency: findQuoteExposure(position.currency), lookedThrough: false };
};

/** The portfolio by the currency it really moves with, largest first. */
export const summarizeCurrencyExposure = (positions: readonly Position[]): CurrencyExposure[] => {
  const total = positions.reduce((sum, position) => sum + position.eur, 0);
  const groups = Map.groupBy(
    positions.map((position) => ({ position, ...findExposure(position) })),
    (entry) => entry.currency,
  );
  return [...groups]
    .map(([currency, entries]) => {
      const eur = entries.reduce((sum, entry) => sum + entry.position.eur, 0);
      return {
        currency,
        eur,
        weight: total > 0 ? eur / total : 0,
        lookThrough: entries.filter((entry) => entry.lookedThrough).map((entry) => entry.position.symbol),
      };
    })
    .toSorted((left, right) => right.eur - left.eur);
};
