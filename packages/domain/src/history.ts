import type { HryvniaExposure, IsoDate, Month } from '@hroshi/schema';

import { listBalanceEffects, roundAmount } from './balances.ts';
import type { FxConverter } from './fx.ts';
import { listMonthsBack, shiftDate, shiftMonth } from './months.ts';
import type { LedgerAccount, LedgerTransaction } from './types.ts';

/** Last day of the month, or `today` while the month is still running. */
export const findMonthEnd = ({ month, today }: { month: Month; today: IsoDate }): IsoDate => {
  const last = shiftDate(`${shiftMonth(month, 1)}-01`, -1);
  return last > today ? today : last;
};

export const listMonthEnds = ({ until, count, today }: { until: Month; count: number; today: IsoDate }) =>
  listMonthsBack({ until, count }).map((month) => ({ month, date: findMonthEnd({ month, today }) }));

type DatedEffect = { date: IsoDate; delta: number };

/** Number of effects dated on or before `date`; effects are sorted by date. */
const countUpTo = (effects: readonly DatedEffect[], date: IsoDate): number => {
  let low = 0;
  let high = effects.length;
  while (low < high) {
    const middle = (low + high) >> 1;
    if ((effects[middle]?.date ?? '') <= date) low = middle + 1;
    else high = middle;
  }
  return low;
};

/**
 * Balances on past dates, anchored at the opening: from the opening date on it adds every
 * row up to the date, before it takes back every row between the date and the opening.
 * Both are `opening + Σ(rows ≤ date) − Σ(rows before the opening date)`. History rows are
 * real money moves, so they count here even though they never move the current balance.
 */
export const computeBalanceHistory = ({
  accounts,
  transactions,
  dates,
}: {
  accounts: readonly LedgerAccount[];
  transactions: readonly LedgerTransaction[];
  dates: readonly IsoDate[];
}): Map<LedgerAccount['id'], number[]> => {
  const effects = new Map<string, DatedEffect[]>(accounts.map((account) => [account.id, []]));
  for (const transaction of transactions) {
    for (const { accountId, delta } of listBalanceEffects(transaction)) {
      effects.get(accountId)?.push({ date: transaction.date, delta });
    }
  }

  return new Map(
    accounts.map((account) => {
      const sorted = (effects.get(account.id) ?? []).toSorted((left, right) => left.date.localeCompare(right.date));
      const prefix = [0];
      for (const effect of sorted) prefix.push((prefix.at(-1) ?? 0) + effect.delta);
      const sumUpTo = (date: IsoDate) => prefix[countUpTo(sorted, date)] ?? 0;
      const beforeOpening = sumUpTo(shiftDate(account.openingDate, -1));
      return [account.id, dates.map((date) => roundAmount(account.openingBalance + sumUpTo(date) - beforeOpening))];
    }),
  );
};

const sumWhere = (values: readonly number[], keep: (value: number) => boolean) =>
  values.reduce((sum, value) => (keep(value) ? sum + value : sum), 0);

/**
 * Hryvnia balances at each month end, split into money and card debt, with what the month's
 * rate move did to each in EUR. The debt is deliberate: a weaker hryvnia makes it cheaper.
 */
export const traceHryvniaExposure = ({
  accounts,
  transactions,
  fx,
  ends,
}: {
  accounts: readonly LedgerAccount[];
  transactions: readonly LedgerTransaction[];
  fx: FxConverter;
  ends: readonly { month: Month; date: IsoDate }[];
}): HryvniaExposure => {
  const hryvnia = accounts.filter((account) => account.currency === 'UAH');
  const first = ends[0];
  if (first === undefined) return { points: [], assetsFxEur: 0, debtFxEur: 0 };
  // The month before the range gives the first month its starting balances and rate.
  const dates = [findMonthEnd({ month: shiftMonth(first.month, -1), today: first.date }), ...ends.map((end) => end.date)];
  const history = computeBalanceHistory({ accounts: hryvnia, transactions, dates });
  const balancesAt = (index: number) => hryvnia.map((account) => history.get(account.id)?.[index] ?? 0);
  const rates = dates.map((date) => fx.findRate('UAH', date));

  const points = ends.map(({ month, date }, index) => {
    const now = balancesAt(index + 1);
    const before = balancesAt(index);
    const rate = rates[index + 1] ?? null;
    const previousRate = rates[index] ?? null;
    const toEur = (uah: number) => (rate === null ? 0 : uah / rate);
    const rateEffect = (uah: number) => (rate === null || previousRate === null ? 0 : uah / rate - uah / previousRate);
    return {
      month,
      date,
      uahPerEur: rate,
      assetsUah: roundAmount(sumWhere(now, (value) => value > 0)),
      assetsEur: toEur(sumWhere(now, (value) => value > 0)),
      debtUah: roundAmount(sumWhere(now, (value) => value < 0)),
      debtEur: toEur(sumWhere(now, (value) => value < 0)),
      assetsFxEur: rateEffect(sumWhere(before, (value) => value > 0)),
      debtFxEur: rateEffect(sumWhere(before, (value) => value < 0)),
    };
  });

  return {
    points,
    assetsFxEur: points.reduce((sum, point) => sum + point.assetsFxEur, 0),
    debtFxEur: points.reduce((sum, point) => sum + point.debtFxEur, 0),
  };
};
