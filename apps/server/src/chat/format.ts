import type { ChangedRow, ChatChange } from './changes.ts';

/** A long batch still fits one Telegram message; the rest is a count. */
const MAX_LINES = 20;

const FIELD_LABELS: readonly (readonly [Exclude<keyof ChangedRow, 'id'>, string])[] = [
  ['date', 'дата'],
  ['type', 'тип'],
  ['accountId', 'рахунок'],
  ['toAccountId', 'куди'],
  ['amount', 'сума'],
  ['currency', 'валюта'],
  ['category', 'категорія'],
  ['note', 'нотатка'],
];

const formatDate = (date: string) => `${date.slice(8, 10)}.${date.slice(5, 7)}`;

const formatAmount = (amount: number) => amount.toLocaleString('uk-UA', { maximumFractionDigits: 2 });

const describeTarget = (row: ChangedRow) => {
  if (row.type === 'transfer') return `${row.accountId} → ${row.toAccountId ?? '?'}`;
  if (row.type === 'valuation') return `${row.accountId}, переоцінка`;
  return `${row.accountId}, ${row.category ?? 'без категорії'}`;
};

const SIGNS: Record<ChangedRow['type'], string> = { expense: '−', income: '+', transfer: '', valuation: '' };

export const describeChangedRow = (row: ChangedRow) =>
  [formatDate(row.date), `${SIGNS[row.type]}${formatAmount(row.amount)} ${row.currency}`, describeTarget(row), row.note]
    .filter((part) => part !== null && part !== '')
    .join(' · ');

const formatValue = (value: ChangedRow[keyof ChangedRow]) => (value === null || value === '' ? '—' : String(value));

const describeEdits = (before: ChangedRow, after: ChangedRow) =>
  FIELD_LABELS.flatMap(([field, label]) =>
    before[field] === after[field] ? [] : [`${label} ${formatValue(before[field])} → ${formatValue(after[field])}`],
  ).join(', ');

const describeChange = (change: ChatChange) => {
  if (change.kind === 'created') return `➕ ${describeChangedRow(change.after)}`;
  if (change.kind === 'deleted') return `🗑 ${describeChangedRow(change.before)}`;
  return `✏️ ${describeChangedRow(change.before)}: ${describeEdits(change.before, change.after) || 'без видимих змін'}`;
};

/** The deterministic list under the model's reply: what actually changed, whatever the model said. */
export const formatChatChanges = (changes: readonly ChatChange[]) => {
  const lines = changes.slice(0, MAX_LINES).map(describeChange);
  const rest = changes.length - lines.length;
  return [...lines, ...(rest > 0 ? [`…і ще ${rest}`] : [])].join('\n');
};
