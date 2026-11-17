import { describe, expect, it } from 'vitest';

import { type Chart, ChartSchema, findTicks, renderChart } from './chart.ts';

const PNG_SIGNATURE = Buffer.from([0x89, 0x50, 0x4e, 0x47]);

describe('findTicks', () => {
  it('steps by a round number and covers both ends', () => {
    expect(findTicks({ low: 0, high: 4100, count: 4 })).toEqual([0, 2000, 4000, 6000]);
    expect(findTicks({ low: 41_200, high: 55_400, count: 4 })).toEqual([40_000, 45_000, 50_000, 55_000, 60_000]);
  });

  it('keeps zero on an axis that crosses it', () => {
    expect(findTicks({ low: -120, high: 1100, count: 4 })).toContain(0);
  });

  it('still spans a range when every value is the same', () => {
    expect(findTicks({ low: 500, high: 500, count: 4 })).toEqual([400, 600]);
  });
});

describe('ChartSchema', () => {
  const chart = { title: 'Витрати', kind: 'column', labels: ['січ', 'лют'], series: [{ name: 'Витрати', values: [1] }] };

  it('wants a value for every label', () => {
    expect(ChartSchema.safeParse(chart).success).toBe(false);
    expect(ChartSchema.safeParse({ ...chart, series: [{ name: 'Витрати', values: [1, 2] }] }).success).toBe(true);
  });
});

describe('renderChart', () => {
  const months = ['січ', 'лют', 'бер'];
  const cases: Chart[] = [
    { title: 'Категорії', kind: 'bar', unit: '€', labels: ['Їжа', 'Здоровʼя', 'Повернення'], series: [{ name: 'Жовтень', values: [612, 40, -120] }] },
    { title: 'Місяці', kind: 'column', unit: '€', labels: months, series: [{ name: 'Дохід', values: [4200, 4300, 4100] }, { name: 'Витрати', values: [2100, -50, 1800] }] },
    { title: 'Net worth', kind: 'line', unit: '€', labels: months, series: [{ name: 'Net worth', values: [41_200, 42_800, 43_100] }] },
  ];

  it.each(cases)('draws a $kind chart', async (chart) => {
    expect((await renderChart(chart)).subarray(0, 4)).toEqual(PNG_SIGNATURE);
  });
});
