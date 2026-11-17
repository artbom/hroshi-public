import type { IsoDate, Month } from '@hroshi/schema';

/** Calendar date in the process time zone (TZ), which is where the owner lives. */
export const findToday = (): IsoDate => new Date().toLocaleDateString('en-CA');

export const findCurrentMonth = (): Month => findToday().slice(0, 7);
