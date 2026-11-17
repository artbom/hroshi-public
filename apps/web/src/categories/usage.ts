import type { CategoryUsage } from '@hroshi/schema';

import { formatDay, pluralize } from '../format.ts';

/** «120 записів · 3 правила · останній 1 лист. 2026»: what renaming or archiving would touch. */
export const describeUsage = (usage: CategoryUsage | undefined): string => {
  if (usage === undefined) return '';
  const parts = [pluralize(usage.rows, ['запис', 'записи', 'записів'])];
  if (usage.rules > 0) parts.push(pluralize(usage.rules, ['правило', 'правила', 'правил']));
  if (usage.lastDate !== null) parts.push(`останній ${formatDay(usage.lastDate)}`);
  return parts.join(' · ');
};
