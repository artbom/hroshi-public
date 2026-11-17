import type { Transaction } from '@hroshi/schema';
import { describe, expect, it } from 'vitest';

import { indexCategoryPolicies } from './classify.ts';
import { compareMonth } from './compare.ts';
import { linkChains } from './explain.ts';
import { createFxConverter } from './fx.ts';
import { describeLoan, listAllTimeIssues, listFlows, summarizeContributions, traceStartValue } from './investments.ts';
import { normalizeMerchant } from './merchants.ts';
import { rankIncomeSources, rankPayees } from './payees.ts';
import { assessDataQuality } from './quality.ts';
import { detectRecurring, measureSpread } from './recurring.ts';
import { indexPayeeHistory, suggestCategory } from './suggest.ts';
import { summarizeTags } from './tags.ts';
import type { LedgerTransaction } from './types.ts';

const policies = indexCategoryPolicies([
  { name: 'Житло', incomeRole: 'netting', countsAsSpending: true },
  { name: 'Комуналка', incomeRole: 'netting', countsAsSpending: true },
  { name: 'Підписки', incomeRole: 'netting', countsAsSpending: true },
  { name: 'Подорожі', incomeRole: 'netting', countsAsSpending: true },
  { name: 'Продукти', incomeRole: 'netting', countsAsSpending: true },
  { name: 'Інше', incomeRole: 'ignored', countsAsSpending: true },
  { name: 'Зарплата/клієнт', incomeRole: 'earning', countsAsSpending: true },
]);

const fx = createFxConverter({ daily: [], yearly: [{ year: 2026, currency: 'UAH', perEur: 50 }, { year: 2026, currency: 'USD', perEur: 1.25 }] });

type FixtureRow = LedgerTransaction & Pick<Transaction, 'id' | 'source' | 'synced' | 'needsReview' | 'tags'>;

let sequence = 0;
const createRow = (overrides: Partial<FixtureRow>): FixtureRow => {
  sequence += 1;
  return {
    id: `row-${sequence}`,
    source: 'mono',
    synced: true,
    needsReview: false,
    tags: [],
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
  };
};

describe('normalizeMerchant', () => {
  it.each([
    ['SIXT9616309984,PAREDES,PT', 'SIXT', 'Sixt'],
    ['CORP.ALIM.GUISSONA G056', 'CORP ALIM GUISSONA', 'Corp.alim.guissona'],
    ['CORP ALIM GUISSONA G05', 'CORP ALIM GUISSONA', 'Corp Alim Guissona'],
    ['To Juan Garcia Lopez', 'JUAN GARCIA LOPEZ', 'Juan Garcia Lopez'],
    ['JUAN GARCIA LOPEZ · паркінг', 'JUAN GARCIA LOPEZ', 'Juan Garcia Lopez'],
    ['Vodafone+380501234567', 'VODAFONE', 'Vodafone'],
    ['AUTOM ES AUTOS 157,JONQUERA, LA,ES', 'AUTOM ES AUTOS', 'Autom Es Autos'],
    ['Скасування. Glovo', 'GLOVO', 'Glovo'],
    [null, 'БЕЗ ОПИСУ', 'Без опису'],
  ])('%s → %s', (note, key, name) => {
    expect(normalizeMerchant(note)).toEqual({ key, name });
  });
});

const monthly = (note: string, amounts: readonly number[], overrides: Partial<LedgerTransaction> = {}) =>
  amounts.map((amount, index) =>
    createRow({ note, amount, date: `2026-${String(6 + index).padStart(2, '0')}-02`, ...overrides }),
  );

describe('detectRecurring', () => {
  it('finds rent, utilities with one estimated month, and a subscription hidden among one-off purchases', () => {
    const transactions = [
      ...monthly('Оренда квартири (готівка)', [1800, 1800, 1800, 1800, 1836], { category: 'Житло' }),
      ...monthly('Комуналка (готівка)', [200, 300, 300], { category: 'Комуналка', date: undefined }).map((row, index) => ({
        ...row,
        date: `2026-${String(8 + index).padStart(2, '0')}-01`,
      })),
      ...monthly('Apple.com/bill', [2.99, 2.99, 2.99, 2.99, 2.99], { category: 'Підписки' }),
      createRow({ note: 'Apple.com/bill', amount: 69.99, date: '2026-07-12', category: 'Підписки' }),
      createRow({ note: 'Apple.com/bill', amount: 5.99, date: '2026-09-19', category: 'Підписки' }),
      ...monthly('Gym', [40, 40, 40], { category: 'Інше' }),
      ...monthly('Glovo', [12, 30, 8, 22, 15]).flatMap((row) => [row, { ...row, id: `${row.id}-b`, date: row.date.replace('-02', '-12') }]),
    ];
    const { payments, monthlyEur } = detectRecurring({ transactions, policies, fx, today: '2026-11-11' });
    expect(payments.map((payment) => [payment.name, payment.eur, payment.occurrences])).toEqual([
      ['Оренда квартири', 1800, 5],
      ['Комуналка', 300, 3],
      ['Gym', 40, 3],
      ['Apple.com/bill', 2.99, 5],
    ]);
    expect(payments[0]).toMatchObject({ lastDate: '2026-10-02', nextDate: '2026-11-02', cadenceDays: 30.5, late: false });
    expect(payments[1]).toMatchObject({ lastDate: '2026-10-01', nextDate: '2026-11-01', late: false });
    expect(payments[2]).toMatchObject({ lastDate: '2026-08-02', late: true });
    expect(monthlyEur).toBeCloseTo(((1800 + 2.99) * 30.4375) / 30.5 + (300 * 30.4375) / 30.5, 1);
  });

  it('measures spread as the interquartile range over the median', () => {
    expect(measureSpread([200, 300, 300])).toBeCloseTo(50 / 300);
    expect(measureSpread([1800, 1800, 1836])).toBeCloseTo(18 / 1800);
  });
});

describe('rankPayees and rankIncomeSources', () => {
  it('nets a released hold and folds bank spellings of one client together', () => {
    const transactions = [
      createRow({ note: 'JAPRAC RENT-A-CAR', amount: 1000, currency: 'UAH', category: 'Подорожі' }),
      createRow({ type: 'income', note: 'Скасування. JAPRAC RENT-A-CAR', amount: 950, currency: 'UAH', category: 'Подорожі' }),
      createRow({ note: 'Mercadona', amount: 30 }),
      createRow({ type: 'income', note: 'Acme LLC', amount: 7200, currency: 'USD', category: 'Зарплата/клієнт', date: '2026-10-03' }),
      createRow({ type: 'income', note: 'Від: Acme LLC', amount: 7200, currency: 'USD', category: 'Зарплата/клієнт' }),
      createRow({
        type: 'income',
        note: 'SWIFT платіж: MT103 від 01/12/2023,6000.00 USD,/URI/PAYMENTACCORDING TO CONTRACT WITHACME LLCENDTOENDID: P98',
        amount: 100,
        currency: 'USD',
        category: 'Зарплата/клієнт',
      }),
    ];
    const months = ['2026-10', '2026-11'];
    expect(rankPayees({ months, transactions, policies, fx }).map((payee) => [payee.name, payee.eur])).toEqual([
      ['Mercadona', 30],
      ['Japrac Rent-a-car', 1],
    ]);
    const [acme, ...others] = rankIncomeSources({ months, transactions, policies, fx });
    expect(others).toEqual([]);
    expect(acme).toMatchObject({ name: 'Acme LLC', count: 3, months: 2, eur: 14500 / 1.25 });
  });
});

describe('investments', () => {
  const account = { id: 'ibkr', currency: 'USD' as const, openingDate: '2026-11-06', openingBalance: 12744 };
  const flows = listFlows({
    account,
    fx,
    transactions: [
      createRow({ type: 'transfer', date: '2026-09-16', accountId: 'mono-eur', amount: 808, toAccountId: 'ibkr', toAmount: 897.68, toCurrency: 'USD', category: null }),
      createRow({ type: 'transfer', date: '2026-06-09', accountId: 'mono-eur', amount: 100, toAccountId: 'ibkr', toAmount: 0, toCurrency: 'USD', category: null }),
      createRow({ type: 'transfer', date: '2026-11-08', accountId: 'ibkr', amount: 50, currency: 'USD', toAccountId: 'mono-usd', category: null }),
    ],
  });

  it('keeps unknown credits unknown but estimates them at the day rate', () => {
    expect(flows.map((flow) => [flow.direction, flow.amount, flow.estimate, flow.beforeOpening])).toEqual([
      ['in', 897.68, 897.68, true],
      ['in', null, 125, true],
      ['out', 50, 50, false],
    ]);
  });

  it('counts spending paid from the account as money taken out', () => {
    const [flow] = listFlows({
      account,
      fx,
      transactions: [createRow({ type: 'expense', date: '2026-10-11', accountId: 'ibkr', amount: 392.5, currency: 'USD', category: 'Мама' })],
    });
    expect(flow).toMatchObject({ direction: 'out', amount: 392.5, counterAccountId: 'Мама', beforeOpening: true });
  });

  it('nets each day before looking for a dip below zero', () => {
    const sameDay = listFlows({
      account,
      fx,
      transactions: [
        createRow({ type: 'transfer', date: '2026-09-05', accountId: 'mono-usd', amount: 1774.51, currency: 'USD', toAccountId: 'ibkr', category: null }),
        createRow({ type: 'transfer', date: '2026-09-05', accountId: 'ibkr', amount: 1774.51, currency: 'USD', toAccountId: 'mono-usd', category: null }),
      ],
    });
    expect(traceStartValue({ flows: sameDay, openingBalance: 0 })).toEqual({ lowest: 0, start: 0 });
  });

  const deposit = (amount: number) =>
    listFlows({
      account,
      fx,
      transactions: [createRow({ type: 'transfer', date: '2026-08-01', accountId: 'mono-usd', amount, currency: 'USD', toAccountId: 'ibkr', category: null })],
    });

  it('reads a small walk-back miss as pre-opening growth, a large one as a missing flow', () => {
    const summary = { unknown: 0, duplicates: 0 };
    expect(listAllTimeIssues({ flows: deposit(1000), openingBalance: 960, summary })).toEqual([]);
    expect(listAllTimeIssues({ flows: deposit(1000), openingBalance: 800, summary })).toEqual(['negative-history']);
  });

  it('separates the gain since opening from the all-time gain', () => {
    const since = summarizeContributions({ flows: flows.filter((flow) => !flow.beforeOpening), value: 12800, base: account.openingBalance });
    expect(since).toMatchObject({ deposits: 0, withdrawals: 50, net: -50, gain: 106, unknown: 0 });
    const allTime = summarizeContributions({ flows, value: 12800, base: 0 });
    expect(allTime).toMatchObject({ deposits: 897.68, net: 847.68, estimatedNet: 972.68, unknown: 1 });
    expect(allTime.gain).toBeCloseTo(12800 - 972.68);
  });

  it('describes a loan by when the money left, and a Splitwise bill as a debt', () => {
    const loan = describeLoan({
      account: { id: 'loan', openingBalance: 4000, openingDate: '2026-11-01' },
      transactions: [createRow({ type: 'transfer', date: '2026-08-24', accountId: 'walt', amount: 2622.56, currency: 'USDT', toAccountId: 'loan', category: null })],
      today: '2026-11-11',
    });
    expect(loan).toEqual({ sentDate: '2026-08-24', sentRecorded: true, lent: 4000, repaid: 0, ageDays: 79 });
    const debt = describeLoan({
      account: { id: 'splitwise', openingBalance: 0, openingDate: '2026-11-01' },
      transactions: [createRow({ date: '2026-11-08', accountId: 'splitwise', amount: 16.8 })],
      today: '2026-11-11',
    });
    expect(debt).toEqual({ sentDate: '2026-11-08', sentRecorded: true, lent: 16.8, repaid: 0, ageDays: 3 });
  });
});

describe('linkChains', () => {
  it('ties a hold to its cancellations and a ФОП sale to its onward leg', () => {
    const hold = createRow({ note: 'JAPRAC RENT-A-CAR', amount: 52141.76, date: '2026-11-08' });
    const release = createRow({ type: 'income', note: 'Скасування. JAPRAC RENT-A-CAR', amount: 51361.07, date: '2026-11-10' });
    const rest = createRow({ type: 'income', note: 'Скасування. JAPRAC RENT-A-CAR', amount: 780.69, date: '2026-11-11' });
    const sale = createRow({ type: 'transfer', accountId: 'fop-usd', amount: 60, toAccountId: 'fop-uah', toAmount: 2727, date: '2026-11-10', category: null });
    const onward = createRow({ type: 'transfer', accountId: 'fop-uah', amount: 2727, toAccountId: 'mono-uah', date: '2026-11-10', category: null });
    const unrelated = createRow({ type: 'transfer', accountId: 'fop-uah', amount: 2727, toAccountId: 'mono-uah', date: '2026-11-20', category: null });
    const chains = linkChains({ transactions: [hold, release, rest, sale, onward, unrelated], passThroughIds: new Set(['fop-uah']) });
    expect([hold, release, rest].map((row) => chains.get(row.id))).toEqual([hold.id, hold.id, hold.id]);
    expect([sale, onward].map((row) => chains.get(row.id))).toEqual([sale.id, sale.id]);
    expect(chains.has(unrelated.id)).toBe(false);
  });
});

describe('suggestCategory', () => {
  const rules = [{ id: 'mcc', pattern: null, mcc: 5411, accountId: null, category: 'Продукти', transferToAccountId: null, priority: 1000 }];
  const history = indexPayeeHistory([
    createRow({ note: 'Bonpreu', category: 'Продукти' }),
    createRow({ note: 'BONPREU 0042', category: 'Продукти' }),
    createRow({ note: 'Bonpreu', category: 'Інше', needsReview: true }),
  ]);

  it('prefers what the owner chose for the payee, then the MCC fallback, else nothing', () => {
    expect(suggestCategory({ transaction: createRow({ note: 'Bonpreu', category: 'Інше' }), history, rules, mcc: 5812 })).toMatchObject({
      category: 'Продукти',
      basis: 'payee',
    });
    expect(suggestCategory({ transaction: createRow({ note: 'Condis' }), history, rules, mcc: 5411 })).toMatchObject({
      category: 'Продукти',
      basis: 'mcc',
      reason: 'MCC 5411 (Супермаркет) зазвичай «Продукти»',
    });
    expect(suggestCategory({ transaction: createRow({ note: 'Невідомо' }), history, rules, mcc: null })).toBeNull();
  });
});

describe('assessDataQuality, summarizeTags and compareMonth', () => {
  const transactions = [
    createRow({ date: '2026-10-02', synced: true }),
    createRow({ date: '2026-10-03', synced: false, source: 'zenmoney' }),
    createRow({ date: '2026-10-04', synced: false, source: 'page', note: 'Комуналка (готівка, орієнтовно)', needsReview: true }),
    createRow({ date: '2026-10-05', synced: false, source: 'claude', tags: ['trip:lisbon'], category: 'Подорожі', amount: 40 }),
    createRow({ date: '2026-10-06', type: 'income', tags: ['trip:lisbon'], category: 'Подорожі', amount: 15 }),
  ];

  it('splits each month by where its rows came from', () => {
    const [september, october] = assessDataQuality({ months: ['2026-09', '2026-10'], transactions, policies, fx, currentMonth: '2026-11' });
    expect(september).toMatchObject({ rows: 0, status: 'missing' });
    expect(october).toMatchObject({ rows: 5, bank: 2, zenmoney: 1, estimated: 1, hand: 1, review: 1, status: 'sparse', hasIncome: false });
  });

  it('nets a trip refund into the trip', () => {
    expect(summarizeTags({ transactions, policies, fx })).toEqual([
      { tag: 'trip:lisbon', eur: 25, rows: 2, from: '2026-10-05', to: '2026-10-06', categories: [{ category: 'Подорожі', eur: 25 }] },
    ]);
  });

  it('averages only the complete months before and reports the ones it left out', () => {
    const stats = ['2026-05', '2026-06', '2026-07', '2026-08', '2026-09', '2026-10', '2026-11'].map((month, index) => ({
      month,
      incomeEur: 1000,
      spendEur: 100 * (index + 1),
      refundEur: 0,
      rows: month === '2026-08' ? 10 : 100,
      sparse: month === '2026-08',
      noIncome: false,
      partial: month === '2026-11',
      categories: { Продукти: 100 * (index + 1) },
    }));
    const comparison = compareMonth({ month: '2026-11', stats, today: '2026-11-11' });
    expect(comparison.average.spendEur).toBe((100 + 200 + 300 + 500 + 600) / 5);
    expect(comparison.averageMonths.filter((entry) => !entry.used)).toEqual([{ month: '2026-08', reason: 'sparse', used: false }]);
    expect(comparison).toMatchObject({ daysElapsed: 11, daysInMonth: 30, lastYear: null, lastYearSparse: true, projection: null });
  });
});
