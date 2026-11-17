import type { IsoDate, Month } from '@hroshi/schema';

export const toMonth = (date: IsoDate): Month => date.slice(0, 7);

export const shiftMonth = (month: Month, delta: number): Month => {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
};

/** The `count` months ending with `until`, oldest first. */
export const listMonthsBack = ({ until, count }: { until: Month; count: number }): Month[] =>
  Array.from({ length: count }, (_, index) => shiftMonth(until, index - count + 1));

export const shiftDate = (date: IsoDate, days: number): IsoDate => {
  const value = new Date(`${date}T00:00:00Z`);
  value.setUTCDate(value.getUTCDate() + days);
  return value.toISOString().slice(0, 10);
};

export const countDaysBetween = (from: IsoDate, to: IsoDate): number =>
  Math.round((Date.parse(`${to}T00:00:00Z`) - Date.parse(`${from}T00:00:00Z`)) / 86_400_000);

export const countDaysInMonth = (month: Month): number => countDaysBetween(`${month}-01`, `${shiftMonth(month, 1)}-01`);

/** Every month from `from` to `to`, both included, oldest first. */
export const listMonthsBetween = ({ from, to }: { from: Month; to: Month }): Month[] => {
  const count = (Number(to.slice(0, 4)) - Number(from.slice(0, 4))) * 12 + Number(to.slice(5, 7)) - Number(from.slice(5, 7)) + 1;
  return count <= 0 ? [] : listMonthsBack({ until: to, count });
};
