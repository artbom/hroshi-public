import {
  type BrokerCashFlow,
  type BrokerResult,
  type BrokerTrade,
  type Currency,
  CurrencySchema,
  type IncomeYear,
  type IsoDate,
  type PortfolioPoint,
} from '@hroshi/schema';

import { roundAmount } from './balances.ts';
import type { FxConverter } from './fx.ts';
import { countDaysBetween } from './months.ts';

export type DatedAmount = { date: IsoDate; amount: number };

const DAYS_PER_YEAR = 365;
const MIN_RATE = -0.9999;
const MAX_RATE = 100;
const PRECISION = 1e-7;

/**
 * Money-weighted annual return: the rate at which the investor's flows (deposits negative,
 * withdrawals and today's value positive) are worth nothing today. Null when the flows do
 * not change sign, so no rate can balance them.
 */
export const computeXirr = (flows: readonly DatedAmount[]): number | null => {
  if (!flows.some((flow) => flow.amount < 0) || !flows.some((flow) => flow.amount > 0)) return null;
  const [first] = flows.toSorted((left, right) => left.date.localeCompare(right.date));
  if (first === undefined) return null;
  const presentValue = (rate: number) =>
    flows.reduce((sum, flow) => sum + flow.amount / (1 + rate) ** (countDaysBetween(first.date, flow.date) / DAYS_PER_YEAR), 0);

  let low = MIN_RATE;
  let high = MAX_RATE;
  let lowValue = presentValue(low);
  if (Math.sign(lowValue) === Math.sign(presentValue(high))) return null;
  for (let step = 0; step < 200 && high - low > PRECISION; step += 1) {
    const middle = (low + high) / 2;
    const value = presentValue(middle);
    if (Math.sign(value) === Math.sign(lowValue)) {
      low = middle;
      lowValue = value;
    } else {
      high = middle;
    }
  }
  return (low + high) / 2;
};

const convertFlow = ({ flow, currency, fx }: { flow: BrokerCashFlow; currency: Currency; fx: FxConverter }): number | null => {
  if (flow.currency === currency) return flow.amount;
  const parsed = CurrencySchema.safeParse(flow.currency);
  if (!parsed.success) return null;
  const eur = fx.toEur(flow.amount, parsed.data, flow.date);
  const rate = fx.findRate(currency, flow.date);
  return eur === null || rate === null ? null : eur * rate;
};

/** Converts a broker's cash records into the account currency at each day's rate. */
export const toAccountCurrency = ({
  flows,
  currency,
  fx,
}: {
  flows: readonly BrokerCashFlow[];
  currency: Currency;
  fx: FxConverter;
}): (BrokerCashFlow & { converted: number })[] =>
  flows.flatMap((flow) => {
    const converted = convertFlow({ flow, currency, fx });
    return converted === null ? [] : [{ ...flow, converted }];
  });

/**
 * Returns from the broker's own cash records: what went in and out is complete there even
 * when the ledger missed a deposit, so value minus net deposits is the real result.
 */
export const summarizeBrokerResult = ({
  flows,
  value,
  today,
}: {
  flows: readonly (BrokerCashFlow & { converted: number })[];
  value: number;
  today: IsoDate;
}): BrokerResult => {
  const sum = (kind: BrokerCashFlow['kind']) =>
    roundAmount(flows.filter((flow) => flow.kind === kind).reduce((total, flow) => total + flow.converted, 0));
  const deposits = sum('deposit');
  const withdrawals = -sum('withdrawal');
  const net = roundAmount(deposits - withdrawals);
  const gain = roundAmount(value - net);
  const external = flows.filter((flow) => flow.kind === 'deposit' || flow.kind === 'withdrawal');
  return {
    deposits,
    withdrawals,
    net,
    gain,
    gainShare: net > 0 ? gain / net : null,
    xirr: computeXirr([...external.map((flow) => ({ date: flow.date, amount: -flow.converted })), { date: today, amount: value }]),
    dividends: sum('dividend'),
    taxes: sum('tax'),
    fees: sum('fee'),
    interest: sum('interest'),
    firstDeposit: external.filter((flow) => flow.kind === 'deposit').map((flow) => flow.date).toSorted()[0] ?? null,
  };
};

/** How many units of `to` one unit of `from` was worth on a day, through the euro. */
const findCrossRate = ({ fx, from, to, date }: { fx: FxConverter; from: string; to: Currency; date: IsoDate }): number | null => {
  if (from === to) return 1;
  const parsed = CurrencySchema.safeParse(from);
  if (!parsed.success) return null;
  const eur = fx.toEur(1, parsed.data, date);
  const rate = fx.findRate(to, date);
  return eur === null || rate === null ? null : eur * rate;
};

/** Money that entered or left a foreign-currency pot on a day, and the rate the account booked it at. */
type PotMove = { currency: string; amount: number; date: IsoDate; bookedRate: number | null };

/**
 * The currency inside an account kept in another one (euros in a dollar account), in the account
 * currency. `translation`: every euro that came in (a deposit, an exchange) has moved with the rate
 * since the day it was booked, whether it now sits as cash or in a euro-priced share. `exchange`: what
 * an exchange gave at the broker's rate beyond the day's rate (negative: the spread).
 *
 * A broker that restates foreign deposits in its base currency (IBKR) only says what became of the
 * money in its trade log; without one (`trades` null) those deposits are taken as exchanged at once.
 */
export const measureCurrencyEffect = ({
  currency,
  flows,
  trades,
  fx,
  today,
}: {
  currency: Currency;
  flows: readonly BrokerCashFlow[];
  trades: readonly BrokerTrade[] | null;
  fx: FxConverter;
  today: IsoDate;
}): { translation: number; exchange: number } => {
  const rate = (from: string, date: IsoDate) => findCrossRate({ fx, from, to: currency, date });
  const fromFlows = flows.flatMap((flow): PotMove[] => {
    if (flow.original !== null && flow.original.currency !== currency) {
      return trades === null || flow.original.amount === 0
        ? []
        : [{ currency: flow.original.currency, amount: flow.original.amount, date: flow.date, bookedRate: flow.amount / flow.original.amount }];
    }
    return flow.currency === currency ? [] : [{ currency: flow.currency, amount: flow.amount, date: flow.date, bookedRate: rate(flow.currency, flow.date) }];
  });
  const exchanges = (trades ?? []).filter((trade) => trade.kind === 'currency');
  const fromExchanges = exchanges.flatMap((trade): PotMove[] => {
    const [base = '', quote = ''] = trade.symbol.split('/');
    const sign = trade.side === 'buy' ? 1 : -1;
    return [
      { currency: base, amount: sign * trade.quantity, date: trade.date, bookedRate: rate(base, trade.date) },
      { currency: quote, amount: -sign * trade.amount, date: trade.date, bookedRate: rate(quote, trade.date) },
    ].filter((move) => move.currency !== currency);
  });
  const translation = [...fromFlows, ...fromExchanges].reduce((sum, move) => {
    const now = rate(move.currency, today);
    return now === null || move.bookedRate === null ? sum : sum + move.amount * (now - move.bookedRate);
  }, 0);
  const exchange = exchanges.reduce((sum, trade) => {
    const [base = '', quote = ''] = trade.symbol.split('/');
    const baseRate = rate(base, trade.date);
    const quoteRate = rate(quote, trade.date);
    if (baseRate === null || quoteRate === null) return sum;
    const sign = trade.side === 'buy' ? 1 : -1;
    return sum + sign * (trade.quantity * baseRate - trade.amount * quoteRate);
  }, 0);
  return { translation: roundAmount(translation), exchange: roundAmount(exchange) };
};

/** Commissions in the account currency at each trade's day; `exchangesOnly` where the broker folds trade commissions into the cost. */
export const sumTradeCommissions = ({
  currency,
  trades,
  exchangesOnly,
  fx,
}: {
  currency: Currency;
  trades: readonly BrokerTrade[];
  exchangesOnly: boolean;
  fx: FxConverter;
}): number =>
  roundAmount(
    trades
      .filter((trade) => !exchangesOnly || trade.kind === 'currency')
      .reduce((sum, trade) => {
        const converted = findCrossRate({ fx, from: trade.feeCurrency ?? trade.currency, to: currency, date: trade.date });
        return sum + (trade.fee ?? 0) * (converted ?? 0);
      }, 0),
  );

/**
 * The euro return taken apart: (1 + € return) = (1 + return in the accounts' currency) ×
 * (1 + that currency's yearly move against the euro).
 */
export const splitReturn = ({ eur, local }: { eur: number | null; local: number | null }): number | null =>
  eur === null || local === null ? null : (1 + eur) / (1 + local) - 1;

export type PortfolioAccount = {
  currency: Currency;
  /** Deposits positive, withdrawals negative, in the account currency. */
  flows: readonly DatedAmount[];
  /** Values the broker reported, oldest first; empty when it reports none. */
  nav: readonly { date: IsoDate; value: number }[];
  value: number;
  xirr: number | null;
};

/** A reported value older than this on a month end is stale enough to call the point estimated. */
const NAV_STALE_DAYS = 7;

const findLatestNav = (nav: PortfolioAccount['nav'], date: IsoDate) => nav.findLast((point) => point.date <= date);

/**
 * The value on a past date: the broker's own figure when it reports one, otherwise every
 * deposit grown at the account's money-weighted rate. By the definition of XIRR that model
 * meets today's real value exactly, so it bends between known points rather than jumping.
 */
const findValueAt = ({ account, date, today }: { account: PortfolioAccount; date: IsoDate; today: IsoDate }) => {
  if (date >= today) return { value: account.value, estimated: false };
  const reported = findLatestNav(account.nav, date);
  if (reported !== undefined) return { value: reported.value, estimated: countDaysBetween(reported.date, date) > NAV_STALE_DAYS };
  const rate = account.xirr ?? 0;
  const value = account.flows
    .filter((flow) => flow.date <= date)
    .reduce((sum, flow) => sum + flow.amount * (1 + rate) ** (countDaysBetween(flow.date, date) / DAYS_PER_YEAR), 0);
  return { value: Math.max(0, value), estimated: true };
};

/** Portfolio value against what went in, both in EUR: deposits at their own day's rate, values at each date's. */
export const tracePortfolio = ({
  accounts,
  dates,
  today,
  fx,
}: {
  accounts: readonly PortfolioAccount[];
  dates: readonly IsoDate[];
  today: IsoDate;
  fx: FxConverter;
}): Omit<PortfolioPoint, 'benchmarkEur'>[] =>
  dates.map((date) => {
    const values = accounts.map((account) => ({ account, ...findValueAt({ account, date, today }) }));
    return {
      date,
      valueEur: values.reduce((sum, { account, value }) => sum + (fx.toEur(value, account.currency, date) ?? 0), 0),
      contributedEur: accounts.reduce(
        (sum, account) =>
          sum +
          account.flows
            .filter((flow) => flow.date <= date)
            .reduce((total, flow) => total + (fx.toEur(flow.amount, account.currency, flow.date) ?? 0), 0),
        0,
      ),
      estimated: values.some((entry) => entry.estimated && entry.value > 0),
    };
  });

type ConvertedFlow = BrokerCashFlow & { converted: number };

const sumFlows = (list: readonly ConvertedFlow[], pick: (flow: ConvertedFlow) => number) =>
  roundAmount(list.reduce((total, flow) => total + pick(flow), 0));

/** Dividends, the tax withheld from them and realised gains per calendar year, in the account currency and in EUR. */
export const summarizeIncomeByYear = ({
  accountId,
  currency,
  flows,
  realized,
  fx,
}: {
  accountId: string;
  currency: Currency;
  flows: readonly ConvertedFlow[];
  /** Sales converted like the cash records; null when the statement has none to read. */
  realized: readonly ConvertedFlow[] | null;
  fx: FxConverter;
}): IncomeYear[] => {
  const relevant = flows.filter((flow) => flow.kind === 'dividend' || flow.kind === 'tax');
  const years = [...new Set([...relevant, ...(realized ?? [])].map((flow) => Number(flow.date.slice(0, 4))))].toSorted();
  const toEur = (flow: ConvertedFlow) => fx.toEur(flow.converted, currency, flow.date) ?? 0;
  return years.map((year) => {
    const inYear = (flow: { date: IsoDate }) => Number(flow.date.slice(0, 4)) === year;
    const dividends = relevant.filter((flow) => inYear(flow) && flow.kind === 'dividend');
    const taxes = relevant.filter((flow) => inYear(flow) && flow.kind === 'tax');
    const sales = realized?.filter(inYear) ?? null;
    const dividendTotal = sumFlows(dividends, (flow) => flow.converted);
    const withholding = -sumFlows(taxes, (flow) => flow.converted);
    return {
      year,
      accountId,
      currency,
      dividends: dividendTotal,
      withholding,
      withholdingRate: dividendTotal > 0 ? withholding / dividendTotal : null,
      realized: sales === null ? null : sumFlows(sales, (flow) => flow.converted),
      eur: {
        dividends: sumFlows(dividends, toEur),
        withholding: -sumFlows(taxes, toEur),
        realized: sales === null ? null : sumFlows(sales, toEur),
      },
    };
  });
};

export type DatedPrice = { date: IsoDate; close: number };

/** The close on a day, or the last one before it (weekends, holidays); before the first close, the first. */
const findCloseOn = (prices: readonly DatedPrice[], date: IsoDate): number | null =>
  (prices.findLast((price) => price.date <= date) ?? prices[0])?.close ?? null;

/**
 * What the same deposits would be worth in one fund: each deposit buys units at that day's
 * close and each withdrawal sells them, so the line differs from the real one by the choice of
 * investments alone. Flows in EUR, deposits positive; prices oldest first.
 */
export const simulateBenchmark = ({
  flows,
  prices,
  dates,
}: {
  flows: readonly DatedAmount[];
  prices: readonly DatedPrice[];
  dates: readonly IsoDate[];
}): (number | null)[] => {
  if (prices.length === 0) return dates.map(() => null);
  const bought = flows.map((flow) => ({ date: flow.date, units: flow.amount / (findCloseOn(prices, flow.date) ?? Number.NaN) }));
  return dates.map((date) => {
    const close = findCloseOn(prices, date);
    const units = bought.filter((entry) => entry.date <= date).reduce((sum, entry) => sum + entry.units, 0);
    return close === null || !Number.isFinite(units) ? null : Math.max(0, units * close);
  });
};

/**
 * A period's return with money moving in and out: gain over the money at work, each flow
 * weighted by the share of the period it was in (Modified Dietz). Not annualised, so a year to
 * date reads as what it is. Null when nothing was at work.
 */
export const computePeriodReturn = ({
  from,
  to,
  startValue,
  endValue,
  flows,
}: {
  from: IsoDate;
  to: IsoDate;
  startValue: number;
  endValue: number;
  /** Deposits positive, withdrawals negative, dated inside (from, to]. */
  flows: readonly DatedAmount[];
}): number | null => {
  const days = countDaysBetween(from, to);
  if (days <= 0) return null;
  const inside = flows.filter((flow) => flow.date > from && flow.date <= to);
  const net = inside.reduce((sum, flow) => sum + flow.amount, 0);
  const weighted = inside.reduce((sum, flow) => sum + flow.amount * (countDaysBetween(flow.date, to) / days), 0);
  const capital = startValue + weighted;
  return capital > 0 ? (endValue - startValue - net) / capital : null;
};
