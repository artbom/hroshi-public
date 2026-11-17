import type { Month } from '@hroshi/schema';
import { useState } from 'react';

import { shiftMonth } from '../months.ts';

export const PERIOD_KINDS = ['6', '12', '24', '60', 'ytd', 'custom'] as const;
export type PeriodKind = (typeof PERIOD_KINDS)[number];

export const PERIOD_LABELS: Readonly<Record<PeriodKind, string>> = {
  '6': '6 міс.',
  '12': '12 міс.',
  '24': '24 міс.',
  '60': '5 років',
  ytd: 'З початку року',
  custom: 'Свій період',
};

export type Period = { kind: PeriodKind; from: Month | ''; to: Month | '' };

/** The months a period covers, ending at the route month (or the custom end): Аналітика's one clock. */
export type ResolvedPeriod = { from: Month; to: Month; range: number; label: string };

export const countMonths = (from: Month, to: Month) =>
  (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;

/** The API serves at most this many months at once. */
const MAX_RANGE = 120;

const NBSP = '\u00a0';

/** «груд. 2025» or, with `withYear` off, «груд.»; never broken across lines. */
const formatRangeMonth = ({ month, withYear }: { month: Month; withYear: boolean }) =>
  new Date(`${month}-15T12:00:00`)
    .toLocaleDateString('uk-UA', withYear ? { month: 'short', year: 'numeric' } : { month: 'short' })
    .replace(/\s*р\.$/u, '')
    .replace(/\s/gu, NBSP);

/** The range the period covers, with its years: «груд. 2025 – лист. 2026», «січ. – лист. 2026», «лист. 2026». */
export const formatRange = ({ from, to }: { from: Month; to: Month }): string => {
  if (from === to) return formatRangeMonth({ month: to, withYear: true });
  const sameYear = from.slice(0, 4) === to.slice(0, 4);
  return `${formatRangeMonth({ month: from, withYear: !sameYear })} – ${formatRangeMonth({ month: to, withYear: true })}`;
};

const buildPeriod = (from: Month, to: Month): ResolvedPeriod => {
  const range = Math.min(MAX_RANGE, Math.max(1, countMonths(from, to)));
  const start = shiftMonth(to, 1 - range);
  return { from: start, to, range, label: formatRange({ from: start, to }) };
};

export const resolvePeriod = ({ period, month }: { period: Period; month: Month }): ResolvedPeriod => {
  switch (period.kind) {
    case 'ytd':
      return buildPeriod(`${month.slice(0, 4)}-01`, month);
    case 'custom': {
      const to = period.to || month;
      const from = period.from && period.from <= to ? period.from : shiftMonth(to, -11);
      return buildPeriod(from, to);
    }
    default:
      return buildPeriod(shiftMonth(month, 1 - Number(period.kind)), month);
  }
};

const readStored = <T>(key: string, parse: (raw: unknown) => T | null): T | null => {
  try {
    const raw = window.localStorage.getItem(key);
    return raw === null ? null : parse(JSON.parse(raw));
  } catch {
    return null;
  }
};

/** A per-viewer preference that survives a reload; the page works the same when storage is blocked. */
export const useStoredState = <T>({
  key,
  initial,
  parse,
}: {
  key: string;
  initial: T;
  parse: (raw: unknown) => T | null;
}): [T, (next: T) => void] => {
  const [value, setValue] = useState<T>(() => readStored(key, parse) ?? initial);
  const update = (next: T) => {
    setValue(next);
    try {
      window.localStorage.setItem(key, JSON.stringify(next));
    } catch {
      // Private windows and blocked site data: the choice simply lasts until reload.
    }
  };
  return [value, update];
};

export const parseBoolean = (raw: unknown): boolean | null => (typeof raw === 'boolean' ? raw : null);
