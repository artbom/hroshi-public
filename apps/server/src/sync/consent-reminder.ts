import { CONSENT_WARNING_DAYS } from '@hroshi/schema';

const DAY_MS = 86_400_000;
/**
 * Days before the end on which the bot reminds, the first when the app starts warning too. Then
 * once on the day it ends, and no more: the owner asked not to be nagged daily.
 */
const REMINDER_DAYS: ReadonlySet<number> = new Set([CONSENT_WARNING_DAYS, 7, 3, 1, 0]);

const pluralizeDays = (days: number) => {
  if (days === 1) return 'день';
  return days < 5 ? 'дні' : 'днів';
};

/** Today's reminder about a bank consent running out, or null on the days in between. */
export const describeConsentReminder = ({ bank, validUntil, now }: { bank: string; validUntil: Date; now: Date }): string | null => {
  // Rounding up: the morning a consent ends at 02:00 counts as its last day, not the day after.
  const daysLeft = Math.max(0, Math.ceil((validUntil.getTime() - now.getTime()) / DAY_MS));
  const overdue = validUntil.getTime() - now.getTime() <= -DAY_MS;
  if (overdue || !REMINDER_DAYS.has(daysLeft)) return null;
  const date = validUntil.toLocaleDateString('uk-UA', { day: 'numeric', month: 'long' });
  return daysLeft === 0
    ? `Згода ${bank} закінчилась ${date}: поки її не поновиш, ${bank} не синхронізується. Пропущені дні підтягнуться після поновлення.`
    : `Згода ${bank} закінчується через ${daysLeft} ${pluralizeDays(daysLeft)}, ${date}. Поновлення — одне підтвердження в застосунку ${bank}; пропущене підтягнеться само.`;
};
