import type { IsoDate, Month } from '@hroshi/schema';

export const findToday = (): IsoDate => new Date().toLocaleDateString('en-CA');

export const findCurrentMonth = (): Month => findToday().slice(0, 7);

export const shiftMonth = (month: Month, delta: number): Month => {
  const date = new Date(`${month}-01T00:00:00Z`);
  date.setUTCMonth(date.getUTCMonth() + delta);
  return date.toISOString().slice(0, 7);
};
