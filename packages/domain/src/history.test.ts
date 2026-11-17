import { describe, expect, it } from 'vitest';

import { computeBalances } from './balances.ts';
import { createFxConverter } from './fx.ts';
import { computeBalanceHistory, findMonthEnd, listMonthEnds } from './history.ts';
import { traceNetWorth } from './net-worth.ts';
import type { LedgerAccount, LedgerTransaction } from './types.ts';

const createRow = (overrides: Partial<LedgerTransaction>): LedgerTransaction => ({
  type: 'expense',
  date: '2026-11-05',
  accountId: 'card',
  amount: 10,
  currency: 'EUR',
  toAccountId: null,
  toAmount: null,
  toCurrency: null,
  category: 'Продукти',
  note: null,
  ...overrides,
});

const card: LedgerAccount = { id: 'card', currency: 'EUR', kind: 'everyday', openingBalance: 100, openingDate: '2026-11-01' };
const uah: LedgerAccount = { id: 'uah', currency: 'UAH', kind: 'everyday', openingBalance: 0, openingDate: '2026-11-01' };

describe('findMonthEnd', () => {
  it('uses the last day of a finished month and today for the running one', () => {
    expect(findMonthEnd({ month: '2024-02', today: '2026-11-11' })).toBe('2024-02-29');
    expect(findMonthEnd({ month: '2026-11', today: '2026-11-11' })).toBe('2026-11-11');
    expect(listMonthEnds({ until: '2026-11', count: 2, today: '2026-11-11' })).toEqual([
      { month: '2026-10', date: '2026-10-31' },
      { month: '2026-11', date: '2026-11-11' },
    ]);
  });
});

describe('computeBalanceHistory', () => {
  const transactions = [
    createRow({ date: '2026-09-10', amount: 40 }),
    createRow({ date: '2026-10-20', type: 'income', amount: 15, category: 'Зарплата/клієнт' }),
    createRow({ date: '2026-11-03', amount: 30 }),
    createRow({ date: '2026-11-20', amount: 5 }),
  ];

  it('adds rows from the opening date on and takes back rows between a past date and the opening', () => {
    const history = computeBalanceHistory({
      accounts: [card],
      transactions,
      dates: ['2026-08-31', '2026-09-30', '2026-10-31', '2026-11-05', '2026-11-30'],
    });
    // Opening 100 on 11-01: before it, the −40 and +15 are undone in reverse.
    expect(history.get('card')).toEqual([125, 85, 100, 70, 65]);
  });

  it('agrees with computeBalances today, so the history ends where the balance is', () => {
    const [today] = computeBalanceHistory({ accounts: [card], transactions, dates: ['2026-11-30'] }).get('card') ?? [];
    expect(today).toBe(computeBalances({ accounts: [card], transactions }).get('card'));
  });

  it('moves both legs of a transfer and nothing for an unknown credit', () => {
    const history = computeBalanceHistory({
      accounts: [card, uah],
      transactions: [
        createRow({ type: 'transfer', date: '2026-10-15', amount: 20, toAccountId: 'uah', toAmount: 1000, category: null }),
        createRow({ type: 'transfer', date: '2026-10-16', amount: 5, toAccountId: 'uah', toAmount: 0, category: null }),
      ],
      dates: ['2026-10-14', '2026-10-31'],
    });
    expect(history.get('card')).toEqual([125, 100]);
    expect(history.get('uah')).toEqual([-1000, 0]);
  });
});

describe('traceNetWorth', () => {
  it('converts each date at its own rate', () => {
    const fx = createFxConverter({
      daily: [
        { date: '2026-10-31', currency: 'UAH', perEur: 50 },
        { date: '2026-11-30', currency: 'UAH', perEur: 40 },
      ],
      yearly: [],
    });
    const worth = traceNetWorth({
      accounts: [{ ...uah, kind: 'credit', openingBalance: -2000 }],
      transactions: [],
      fx,
      dates: ['2026-10-31', '2026-11-30'],
    });
    expect(worth.map((entry) => entry.creditDebtEur)).toEqual([-40, -50]);
  });
});
