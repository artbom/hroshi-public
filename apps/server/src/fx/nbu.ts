import { shiftDate } from '@hroshi/domain';
import type { Currency, IsoDate } from '@hroshi/schema';
import { z } from 'zod';

import type { Db } from '../db.ts';
import { fromIsoDate } from '../mappers.ts';

const NBU_API = 'https://bank.gov.ua/NBU_Exchange/exchange_site';
export const NBU_SOURCE = 'nbu';
/** NBU publishes hryvnia per unit of each currency; these are the ones the ledger converts. */
type NbuCode = 'eur' | 'usd' | 'gbp';

const NbuRateSchema = z.object({
  /** dd.mm.yyyy */
  exchangedate: z.string().regex(/^\d{2}\.\d{2}\.\d{4}$/),
  rate_per_unit: z.number().positive(),
});

const toNbuDate = (date: IsoDate) => date.replaceAll('-', '');
const fromNbuDate = (date: string): IsoDate => date.split('.').toReversed().join('-');

const fetchSeries = async ({ code, from, to }: { code: NbuCode; from: IsoDate; to: IsoDate }) => {
  const query = new URLSearchParams({ start: toNbuDate(from), end: toNbuDate(to), valcode: code, sort: 'exchangedate', order: 'asc' });
  const response = await fetch(`${NBU_API}?${query}&json`);
  if (!response.ok) throw new Error(`NBU ${code} answered ${response.status}`);
  return new Map(
    z
      .array(NbuRateSchema)
      .parse(await response.json())
      .map((rate) => [fromNbuDate(rate.exchangedate), rate.rate_per_unit]),
  );
};

export type DailyPerEur = { date: IsoDate; currency: Currency; perEur: number };

/**
 * Turns hryvnia per unit into units per euro, the ledger's base: UAH is the euro rate itself,
 * USD and GBP are cross rates through the hryvnia. USDT follows the dollar.
 */
export const crossNbuRates = (series: Readonly<Record<NbuCode, ReadonlyMap<IsoDate, number>>>): DailyPerEur[] =>
  [...series.eur].flatMap(([date, uahPerEur]) => {
    const usd = series.usd.get(date);
    const gbp = series.gbp.get(date);
    return [
      { date, currency: 'UAH' as const, perEur: uahPerEur },
      ...(usd === undefined
        ? []
        : [
            { date, currency: 'USD' as const, perEur: uahPerEur / usd },
            { date, currency: 'USDT' as const, perEur: uahPerEur / usd },
          ]),
      ...(gbp === undefined ? [] : [{ date, currency: 'GBP' as const, perEur: uahPerEur / gbp }]),
    ];
  });

/**
 * Stores NBU daily rates, one request per currency for the whole period. Days that already
 * have a rate keep it: NBU history never changes, and a rate the owner entered wins.
 */
export const importNbuRates = async ({ db, from, to }: { db: Db; from: IsoDate; to: IsoDate }) => {
  const [eur, usd, gbp] = await Promise.all([
    fetchSeries({ code: 'eur', from, to }),
    fetchSeries({ code: 'usd', from, to }),
    fetchSeries({ code: 'gbp', from, to }),
  ]);
  const rates = crossNbuRates({ eur, usd, gbp });
  const { count } = await db.fxRate.createMany({
    data: rates.map((rate) => ({ ...rate, date: fromIsoDate(rate.date), source: NBU_SOURCE })),
    skipDuplicates: true,
  });
  return { fetched: rates.length, created: count };
};

/** NBU sets tomorrow's rate in the afternoon; a fortnight back also fills any day a run missed. */
export const NBU_DAILY_LOOKBACK_DAYS = 14;

export const importRecentNbuRates = ({ db, today }: { db: Db; today: IsoDate }) =>
  importNbuRates({ db, from: shiftDate(today, -NBU_DAILY_LOOKBACK_DAYS), to: shiftDate(today, 1) });
