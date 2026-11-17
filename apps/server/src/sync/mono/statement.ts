import { type StatementItem, toLocalDate } from '../statement.ts';
import { CURRENCY_BY_ISO_CODE } from './accounts.ts';
import type { MonoStatementItem } from './client.ts';

export const mapMonoItem = ({ item, accountId }: { item: MonoStatementItem; accountId: string }): StatementItem => ({
  externalId: item.id,
  accountId,
  date: toLocalDate(new Date(item.time * 1000)),
  amount: item.amount / 100,
  operationAmount: item.operationAmount / 100,
  operationCurrency: CURRENCY_BY_ISO_CODE[item.currencyCode] ?? null,
  description: item.description,
  counterparty: item.counterName ?? null,
  counterIban: item.counterIban ?? null,
  mcc: item.mcc,
  comment: item.comment ?? null,
  raw: item,
});
