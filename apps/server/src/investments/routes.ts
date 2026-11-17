import {
  computeBalanceHistory,
  convertToEur,
  countDaysBetween,
  computePeriodReturn,
  computeXirr,
  type DatedAmount,
  type DatedPrice,
  describeLoan,
  listAllTimeIssues,
  listFlows,
  listMonthEnds,
  listMonthsBetween,
  listPositions,
  measureCurrencyEffect,
  shiftDate,
  simulateBenchmark,
  splitReturn,
  stripExchange,
  summarizeBrokerResult,
  summarizeContributions,
  summarizeCurrencyExposure,
  summarizeIncomeByYear,
  sumTradeCommissions,
  toAccountCurrency,
  toMonth,
  traceContributions,
  tracePortfolio,
  traceStartValue,
  weighPositions,
} from '@hroshi/domain';
import {
  type AccountBalance,
  AllocationTargetListSchema,
  AssetClassSchema,
  type Benchmark,
  type BrokerReport,
  ContributionGapParamsSchema,
  type ContributionGaps,
  ContributionGapsSchema,
  CurrencySchema,
  type InvestmentFlow,
  type InvestmentAccount,
  InvestmentsSchema,
  type IsoDate,
  type Loan,
  type PeriodReturn,
  type PortfolioHistory,
  type Position,
  PositionDetailSchema,
  type PositionDetail,
  PositionParamsSchema,
  type ResidualCause,
  type ResultBreakdown,
  type ReturnPeriod,
  SaveAllocationTargetsSchema,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { describeAccounts } from '../accounts/routes.ts';
import type { Db } from '../db.ts';
import { findCurrentMonth, findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { loadBrokerReports } from '../brokers/reports.ts';
import { notFound } from '../http-errors.ts';
import { type Ledger, loadLedger, toTransactionRow } from '../ledger.ts';
import { toNumber } from '../mappers.ts';
import { BENCHMARK, loadBenchmarkPrices } from '../prices/benchmark.ts';

const SERIES_MONTHS = 24;

const dropLeadingZeros = <T extends { value: number }>(points: readonly T[]): T[] => {
  const first = points.findIndex((point) => point.value !== 0);
  return first === -1 ? [] : points.slice(first);
};

const describeHolding = ({
  ledger,
  account,
  today,
  report,
}: {
  ledger: Ledger;
  account: AccountBalance;
  today: string;
  report: BrokerReport | undefined;
}): Omit<InvestmentAccount, 'share'> => {
  const flows = listFlows({ account, transactions: ledger.transactions, fx: ledger.fx });
  const brokerFlows = report === undefined ? [] : toAccountCurrency({ flows: report.cashFlows, currency: account.currency, fx: ledger.fx });
  const hasDeposits = brokerFlows.some((flow) => flow.kind === 'deposit');
  const allTime = summarizeContributions({ flows, value: account.balance, base: 0 });
  const valuations = ledger.transactions
    .filter((transaction) => transaction.type === 'valuation' && transaction.accountId === account.id)
    .map((transaction) => ({
      id: transaction.id,
      date: transaction.date,
      amount: transaction.amount,
      note: transaction.note,
      source: transaction.source,
    }))
    .toReversed();
  const ends = listMonthEnds({ until: findCurrentMonth(), count: SERIES_MONTHS, today });
  // A broker's own deposit records are complete; the ledger's transfers may miss some.
  const contributed = hasDeposits
    ? ends.map(({ date }) =>
        brokerFlows
          .filter((flow) => (flow.kind === 'deposit' || flow.kind === 'withdrawal') && flow.date <= date)
          .reduce((sum, flow) => sum + flow.converted, 0),
      )
    : traceContributions({ flows, dates: ends.map((end) => end.date) });
  // Only these values are known: the opening, each valuation, today. Between them the market is not.
  const known = [
    { date: account.openingDate, kind: 'opening' as const },
    ...valuations.toReversed().map((valuation) => ({ date: valuation.date, kind: 'valuation' as const })),
    { date: today, kind: 'now' as const },
  ];
  const knownValues =
    computeBalanceHistory({ accounts: [account], transactions: ledger.transactions, dates: known.map((point) => point.date) }).get(
      account.id,
    ) ?? [];

  return {
    account,
    eur: ledger.fx.toEur(account.balance, account.currency, today),
    lastValuation: valuations[0] ?? null,
    sinceOpening: summarizeContributions({
      flows: flows.filter((flow) => !flow.beforeOpening),
      value: account.balance,
      base: account.openingBalance,
    }),
    allTime,
    allTimeIssues: listAllTimeIssues({ flows, openingBalance: account.openingBalance, summary: allTime }),
    startValue: traceStartValue({ flows, openingBalance: account.openingBalance }).start,
    valuations,
    flows: flows.toReversed(),
    contributions: ends.map(({ month, date }, index) => ({ month, date, contributed: contributed[index] ?? 0 })),
    values: [
      // An account opened at the broker before the first deposit reports zeros; the chart starts with the money.
      ...dropLeadingZeros(report?.navHistory ?? []).map((point) => ({ ...point, kind: 'broker' as const })),
      ...known.map((point, index) => ({ ...point, value: knownValues[index] ?? account.balance })),
    ].toSorted((left, right) => left.date.localeCompare(right.date)),
    report:
      report === undefined
        ? null
        : {
            broker: report.broker,
            asOf: report.asOf,
            file: report.file,
            currency: report.currency,
            netAssets: report.netAssets,
            holdings: report.holdings,
            navHistory: report.navHistory,
          },
    broker: hasDeposits ? summarizeBrokerResult({ flows: brokerFlows, value: account.balance, today }) : null,
    brokerFlows: brokerFlows.map(({ converted, ...flow }) => ({ ...flow, amount: converted, currency: account.currency })).toReversed(),
    trades:
      report === undefined || report.trades === null
        ? null
        : report.trades.toSorted((left, right) => right.date.localeCompare(left.date)),
  };
};

type Described = Omit<InvestmentAccount, 'share'>;

const isExternal = (flow: { kind: string }) => flow.kind === 'deposit' || flow.kind === 'withdrawal';

/**
 * The accounts whose every deposit is known from the broker; the others would show money that
 * went in as a loss (Binance's withdrawals are not all recorded).
 */
const modelPortfolio = ({
  holdings,
  reports,
  ledger,
}: {
  holdings: readonly Described[];
  reports: ReadonlyMap<string, BrokerReport>;
  ledger: Ledger;
}) => {
  const included = holdings.filter((holding) => holding.broker !== null);
  const accounts = included.map((holding) => ({
    currency: holding.account.currency,
    flows: holding.brokerFlows.filter(isExternal).map((flow) => ({ date: flow.date, amount: flow.amount })),
    nav: dropLeadingZeros(reports.get(holding.account.id)?.navHistory ?? []),
    value: holding.account.balance,
    xirr: holding.broker?.xirr ?? null,
  }));
  // Each deposit in euros on its own day: what the benchmark would have bought with it.
  const eurFlows: DatedAmount[] = accounts
    .flatMap((account) => account.flows.map((flow) => ({ date: flow.date, amount: ledger.fx.toEur(flow.amount, account.currency, flow.date) ?? 0 })))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  return { included, accounts, eurFlows };
};

type PortfolioModel = ReturnType<typeof modelPortfolio>;

const tracePortfolioHistory = ({
  model,
  holdings,
  ledger,
  prices,
  today,
}: {
  model: PortfolioModel;
  holdings: readonly Described[];
  ledger: Ledger;
  prices: readonly DatedPrice[];
  today: string;
}): PortfolioHistory => {
  const { included, accounts, eurFlows } = model;
  const first = eurFlows[0]?.date;
  const ends =
    first === undefined
      ? []
      : listMonthEnds({ until: toMonth(today), count: listMonthsBetween({ from: toMonth(first), to: toMonth(today) }).length, today });
  const dates = [...new Set([...(first === undefined ? [] : [first]), ...ends.map((end) => end.date)])].toSorted();
  const benchmark = simulateBenchmark({ flows: eurFlows, prices, dates });
  return {
    accountIds: included.map((holding) => holding.account.id),
    modelled: included.flatMap((holding, index) => {
      const xirr = holding.broker?.xirr ?? null;
      return (accounts[index]?.nav.length ?? 0) === 0 && xirr !== null ? [{ accountId: holding.account.id, xirr }] : [];
    }),
    excluded: holdings
      .filter((holding) => holding.broker === null)
      .map((holding) => ({
        accountId: holding.account.id,
        reason: holding.allTimeIssues.includes('no-flows') ? ('no-flows' as const) : ('incomplete-flows' as const),
      })),
    points: tracePortfolio({ accounts, dates, today, fx: ledger.fx }).map((point, index) => ({
      ...point,
      benchmarkEur: benchmark[index] ?? null,
    })),
  };
};

const summarizeBenchmark = ({
  model,
  prices,
  today,
}: {
  model: PortfolioModel;
  prices: readonly DatedPrice[];
  today: IsoDate;
}): Benchmark | null => {
  const [first] = prices;
  const last = prices.at(-1);
  const [valueEur] = simulateBenchmark({ flows: model.eurFlows, prices, dates: [today] });
  if (first === undefined || last === undefined || valueEur === null || valueEur === undefined) return null;
  return {
    symbol: BENCHMARK.symbol,
    name: BENCHMARK.name,
    pricesFrom: first.date,
    pricesUntil: last.date,
    valueEur,
    xirr: computeXirr([...model.eurFlows.map((flow) => ({ date: flow.date, amount: -flow.amount })), { date: today, amount: valueEur }]),
  };
};

/** The day before each span starts: its value then is the money already at work. */
const findPeriodStart = ({ period, today, firstFlow }: { period: ReturnPeriod; today: IsoDate; firstFlow: IsoDate }): IsoDate => {
  switch (period) {
    case 'ytd':
      return `${Number(today.slice(0, 4)) - 1}-12-31`;
    case '12m':
      return `${Number(today.slice(0, 4)) - 1}${today.slice(4)}`;
    case 'all':
      return shiftDate(firstFlow, -1);
  }
};

const PERIODS: readonly ReturnPeriod[] = ['ytd', '12m', 'all'];

/** The portfolio and the benchmark over the same spans with the same deposits, so the two read side by side. */
const listPeriodReturns = ({
  model,
  ledger,
  prices,
  today,
}: {
  model: PortfolioModel;
  ledger: Ledger;
  prices: readonly DatedPrice[];
  today: IsoDate;
}): PeriodReturn[] => {
  const firstFlow = model.eurFlows[0]?.date;
  if (firstFlow === undefined) return [];
  const [end] = tracePortfolio({ accounts: model.accounts, dates: [today], today, fx: ledger.fx });
  const [benchmarkEnd] = simulateBenchmark({ flows: model.eurFlows, prices, dates: [today] });
  return PERIODS.map((period) => {
    const from = findPeriodStart({ period, today, firstFlow });
    const base = { period, from, to: today };
    if (period !== 'all' && firstFlow > from) return { ...base, portfolio: null, benchmark: null, missing: 'short-history', estimated: false };
    const [start] = tracePortfolio({ accounts: model.accounts, dates: [from], today, fx: ledger.fx });
    const [benchmarkStart] = simulateBenchmark({ flows: model.eurFlows, prices, dates: [from] });
    const flows = model.eurFlows;
    const portfolio =
      start === undefined || end === undefined
        ? null
        : computePeriodReturn({ from, to: today, startValue: start.valueEur, endValue: end.valueEur, flows });
    const priced = (prices[0]?.date ?? today) <= (period === 'all' ? firstFlow : from);
    const benchmark =
      !priced || benchmarkStart === null || benchmarkStart === undefined || benchmarkEnd === null || benchmarkEnd === undefined
        ? null
        : computePeriodReturn({ from, to: today, startValue: benchmarkStart, endValue: benchmarkEnd, flows });
    return { ...base, portfolio, benchmark, missing: priced ? null : 'no-prices', estimated: start?.estimated ?? false };
  });
};

/** IBKR's cost basis already holds its trade commissions; Freedom24's purchase cost does not. */
const COMMISSION_IN_COST: ReadonlySet<BrokerReport['broker']> = new Set(['ibkr']);

/** The statement sections whose absence leaves part of a broker's result unexplained. */
const listResidualCauses = (report: BrokerReport | undefined): ResidualCause[] => {
  if (report?.broker !== 'ibkr') return [];
  const absent: readonly [ResidualCause, boolean][] = [
    ['trades', report.trades === null],
    ['nav-change', report.navChange === null],
  ];
  return absent.flatMap(([cause, missing]) => (missing ? [cause] : []));
};

/**
 * One broker's result taken apart in its own currency, then in EUR at today's rate: the positions'
 * gain over the broker's cost, sales, income and costs the statements book, commissions outside the
 * cost, and the currency inside the account. What remains is the broker's own residual.
 */
const breakDownBroker = ({
  holding,
  positions,
  report,
  ledger,
  today,
}: {
  holding: Described;
  positions: readonly Position[];
  report: BrokerReport | undefined;
  ledger: Ledger;
  today: IsoDate;
}) => {
  const { currency } = holding.account;
  const toEur = (amount: number) => ledger.fx.toEur(amount, currency, today) ?? 0;
  const own = positions.filter((position) => position.accountId === holding.account.id);
  const positionsGainEur = own.reduce((sum, position) => sum + (position.gainEur ?? 0), 0);
  const realizedEur =
    report?.realized === undefined || report.realized === null
      ? null
      : report.realized.reduce((sum, trade) => sum + (toEurByCode({ ledger, amount: trade.amount, code: trade.currency, date: today }) ?? 0), 0);
  const navChange = report?.navChange ?? null;
  // IBKR's own NAV walk is exact where it exists; otherwise the effect is rebuilt from the cash records and exchanges.
  const commissions =
    navChange !== null
      ? navChange.forexCommissions
      : -sumTradeCommissions({
          currency,
          trades: report?.trades ?? [],
          exchangesOnly: report !== undefined && COMMISSION_IN_COST.has(report.broker),
          fx: ledger.fx,
        });
  const effect =
    navChange !== null
      ? { translation: navChange.fxTranslation + navChange.netFxTrading, exchange: 0 }
      : measureCurrencyEffect({ currency, flows: report?.cashFlows ?? [], trades: report?.trades ?? null, fx: ledger.fx, today });
  // The broker values foreign positions at its own rate; the positions here use today's NBU rate.
  const brokerRateEur = (holding.eur ?? 0) - own.reduce((sum, position) => sum + position.eur, 0);
  const terms = {
    positionsGainEur,
    realizedEur,
    dividendsEur: toEur(holding.broker?.dividends ?? 0),
    taxesEur: toEur(holding.broker?.taxes ?? 0),
    feesEur: toEur(holding.broker?.fees ?? 0),
    interestEur: toEur(holding.broker?.interest ?? 0),
    commissionsEur: toEur(commissions),
    fxEur: toEur(effect.translation + effect.exchange) + brokerRateEur,
  };
  const brokerGainEur = toEur(holding.broker?.gain ?? 0);
  const itemised =
    terms.positionsGainEur +
    (terms.realizedEur ?? 0) +
    terms.dividendsEur +
    terms.taxesEur +
    terms.feesEur +
    terms.interestEur +
    terms.commissionsEur +
    terms.fxEur;
  return { ...terms, brokerGainEur, residualEur: brokerGainEur - itemised, missing: listResidualCauses(report) };
};

/**
 * The broker result taken apart across brokers, every term summed in EUR at today's rate; the
 * residual stays per broker, with the statement sections that would explain it.
 */
const breakDownResult = ({
  holdings,
  positions,
  reports,
  ledger,
  today,
}: {
  holdings: readonly Described[];
  positions: readonly Position[];
  reports: ReadonlyMap<string, BrokerReport>;
  ledger: Ledger;
  today: IsoDate;
}): ResultBreakdown => {
  const withBroker = holdings.filter((holding) => holding.broker !== null);
  const parts = withBroker.map((holding) => ({
    accountId: holding.account.id,
    ...breakDownBroker({ holding, positions, report: reports.get(holding.account.id), ledger, today }),
  }));
  const sum = (pick: (part: (typeof parts)[number]) => number) => parts.reduce((total, part) => total + pick(part), 0);
  const sales = parts.flatMap((part) => (part.realizedEur === null ? [] : [part.realizedEur]));
  const openings = holdings.map((holding) => holding.account.openingDate).toSorted();
  return {
    positionsGainEur: sum((part) => part.positionsGainEur),
    realizedEur: sales.length === 0 ? null : sales.reduce((total, value) => total + value, 0),
    dividendsEur: sum((part) => part.dividendsEur),
    taxesEur: sum((part) => part.taxesEur),
    feesEur: sum((part) => part.feesEur),
    interestEur: sum((part) => part.interestEur),
    commissionsEur: sum((part) => part.commissionsEur),
    fxEur: sum((part) => part.fxEur),
    otherEur: sum((part) => part.residualEur),
    residual: parts.map((part) => ({ accountId: part.accountId, eur: part.residualEur, missing: part.missing })),
    brokerGainEur: sum((part) => part.brokerGainEur),
    brokerFrom: withBroker.flatMap((holding) => (holding.broker?.firstDeposit ? [holding.broker.firstDeposit] : [])).toSorted()[0] ?? null,
    openingFrom: openings[0] ?? null,
    openingTo: openings.at(-1) ?? null,
  };
};

const toEurByCode = ({ ledger, amount, code, date }: { ledger: Ledger; amount: number; code: string; date: IsoDate }) => {
  const currency = CurrencySchema.safeParse(code);
  return currency.success ? ledger.fx.toEur(amount, currency.data, date) : null;
};

/** Every position across brokers, weighted over the whole portfolio, valued in EUR today. */
const weighPortfolio = ({
  ledger,
  reports,
  accounts,
  today,
}: {
  ledger: Ledger;
  reports: ReadonlyMap<string, BrokerReport>;
  accounts: readonly AccountBalance[];
  today: IsoDate;
}) =>
  weighPositions(
    accounts
      .filter((account) => account.kind === 'investment')
      .flatMap((account) =>
        listPositions({
          account,
          eur: ledger.fx.toEur(account.balance, account.currency, today) ?? 0,
          report: reports.get(account.id) ?? null,
          toEur: (amount, code) => toEurByCode({ ledger, amount, code, date: today }),
        }),
      ),
  );

/** A stored class the contract no longer knows (renamed in code) is left out rather than failing the page. */
const loadTargets = async (db: Db) =>
  (await db.allocationTarget.findMany()).flatMap((row) => {
    const assetClass = AssetClassSchema.safeParse(row.assetClass);
    return assetClass.success ? [{ assetClass: assetClass.data, share: toNumber(row.share) }] : [];
  });

/** Everything the stored statements say about one position; no daily price history is kept for single securities. */
const describePosition = ({
  position,
  report,
  ledger,
}: {
  position: Position;
  report: BrokerReport | null;
  ledger: Ledger;
}): PositionDetail => {
  const holding = report?.holdings.find((entry) => `${position.accountId}:${entry.symbol}` === position.key);
  const cost = holding?.cost ?? null;
  const isThis = (symbol: string | null) => position.remainder === null && symbol !== null && stripExchange(symbol) === position.symbol;
  const income = (report?.cashFlows ?? []).flatMap((flow) =>
    (flow.kind === 'dividend' || flow.kind === 'tax') && isThis(flow.symbol)
      ? [{ date: flow.date, kind: flow.kind, amount: flow.amount, currency: flow.currency, eur: toEurByCode({ ledger, amount: flow.amount, code: flow.currency, date: flow.date }) }]
      : [],
  );
  const own = (report?.trades ?? [])
    .filter((trade) => isThis(trade.symbol))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const trades =
    report === null || report.trades === null
      ? null
      : own.map((trade, index) => ({
          ...trade,
          holding: own.slice(0, index + 1).reduce((sum, entry) => sum + (entry.side === 'buy' ? entry.quantity : -entry.quantity), 0),
          eur: toEurByCode({ ledger, amount: trade.amount, code: trade.currency, date: trade.date }),
        }));
  const sumIncome = (kind: 'dividend' | 'tax') =>
    income.filter((entry) => entry.kind === kind).reduce((sum, entry) => sum + (entry.eur ?? 0), 0);
  return {
    position,
    broker: report?.broker ?? null,
    asOf: report?.asOf ?? null,
    cost,
    gain: cost === null ? null : position.value - cost,
    averageCost: cost !== null && position.quantity !== null && position.quantity !== 0 ? cost / position.quantity : null,
    income: income.toReversed(),
    dividendsEur: sumIncome('dividend'),
    withholdingEur: -sumIncome('tax'),
    trades: trades === null ? null : trades.toReversed(),
    missing: [
      ...(trades === null ? (['trades'] as const) : []),
      ...(cost === null ? (['cost'] as const) : []),
      'price-history' as const,
      ...(report === null || report.cashFlows.length === 0 ? (['income'] as const) : []),
    ],
  };
};

/** A bank transfer and the broker's record of it land within these days of each other. */
const MATCH_WINDOW_DAYS = 10;
/** Share two amounts may differ by and still be one transfer: the bank's and the broker's rates, a sender's fee. */
const MATCH_AMOUNT_SHARE = 0.03;
const CANDIDATE_LIMIT = 4;

const isNear = ({ value, target, share }: { value: number; target: number; share: number }) =>
  Math.abs(Math.abs(value) - Math.abs(target)) <= Math.max(0.5, Math.abs(target) * share);

type ExternalFlow = BrokerReport['cashFlows'][number] & { converted: number };

/** The tracker transfer that is this broker deposit: same direction, a few days apart, the same money in either currency. */
const isSameMoney = ({ flow, tracked }: { flow: ExternalFlow; tracked: InvestmentFlow }) => {
  if ((flow.kind === 'deposit') !== (tracked.direction === 'in')) return false;
  if (Math.abs(countDaysBetween(tracked.date, flow.date)) > MATCH_WINDOW_DAYS) return false;
  const sent = flow.original ?? { amount: flow.amount, currency: flow.currency };
  if (tracked.counterCurrency === sent.currency && isNear({ value: tracked.counterAmount, target: sent.amount, share: MATCH_AMOUNT_SHARE })) return true;
  const credited = tracked.amount ?? tracked.estimate;
  return credited !== null && isNear({ value: credited, target: flow.converted, share: MATCH_AMOUNT_SHARE });
};

/** The same amount in the currency the money was sent in ranks above a row that is only near it in euros. */
const rankCandidate = ({ transaction, flow }: { transaction: Ledger['transactions'][number]; flow: ExternalFlow }) => {
  const sent = flow.original ?? { amount: flow.amount, currency: flow.currency };
  return transaction.currency === sent.currency && isNear({ value: transaction.amount, target: sent.amount, share: MATCH_AMOUNT_SHARE }) ? 0 : 1;
};

/**
 * Rows that could be the bank side of a broker deposit nobody booked as a transfer: an expense or a
 * transfer elsewhere, of about the same money in euros, from a few days before to a few days after.
 */
const findCandidates = ({ flow, account, ledger }: { flow: ExternalFlow; account: AccountBalance; ledger: Ledger }) => {
  const eur = ledger.fx.toEur(flow.converted, account.currency, flow.date);
  if (eur === null) return [];
  const types: ReadonlySet<string> = new Set(flow.kind === 'deposit' ? ['expense', 'transfer'] : ['income', 'transfer']);
  return ledger.transactions
    .filter(
      (transaction) =>
        types.has(transaction.type) &&
        transaction.accountId !== account.id &&
        transaction.toAccountId !== account.id &&
        countDaysBetween(flow.date, transaction.date) <= 3 &&
        countDaysBetween(transaction.date, flow.date) <= MATCH_WINDOW_DAYS,
    )
    .flatMap((transaction) => {
      const rowEur = convertToEur({ transaction, fx: ledger.fx });
      return rowEur !== null && isNear({ value: rowEur, target: eur, share: MATCH_AMOUNT_SHARE }) ? [transaction] : [];
    })
    .toSorted(
      (left, right) =>
        rankCandidate({ transaction: left, flow }) - rankCandidate({ transaction: right, flow }) ||
        Math.abs(countDaysBetween(left.date, flow.date)) - Math.abs(countDaysBetween(right.date, flow.date)),
    )
    .slice(0, CANDIDATE_LIMIT)
    .map((transaction) => toTransactionRow(ledger, transaction));
};

const signed = (amount: number, outgoing: boolean) => (outgoing ? -Math.abs(amount) : Math.abs(amount));

/** The broker's deposits and the tracker's transfers side by side: what each has that the other lacks. */
const describeGaps = ({ ledger, account, report }: { ledger: Ledger; account: AccountBalance; report: BrokerReport | undefined }): ContributionGaps => {
  const external = toAccountCurrency({
    flows: (report?.cashFlows ?? []).filter((flow) => flow.kind === 'deposit' || flow.kind === 'withdrawal'),
    currency: account.currency,
    fx: ledger.fx,
  }).toSorted((left, right) => left.date.localeCompare(right.date));
  const tracked = listFlows({ account, transactions: ledger.transactions, fx: ledger.fx });
  const used = new Set<string>();
  const missing = external.flatMap((flow) => {
    const match = tracked
      .filter((entry) => !used.has(entry.id) && isSameMoney({ flow, tracked: entry }))
      .toSorted((left, right) => Math.abs(countDaysBetween(left.date, flow.date)) - Math.abs(countDaysBetween(right.date, flow.date)))[0];
    if (match !== undefined) {
      used.add(match.id);
      return [];
    }
    const { converted, ...rest } = flow;
    return [{ flow: { ...rest, amount: converted, currency: account.currency }, candidates: findCandidates({ flow, account, ledger }) }];
  });
  return {
    accountId: account.id,
    currency: account.currency,
    brokerNet: external.reduce((sum, flow) => sum + signed(flow.converted, flow.kind === 'withdrawal'), 0),
    trackerNet: tracked.reduce((sum, entry) => sum + signed(entry.amount ?? entry.estimate ?? 0, entry.direction === 'out'), 0),
    matched: used.size,
    missing: missing.toReversed(),
    extra: tracked.filter((entry) => !used.has(entry.id)).toReversed(),
  };
};

const describeReceivable = ({ ledger, account, today }: { ledger: Ledger; account: AccountBalance; today: string }): Loan => ({
  account,
  eur: ledger.fx.toEur(account.balance, account.currency, today),
  ...describeLoan({ account, transactions: ledger.transactions, today }),
  rows: ledger.transactions
    .filter((transaction) => transaction.accountId === account.id || transaction.toAccountId === account.id)
    .map((transaction) => toTransactionRow(ledger, transaction))
    .toReversed(),
});

export const investmentRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/investments', { schema: { response: { 200: InvestmentsSchema } } }, async () => {
    const today = findToday();
    const [ledger, reports, prices, targets] = await Promise.all([
      loadLedger(prisma),
      loadBrokerReports(),
      loadBenchmarkPrices({ db: prisma, today }),
      loadTargets(prisma),
    ]);
    const accounts = describeAccounts(ledger).filter((account) => !account.archived);

    const holdings = accounts
      .filter((account) => account.kind === 'investment')
      .map((account) => describeHolding({ ledger, account, today, report: reports.get(account.id) }));
    const valueEur = holdings.reduce((sum, holding) => sum + (holding.eur ?? 0), 0);
    const contributedEur = holdings.reduce(
      (sum, holding) => sum + (ledger.fx.toEur(holding.allTime.estimatedNet, holding.account.currency, today) ?? 0),
      0,
    );
    const receivables = accounts
      .filter((account) => account.kind === 'receivable')
      .map((account) => describeReceivable({ ledger, account, today }));

    const toEurToday = (amount: number, currency: AccountBalance['currency']) => ledger.fx.toEur(amount, currency, today) ?? 0;
    const withBroker = holdings.filter((holding) => holding.broker !== null);
    // One money-weighted return in EUR: each deposit at its day's rate, today's values at today's.
    const brokerXirr = computeXirr([
      ...withBroker.flatMap((holding) =>
        holding.brokerFlows
          .filter(isExternal)
          .map((flow) => ({ date: flow.date, amount: -(ledger.fx.toEur(flow.amount, holding.account.currency, flow.date) ?? 0) })),
      ),
      { date: today, amount: withBroker.reduce((sum, holding) => sum + (holding.eur ?? 0), 0) },
    ]);
    // The same flows in the accounts' own currency: the market alone, before the dollar's move against the euro.
    const [localCurrency, ...otherCurrencies] = [...new Set(withBroker.map((holding) => holding.account.currency))];
    const localXirr =
      localCurrency === undefined || otherCurrencies.length > 0
        ? null
        : computeXirr([
            ...withBroker.flatMap((holding) =>
              holding.brokerFlows.filter(isExternal).map((flow) => ({ date: flow.date, amount: -flow.amount })),
            ),
            { date: today, amount: withBroker.reduce((sum, holding) => sum + holding.account.balance, 0) },
          ]);
    const { positions, assetClasses } = weighPortfolio({ ledger, reports, accounts, today });
    const model = modelPortfolio({ holdings, reports, ledger });
    const income = withBroker.flatMap((holding) => {
      const report = reports.get(holding.account.id);
      if (report === undefined) return [];
      const { currency } = holding.account;
      const convert = (flows: BrokerReport['cashFlows']) => toAccountCurrency({ flows, currency, fx: ledger.fx });
      return summarizeIncomeByYear({
        accountId: holding.account.id,
        currency,
        flows: convert(report.cashFlows),
        realized:
          report.realized === null
            ? null
            : convert(
                report.realized.map((trade) => ({
                  date: trade.date,
                  kind: 'other',
                  amount: trade.amount,
                  currency: trade.currency,
                  note: trade.symbol,
                  symbol: trade.symbol,
                  original: null,
                })),
              ),
        fx: ledger.fx,
      });
    });
    return {
      valueEur,
      brokerGainEur: withBroker.reduce((sum, holding) => sum + toEurToday(holding.broker?.gain ?? 0, holding.account.currency), 0),
      brokerAccounts: withBroker.map((holding) => holding.account.name),
      brokerXirr,
      returns: {
        eur: brokerXirr,
        local: localXirr,
        localCurrency: otherCurrencies.length === 0 ? (localCurrency ?? null) : null,
        fx: splitReturn({ eur: brokerXirr, local: localXirr }),
      },
      benchmark: summarizeBenchmark({ model, prices, today }),
      periodReturns: listPeriodReturns({ model, ledger, prices, today }),
      breakdown: breakDownResult({ holdings, positions, reports, ledger, today }),
      currencyExposure: summarizeCurrencyExposure(positions),
      positions,
      assetClasses,
      targets,
      history: tracePortfolioHistory({ model, holdings, ledger, prices, today }),
      income: income.toSorted((left, right) => right.year - left.year || left.accountId.localeCompare(right.accountId)),
      sinceOpeningGainEur: holdings.reduce(
        (sum, holding) => sum + (ledger.fx.toEur(holding.sinceOpening.gain, holding.account.currency, today) ?? 0),
        0,
      ),
      contributedEur,
      gainEur: valueEur - contributedEur,
      accounts: holdings
        .map((holding) => ({ ...holding, share: valueEur > 0 ? (holding.eur ?? 0) / valueEur : 0 }))
        .toSorted((left, right) => (right.eur ?? 0) - (left.eur ?? 0)),
      loans: receivables.filter((loan) => loan.account.balance >= 0),
      debts: receivables.filter((loan) => loan.account.balance < 0),
    };
  });

  app.put(
    '/investments/targets',
    { schema: { body: SaveAllocationTargetsSchema, response: { 200: AllocationTargetListSchema } } },
    async (request) => {
      const { targets } = request.body;
      await prisma.$transaction([
        prisma.allocationTarget.deleteMany(),
        prisma.allocationTarget.createMany({ data: targets.filter((target) => target.share > 0) }),
      ]);
      return loadTargets(prisma);
    },
  );

  app.get(
    '/investments/gaps/:accountId',
    { schema: { params: ContributionGapParamsSchema, response: { 200: ContributionGapsSchema } } },
    async (request) => {
      const [ledger, reports] = await Promise.all([loadLedger(prisma), loadBrokerReports()]);
      const account = describeAccounts(ledger).find((entry) => entry.id === request.params.accountId && entry.kind === 'investment');
      if (account === undefined) throw notFound(`No investment account ${request.params.accountId}`);
      return describeGaps({ ledger, account, report: reports.get(account.id) });
    },
  );

  app.get(
    '/investments/positions/:key',
    { schema: { params: PositionParamsSchema, response: { 200: PositionDetailSchema } } },
    async (request) => {
      const [ledger, reports] = await Promise.all([loadLedger(prisma), loadBrokerReports()]);
      const today = findToday();
      const accounts = describeAccounts(ledger).filter((account) => !account.archived);
      const position = weighPortfolio({ ledger, reports, accounts, today }).positions.find((entry) => entry.key === request.params.key);
      if (position === undefined) throw notFound(`No position ${request.params.key}`);
      return describePosition({ position, report: reports.get(position.accountId) ?? null, ledger });
    },
  );
};
