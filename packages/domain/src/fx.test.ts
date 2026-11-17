import { describe, expect, it } from 'vitest';

import { createFxConverter } from './fx.ts';

const fx = createFxConverter({
  daily: [
    { date: '2026-11-11', currency: 'UAH', perEur: 50, source: 'nbu' },
    { date: '2026-11-01', currency: 'USD', perEur: 1.15 },
  ],
  yearly: [{ year: 2026, currency: 'UAH', perEur: 40 }],
});

describe('describeRate', () => {
  it('says which rate converted the amount', () => {
    expect(fx.describeRate('UAH', '2026-11-12')).toEqual({
      currency: 'UAH',
      perEur: 50,
      kind: 'daily',
      date: '2026-11-11',
      year: null,
      source: 'nbu',
    });
    expect(fx.describeRate('UAH', '2026-11-10')).toMatchObject({ kind: 'yearly', perEur: 40, year: 2026, date: null });
    expect(fx.describeRate('UAH', '2027-03-01')).toMatchObject({ kind: 'latest', perEur: 50, date: '2026-11-11' });
    expect(fx.describeRate('EUR', '2020-01-01')).toMatchObject({ kind: 'base', perEur: 1 });
    expect(fx.describeRate('GBP', '2026-11-11')).toBeNull();
  });

  it('always agrees with findRate', () => {
    for (const [currency, date] of [
      ['UAH', '2026-11-12'],
      ['UAH', '2026-11-19'],
      ['UAH', '2025-01-01'],
      ['USD', '2026-11-09'],
      ['USD', '2026-12-01'],
      ['GBP', '2026-11-11'],
    ] as const) {
      expect(fx.describeRate(currency, date)?.perEur ?? null).toBe(fx.findRate(currency, date));
    }
  });
});
