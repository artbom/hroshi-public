import { countDaysBetween, type DatedPrice, shiftDate } from '@hroshi/domain';
import type { IsoDate } from '@hroshi/schema';
import { z } from 'zod';

import type { Db } from '../db.ts';
import { fromIsoDate, toIsoDate, toNumber } from '../mappers.ts';

/**
 * Vanguard FTSE All-World, accumulating, on Xetra in euros: the one fund a passive investor
 * would have bought instead. Stooq answers scripts with a browser challenge, so the daily
 * closes come from Yahoo's public chart endpoint, which needs no key.
 */
export const BENCHMARK = {
  symbol: 'VWCE',
  name: 'Vanguard FTSE All-World (VWCE)',
  source: 'yahoo:VWCE.DE',
  url: 'https://query1.finance.yahoo.com/v8/finance/chart/VWCE.DE',
  currency: 'EUR',
} as const;

const ChartSchema = z.object({
  chart: z.object({
    result: z
      .array(
        z.object({
          meta: z.object({ currency: z.string(), gmtoffset: z.number().default(0) }),
          timestamp: z.array(z.number()).default([]),
          indicators: z.object({
            quote: z.array(z.object({ close: z.array(z.number().nullable()) })).min(1),
            adjclose: z.array(z.object({ adjclose: z.array(z.number().nullable()) })).optional(),
          }),
        }),
      )
      .min(1),
  }),
});

/** The fund's first trading month: a fresh fetch takes its whole life. */
const FUND_START: IsoDate = '2019-07-01';
/** A top-up reaches back far enough to fill a week the worker missed. */
const TOP_UP_DAYS = 14;
/** Closes this old are still today's on a weekend or a holiday Monday. */
const STALE_DAYS = 4;
/** After a failed fetch the page does not retry on every load. */
const RETRY_AFTER_MS = 6 * 60 * 60 * 1000;
const FETCH_TIMEOUT_MS = 8000;

const toEpochSeconds = (date: IsoDate) => String(Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000));

/** Explicit bounds, not `range=max`: for long ranges the endpoint quietly switches to weekly bars. */
const fetchCloses = async ({ from, to }: { from: IsoDate; to: IsoDate }): Promise<DatedPrice[]> => {
  const query = new URLSearchParams({ period1: toEpochSeconds(from), period2: toEpochSeconds(shiftDate(to, 1)), interval: '1d' });
  const response = await fetch(`${BENCHMARK.url}?${query}`, {
    // The endpoint refuses requests without a browser-like agent; nothing else is sent.
    headers: { 'User-Agent': 'Mozilla/5.0' },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!response.ok) throw new Error(`${BENCHMARK.source} answered ${response.status}`);
  const [result] = ChartSchema.parse(await response.json()).chart.result;
  if (result === undefined || result.meta.currency !== BENCHMARK.currency) {
    throw new Error(`${BENCHMARK.source}: unexpected currency ${result?.meta.currency ?? '—'}`);
  }
  // Accumulating fund: both closes match today; the adjusted one stays right should it ever pay out.
  const closes = result.indicators.adjclose?.[0]?.adjclose ?? result.indicators.quote[0]?.close ?? [];
  return result.timestamp.flatMap((timestamp, index) => {
    const close = closes[index];
    if (close === null || close === undefined || close <= 0) return [];
    // The exchange's own day, not UTC's: a Xetra close stamped 08:00 UTC is that Berlin day.
    return [{ date: new Date((timestamp + result.meta.gmtoffset) * 1000).toISOString().slice(0, 10), close }];
  });
};

/** Stores closes not cached yet; a stored close never changes. Without `since` it fetches the fund's whole life. */
export const importBenchmarkPrices = async ({ db, since, today }: { db: Db; since: IsoDate | null; today: IsoDate }) => {
  const closes = await fetchCloses({ from: since === null ? FUND_START : shiftDate(since, -TOP_UP_DAYS), to: today });
  const { count } = await db.instrumentPrice.createMany({
    // A bar for today is the live price, not a close; stored, it would never be corrected.
    data: closes.filter((price) => price.date < today).map((price) => ({
      symbol: BENCHMARK.symbol,
      date: fromIsoDate(price.date),
      close: price.close,
      currency: BENCHMARK.currency,
      source: BENCHMARK.source,
    })),
    skipDuplicates: true,
  });
  return { fetched: closes.length, created: count };
};

const readNewestDate = async (db: Db): Promise<IsoDate | null> => {
  const newest = await db.instrumentPrice.findFirst({ where: { symbol: BENCHMARK.symbol }, orderBy: { date: 'desc' } });
  return newest === null ? null : toIsoDate(newest.date);
};

/** The worker's daily run: whatever closed since the newest cached day. */
export const topUpBenchmarkPrices = async ({ db, today }: { db: Db; today: IsoDate }) =>
  importBenchmarkPrices({ db, since: await readNewestDate(db), today });

const readCached = async (db: Db): Promise<DatedPrice[]> =>
  (await db.instrumentPrice.findMany({ where: { symbol: BENCHMARK.symbol }, orderBy: { date: 'asc' } })).map((row) => ({
    date: toIsoDate(row.date),
    close: toNumber(row.close),
  }));

let lastAttempt = 0;
let pending: Promise<unknown> | null = null;

/**
 * The cached closes, topped up first when they are stale, so the chart has a line before the
 * worker's first daily run. A failed fetch leaves the cache as it is and the page carries on.
 */
export const loadBenchmarkPrices = async ({ db, today }: { db: Db; today: IsoDate }): Promise<DatedPrice[]> => {
  const cached = await readCached(db);
  const newest = cached.at(-1)?.date;
  const stale = newest === undefined || countDaysBetween(newest, today) > STALE_DAYS;
  if (!stale || Date.now() - lastAttempt < RETRY_AFTER_MS) return cached;
  lastAttempt = Date.now();
  pending ??= importBenchmarkPrices({ db, since: newest ?? null, today })
    .catch((error: unknown) => console.warn(`[prices] ${error instanceof Error ? error.message : String(error)}`))
    .finally(() => {
      pending = null;
    });
  await pending;
  return readCached(db);
};
