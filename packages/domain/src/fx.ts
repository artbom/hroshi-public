import type { Currency, IsoDate, RateUsage } from '@hroshi/schema';

import { countDaysBetween } from './months.ts';

export type DailyRate = { date: IsoDate; currency: Currency; perEur: number; source?: string };
export type YearlyRate = { year: number; currency: Currency; perEur: number };

/** A daily rate older than this is no better than the yearly average. */
const MAX_DAILY_RATE_AGE_DAYS = 7;

export type FxConverter = {
  findRate: (currency: Currency, date: IsoDate) => number | null;
  /** The rate `findRate` picks, with what it is: daily, yearly average or the latest known. */
  describeRate: (currency: Currency, date: IsoDate) => RateUsage | null;
  toEur: (amount: number, currency: Currency, date: IsoDate) => number | null;
};

const findLatestOnOrBefore = (series: readonly DailyRate[], date: IsoDate): DailyRate | undefined => {
  let low = 0;
  let high = series.length - 1;
  let found: DailyRate | undefined;
  while (low <= high) {
    const middle = (low + high) >> 1;
    const candidate = series[middle];
    if (candidate === undefined) break;
    if (candidate.date <= date) {
      found = candidate;
      low = middle + 1;
    } else {
      high = middle - 1;
    }
  }
  return found;
};

const describeDaily = (rate: DailyRate, kind: 'daily' | 'latest'): RateUsage => ({
  currency: rate.currency,
  perEur: rate.perEur,
  kind,
  date: rate.date,
  year: null,
  source: rate.source ?? null,
});

/** Daily rate near the date, else that year's average, else the latest daily rate known. */
export const createFxConverter = ({
  daily,
  yearly,
}: {
  daily: readonly DailyRate[];
  yearly: readonly YearlyRate[];
}): FxConverter => {
  const dailyByCurrency = Map.groupBy(
    daily.toSorted((left, right) => left.date.localeCompare(right.date)),
    (rate) => rate.currency,
  );
  const yearlyByKey = new Map(yearly.map((rate) => [`${rate.year}:${rate.currency}`, rate.perEur]));

  const describeRate = (currency: Currency, date: IsoDate): RateUsage | null => {
    if (currency === 'EUR') return { currency, perEur: 1, kind: 'base', date: null, year: null, source: null };
    const series = dailyByCurrency.get(currency) ?? [];
    const recent = findLatestOnOrBefore(series, date);
    if (recent !== undefined && countDaysBetween(recent.date, date) <= MAX_DAILY_RATE_AGE_DAYS) {
      return describeDaily(recent, 'daily');
    }
    const year = Number(date.slice(0, 4));
    const average = yearlyByKey.get(`${year}:${currency}`);
    if (average !== undefined) return { currency, perEur: average, kind: 'yearly', date: null, year, source: null };
    const latest = series.at(-1);
    return latest === undefined ? null : describeDaily(latest, 'latest');
  };

  const findRate = (currency: Currency, date: IsoDate): number | null => describeRate(currency, date)?.perEur ?? null;

  return {
    findRate,
    describeRate,
    toEur: (amount, currency, date) => {
      const rate = findRate(currency, date);
      return rate === null ? null : amount / rate;
    },
  };
};

/**
 * A row in EUR: the euros the card was actually charged when the bank says so (a hryvnia card
 * paying in Spain), else the amount at the day's rate.
 */
export const convertToEur = ({
  transaction,
  fx,
}: {
  transaction: { amount: number; currency: Currency; date: IsoDate; operationEur?: number | null };
  fx: FxConverter;
}): number | null => transaction.operationEur ?? fx.toEur(transaction.amount, transaction.currency, transaction.date);
