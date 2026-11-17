import type { NetWorthPoint } from '@hroshi/schema';

import type { View } from '../route.ts';

type BucketKey = keyof Pick<NetWorthPoint, 'cashEur' | 'investmentsEur' | 'owedToMeEur' | 'creditDebtEur' | 'iOweEur'>;

/** One name per part of net worth, on Огляд and in Аналітика alike. */
export const NET_WORTH_BUCKETS: readonly { key: BucketKey; label: string; view: View }[] = [
  { key: 'cashEur', label: 'Гроші на рахунках', view: 'accounts' },
  { key: 'investmentsEur', label: 'Інвестиції', view: 'investments' },
  { key: 'owedToMeEur', label: 'Мені винні', view: 'accounts' },
  { key: 'creditDebtEur', label: 'Борг по кредитці', view: 'accounts' },
  { key: 'iOweEur', label: 'Я винен', view: 'accounts' },
];
