import { describe, expect, it } from 'vitest';

import { aggregateMonths, summarizeTrends } from './aggregate.ts';
import { computeBalances } from './balances.ts';
import { classifyTransaction, indexCategoryPolicies } from './classify.ts';
import { createFxConverter } from './fx.ts';
import { extractMerchant, rankMerchants } from './merchants.ts';
import { listMonthsBack } from './months.ts';
import { summarizeNetWorth } from './net-worth.ts';
import { findMatchingRule } from './rules.ts';
import type { LedgerAccount, LedgerTransaction, MatchableRule } from './types.ts';

const policies = indexCategoryPolicies([
  { name: 'Кафе і ресторани', incomeRole: 'netting', countsAsSpending: true },
  { name: 'Інше', incomeRole: 'ignored', countsAsSpending: true },
  { name: 'Зарплата/клієнт', incomeRole: 'earning', countsAsSpending: true },
  { name: 'Повернення', incomeRole: 'refund', countsAsSpending: true },
  { name: 'Інвестиції', incomeRole: 'ignored', countsAsSpending: false },
]);

const createTransaction = (overrides: Partial<LedgerTransaction>): LedgerTransaction => ({
  type: 'expense',
  date: '2026-11-05',
  accountId: 'card',
  amount: 10,
  currency: 'EUR',
  toAccountId: null,
  toAmount: null,
  toCurrency: null,
  category: 'Кафе і ресторани',
  note: null,
  ...overrides,
});

const createTransfer = (toAmount: number | null) =>
  createTransaction({ type: 'transfer', amount: 10, toAccountId: 'uah', toAmount, category: null });

const createRule = (overrides: Partial<MatchableRule>): MatchableRule => ({
  id: 'rule',
  pattern: null,
  mcc: null,
  accountId: null,
  category: 'Інше',
  transferToAccountId: null,
  priority: 100,
  ...overrides,
});

const fx = createFxConverter({
  daily: [{ date: '2026-11-11', currency: 'UAH', perEur: 50 }],
  yearly: [{ year: 2026, currency: 'UAH', perEur: 40 }],
});

describe('computeBalances', () => {
  const accounts: LedgerAccount[] = [
    { id: 'card', currency: 'EUR', kind: 'everyday', openingBalance: 100, openingDate: '2026-11-01' },
    { id: 'uah', currency: 'UAH', kind: 'everyday', openingBalance: 0, openingDate: '2026-11-01' },
  ];

  it('ignores rows dated before the opening date, so back-filled history never moves a balance', () => {
    const balances = computeBalances({
      accounts,
      transactions: [createTransaction({ date: '2026-10-31' }), createTransaction({ amount: 30 })],
    });
    expect(balances.get('card')).toBe(70);
  });

  it('credits toAmount, falls back to amount when missing, and moves nothing when it is zero', () => {
    const balances = computeBalances({ accounts, transactions: [createTransfer(450), createTransfer(null), createTransfer(0)] });
    expect(balances.get('card')).toBe(70);
    expect(balances.get('uah')).toBe(460);
  });

  it('applies signed valuations', () => {
    const balances = computeBalances({
      accounts,
      transactions: [createTransaction({ type: 'valuation', amount: -12.5, category: null })],
    });
    expect(balances.get('card')).toBe(87.5);
  });
});

describe('classifyTransaction', () => {
  it.each([
    [{ type: 'expense', category: 'Кафе і ресторани' }, { kind: 'spend', category: 'Кафе і ресторани', sign: 1 }],
    [{ type: 'income', category: 'Кафе і ресторани' }, { kind: 'spend', category: 'Кафе і ресторани', sign: -1 }],
    [{ type: 'income', category: 'Зарплата/клієнт' }, { kind: 'income' }],
    [{ type: 'income', category: 'Повернення' }, { kind: 'refund' }],
    [{ type: 'income', category: 'Інше' }, { kind: 'none' }],
    [{ type: 'income', category: null }, { kind: 'none' }],
    [{ type: 'expense', category: 'Інвестиції' }, { kind: 'none' }],
    [{ type: 'expense', category: null }, { kind: 'spend', category: 'Інше', sign: 1 }],
    [{ type: 'transfer', category: null }, { kind: 'none' }],
    [{ type: 'valuation', category: null }, { kind: 'none' }],
  ] as const)('%o → %o', (transaction, effect) => {
    expect(classifyTransaction(transaction, policies)).toEqual(effect);
  });
});

describe('createFxConverter', () => {
  it('prefers a recent daily rate, then the yearly average, then the latest daily rate', () => {
    expect(fx.findRate('UAH', '2026-11-12')).toBe(50);
    expect(fx.findRate('UAH', '2026-11-10')).toBe(40);
    expect(fx.findRate('UAH', '2027-03-01')).toBe(50);
    expect(fx.findRate('EUR', '2020-01-01')).toBe(1);
    expect(fx.findRate('GBP', '2026-11-11')).toBeNull();
  });
});

describe('aggregateMonths', () => {
  it('nets refunds into their category, excludes ignored income and flags sparse and partial months', () => {
    const [october, november] = aggregateMonths({
      months: ['2026-10', '2026-11'],
      policies,
      fx,
      currentMonth: '2026-11',
      transactions: [
        createTransaction({ date: '2026-10-03', amount: 50 }),
        createTransaction({ date: '2026-10-04', type: 'income', amount: 20 }),
        createTransaction({ date: '2026-10-05', type: 'income', amount: 1000, category: 'Зарплата/клієнт' }),
        createTransaction({ date: '2026-10-06', type: 'income', amount: 500, category: 'Інше' }),
        createTransaction({ date: '2026-10-07', type: 'income', amount: 5, category: 'Повернення' }),
      ],
    });
    expect(october).toMatchObject({
      incomeEur: 1000,
      spendEur: 25,
      refundEur: 5,
      rows: 5,
      sparse: true,
      partial: false,
      categories: { 'Кафе і ресторани': 30 },
    });
    expect(november).toMatchObject({ rows: 0, noIncome: true, partial: true });
  });

  it('averages only complete months', () => {
    const months = listMonthsBack({ until: '2026-11', count: 3 });
    const stats = months.map((month, index) => ({
      month,
      incomeEur: 1000,
      spendEur: 400 + index * 100,
      refundEur: 0,
      rows: 100,
      sparse: false,
      noIncome: false,
      partial: index === 2,
      categories: {},
    }));
    expect(summarizeTrends(stats).averages).toEqual({
      incomeEur: 1000,
      spendEur: 450,
      savedEur: 550,
      savingsRate: 0.55,
      completeMonths: 2,
      totalMonths: 3,
    });
  });
});

describe('summarizeNetWorth', () => {
  it('splits credit-card debt and receivables into their own buckets', () => {
    const accounts: LedgerAccount[] = [
      { id: 'cash', currency: 'EUR', kind: 'cash', openingBalance: 0, openingDate: '2026-11-01' },
      { id: 'credit', currency: 'UAH', kind: 'credit', openingBalance: 0, openingDate: '2026-11-01' },
      { id: 'broker', currency: 'EUR', kind: 'investment', openingBalance: 0, openingDate: '2026-11-01' },
      { id: 'owed', currency: 'EUR', kind: 'receivable', openingBalance: 0, openingDate: '2026-11-01' },
      { id: 'owe', currency: 'EUR', kind: 'receivable', openingBalance: 0, openingDate: '2026-11-01' },
    ];
    const balances = new Map([
      ['cash', 500],
      ['credit', -5000],
      ['broker', 1000],
      ['owed', 200],
      ['owe', -20],
    ]);
    expect(summarizeNetWorth({ accounts, balances, fx, date: '2026-11-11' })).toEqual({
      totalEur: 1580,
      cashEur: 500,
      investmentsEur: 1000,
      owedToMeEur: 200,
      creditDebtEur: -100,
      iOweEur: -20,
    });
  });
});

describe('findMatchingRule', () => {
  const rules = [
    createRule({ id: 'lime', pattern: 'lime', category: 'Транспорт' }),
    createRule({ id: '365', pattern: '365', category: 'Кафе і ресторани', priority: 150 }),
    createRule({ id: 'uber', pattern: 'uber', category: 'Транспорт' }),
    createRule({ id: 'uber-eats', pattern: 'uber eats', category: 'Кафе і ресторани', priority: 50 }),
    createRule({ id: 'grocery-mcc', mcc: 5411, category: 'Продукти', priority: 1000 }),
  ];
  const match = (text: string, mcc: number | null = null) =>
    findMatchingRule(rules, { accountId: 'card', mcc, texts: [text] })?.id;

  it('matches whole words only', () => {
    expect(match('LIME*RIDE')).toBe('lime');
    expect(match('T262 BCN45 ALIMENTACIO', 5411)).toBe('grocery-mcc');
    expect(match('365 T196')).toBe('365');
    expect(match('Vodafone+380501234568')).toBeUndefined();
  });

  it('lets a more specific rule win by priority', () => {
    expect(match('Uber Eats')).toBe('uber-eats');
    expect(match('Uber')).toBe('uber');
  });
});

describe('extractMerchant', () => {
  it('keeps the leading merchant name', () => {
    expect(extractMerchant('DANYLO KURYLO · частка за Glovo')).toBe('DANYLO KURYLO');
    expect(extractMerchant('Mercadona (Gràcia)')).toBe('Mercadona');
    expect(extractMerchant(null)).toBe('Без опису');
    expect(extractMerchant('Скасування. JAPRAC RENT-A-CAR')).toBe('JAPRAC RENT-A-CAR');
  });

  it('nets a released hold against the purchase in the merchant ranking', () => {
    const japrac = { category: 'Подорожі', currency: 'UAH', date: '2026-11-08' } as const;
    expect(
      rankMerchants({
        category: 'Подорожі',
        months: ['2026-11'],
        policies: indexCategoryPolicies([{ name: 'Подорожі', incomeRole: 'netting', countsAsSpending: true }]),
        fx,
        transactions: [
          createTransaction({ ...japrac, amount: 52141.76, note: 'JAPRAC RENT-A-CAR' }),
          createTransaction({ ...japrac, type: 'income', amount: 51361.07, note: 'Скасування. JAPRAC RENT-A-CAR' }),
        ],
      }),
    ).toEqual([{ merchant: 'Japrac Rent-a-car', key: 'JAPRAC RENT A CAR', eur: expect.closeTo(780.69 / 40, 5) }]);
  });
});
