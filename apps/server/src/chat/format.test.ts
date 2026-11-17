import { describe, expect, it } from 'vitest';

import type { ChangedRow, ChatChange } from './changes.ts';
import { formatChatChanges } from './format.ts';

const coffee: ChangedRow = {
  id: 'coffee',
  date: '2026-11-13',
  type: 'expense',
  accountId: 'cash-eur',
  toAccountId: null,
  amount: 20,
  currency: 'EUR',
  category: 'Кафе і ресторани',
  note: 'кава',
};

describe('formatChatChanges', () => {
  it('lists what a message created, changed and deleted', () => {
    const topUp: ChangedRow = { ...coffee, type: 'transfer', toAccountId: 'revolut-eur', category: null, note: null };
    expect(
      formatChatChanges([
        { kind: 'created', after: coffee },
        { kind: 'updated', before: coffee, after: { ...coffee, category: 'Подорожі' } },
        { kind: 'deleted', before: topUp },
      ]),
    ).toBe(
      [
        '➕ 13.11 · −20 EUR · cash-eur, Кафе і ресторани · кава',
        '✏️ 13.11 · −20 EUR · cash-eur, Кафе і ресторани · кава: категорія Кафе і ресторани → Подорожі',
        '🗑 13.11 · 20 EUR · cash-eur → revolut-eur',
      ].join('\n'),
    );
  });

  it('counts the changes that do not fit one message', () => {
    const lines = formatChatChanges(Array.from({ length: 25 }, (): ChatChange => ({ kind: 'created', after: coffee }))).split('\n');
    expect(lines).toHaveLength(21);
    expect(lines.at(-1)).toBe('…і ще 5');
  });
});
