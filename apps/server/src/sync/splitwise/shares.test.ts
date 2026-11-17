import { describe, expect, it } from 'vitest';

import type { SplitwiseExpense } from './client.ts';
import { describeShare, mapSplitwiseCategory, splitEvenly } from './shares.ts';

const ME = 1;
const FRIEND = { id: 2, first_name: 'Андрій', last_name: null };

const createExpense = (overrides: Partial<SplitwiseExpense>): SplitwiseExpense => ({
  id: 10,
  group_id: null,
  description: 'Вечеря',
  payment: false,
  cost: 80,
  currency_code: 'EUR',
  date: '2026-11-12T19:00:00Z',
  deleted_at: null,
  category: { id: 13, name: 'Dining out' },
  users: [
    { user_id: ME, user: { id: ME, first_name: 'Я', last_name: null }, paid_share: 80, owed_share: 20 },
    { user_id: FRIEND.id, user: FRIEND, paid_share: 0, owed_share: 60 },
  ],
  ...overrides,
});

describe('describeShare', () => {
  it('counts what the others owe on a bill the owner paid', () => {
    expect(describeShare({ expense: createExpense({}), me: ME })).toEqual({ kind: 'cost', delta: 60, paid: 80, currency: 'EUR' });
  });

  it('counts the owner’s part of a bill someone else paid as owed', () => {
    const expense = createExpense({
      users: [
        { user_id: ME, paid_share: 0, owed_share: 16.8 },
        { user_id: FRIEND.id, user: FRIEND, paid_share: 33.6, owed_share: 16.8 },
      ],
    });
    expect(describeShare({ expense, me: ME })).toMatchObject({ kind: 'cost', delta: -16.8 });
  });

  it('tells a settle-up and who it was with', () => {
    const expense = createExpense({
      payment: true,
      users: [
        { user_id: ME, paid_share: 50, owed_share: 0 },
        { user_id: FRIEND.id, user: FRIEND, paid_share: 0, owed_share: 50 },
      ],
    });
    expect(describeShare({ expense, me: ME })).toEqual({ kind: 'payment', delta: 50, currency: 'EUR', friend: FRIEND });
  });

  it('skips expenses without the owner and flags currencies the ledger lacks', () => {
    expect(describeShare({ expense: createExpense({}), me: 99 })).toBeUndefined();
    expect(describeShare({ expense: createExpense({ currency_code: 'PLN' }), me: ME })).toEqual({ kind: 'foreign', currency: 'PLN' });
  });
});

describe('splitEvenly', () => {
  it('splits to the cent and hands the odd cents to the first people', () => {
    expect(splitEvenly({ cost: 100, count: 3 })).toEqual([33.34, 33.33, 33.33]);
    expect(splitEvenly({ cost: 80, count: 4 })).toEqual([20, 20, 20, 20]);
  });
});

describe('mapSplitwiseCategory', () => {
  it('maps the subcategories the ledger has and leaves the rest to review', () => {
    expect(mapSplitwiseCategory('Dining out')).toBe('Кафе і ресторани');
    expect(mapSplitwiseCategory('General')).toBeUndefined();
  });
});
