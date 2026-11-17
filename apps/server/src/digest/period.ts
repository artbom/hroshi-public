import { shiftDate, shiftMonth } from '@hroshi/domain';
import type { IsoDate, Month } from '@hroshi/schema';
import { z } from 'zod';

/** `day`: the morning budget report, the month up to yesterday. */
export const DigestKindSchema = z.enum(['day', 'week', 'month']);
export type DigestKind = z.infer<typeof DigestKindSchema>;
/** The digests that look back over a whole week or month. */
export type PeriodKind = Exclude<DigestKind, 'day'>;

const findWeekday = (date: IsoDate) => new Date(`${date}T00:00:00Z`).getUTCDay();

/** The Sunday that closes the last full Monday–Sunday week before `today`. */
export const findLastWeekEnd = (today: IsoDate): IsoDate => {
  const weekday = findWeekday(today);
  return shiftDate(today, -(weekday === 0 ? 7 : weekday));
};

/** The Sunday that closes the Monday–Sunday week `date` falls in. */
export const findWeekEnd = (date: IsoDate): IsoDate => shiftDate(date, (7 - findWeekday(date)) % 7);

/** The month before the one `today` falls in. */
export const findLastMonth = (today: IsoDate): Month => shiftMonth(today.slice(0, 7), -1);
