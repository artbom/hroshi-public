import type { MonthStats } from '@hroshi/schema';
import { useState } from 'react';

import { describeError } from '../api.ts';
import { SectionHead } from '../components/InfoTip.tsx';
import { Nothing } from '../components/Nothing.tsx';
import { ScrollTable } from '../components/ScrollTable.tsx';
import { formatEur, formatPercent, formatSignedEur, keepTogether } from '../format.ts';
import { findCurrentMonth } from '../months.ts';
import { useCategories, useTrends } from '../queries.ts';
import { buildTableHref } from '../route.ts';
import { findRefundCategory, groupCategories, indexParents } from './rollup.ts';
import { roundToTotal } from './sums.ts';

/** The ledger's first full year; December 2021 alone is not a year. */
const FIRST_YEAR = 2022;

type YearTotals = {
  year: string;
  /** Months of the year with any rows, the running one included. */
  months: number;
  running: boolean;
  incomeEur: number;
  spendEur: number;
  refundEur: number;
  categories: Map<string, number>;
};

/** A category shown on its own row needs at least this much over all the years. */
const MIN_ROW_TOTAL = 1;
/** Below half a euro a cell would print «0 €». */
const SHOWN_EUR = 0.5;

/** One line of the table: a category, the refunds, or the small categories folded together. */
type YearRow = { key: string; label: string; href: ((year: string) => string) | null; values: ReadonlyMap<string, number> };

const sumYears = (months: readonly MonthStats[]): YearTotals[] =>
  [...Map.groupBy(months, (stats) => stats.month.slice(0, 4))].map(([year, stats]) => {
    const categories = new Map<string, number>();
    for (const entry of stats) {
      for (const [category, eur] of Object.entries(entry.categories)) categories.set(category, (categories.get(category) ?? 0) + eur);
    }
    return {
      year,
      months: stats.filter((entry) => entry.rows > 0).length,
      running: stats.some((entry) => entry.partial),
      incomeEur: stats.reduce((sum, entry) => sum + entry.incomeEur, 0),
      spendEur: stats.reduce((sum, entry) => sum + entry.spendEur, 0),
      refundEur: stats.reduce((sum, entry) => sum + entry.refundEur, 0),
      categories,
    };
  });

const sumGroup = (year: YearTotals, members: readonly string[]) =>
  members.reduce((sum, member) => sum + (year.categories.get(member) ?? 0), 0);

const MODES = [
  { value: 'year', label: 'за рік' },
  { value: 'month', label: 'на місяць' },
] as const;
type Mode = (typeof MODES)[number]['value'];

const yearRange = (year: string) => ({ from: `${year}-01`, to: `${year}-12` });

const sumValues = (values: ReadonlyMap<string, number>) => [...values.values()].reduce((sum, value) => sum + value, 0);

/**
 * Year × category: how the shape of spending changed since the ledger began. Each year's column adds
 * up to its «Витрати»: refunds are their own negative row, the smallest categories one folded row,
 * and whole euros are rounded so the rows give the total.
 */
export const YearSection = ({ spreadTax }: { spreadTax: boolean }) => {
  const current = findCurrentMonth();
  const range = (Number(current.slice(0, 4)) - FIRST_YEAR) * 12 + Number(current.slice(5, 7));
  const trends = useTrends({ month: current, range, spreadTax });
  const categoryList = useCategories().data;
  const parents = indexParents(categoryList);
  const [mode, setMode] = useState<Mode>('year');

  if (trends.isError) return <p className="note err">{describeError(trends.error)}</p>;
  if (trends.data === undefined) return null;

  // Newest first: on a phone the current year is the column next to the names, not off-screen.
  const years = sumYears(trends.data.months).toReversed();
  const scale = (year: YearTotals, eur: number) => (mode === 'month' ? eur / Math.max(1, year.months) : eur);
  // Subcategories are summed into their parent; their own split is in the heatmap.
  const groups = groupCategories({ names: years.flatMap((year) => [...year.categories.keys()]), parents }).map((group) => ({
    category: group.name,
    values: new Map(years.map((year) => [year.year, sumGroup(year, group.members)])),
  }));
  const shown = groups.filter((group) => Math.abs(sumValues(group.values)) >= MIN_ROW_TOTAL).toSorted((left, right) => sumValues(right.values) - sumValues(left.values));
  const small = groups.filter((group) => Math.abs(sumValues(group.values)) < MIN_ROW_TOTAL);
  const refundCategory = findRefundCategory(categoryList);
  const rows: YearRow[] = [
    ...shown.map(({ category, values }) => ({
      key: category,
      label: category,
      href: (year: string) => buildTableHref({ category, ...yearRange(year) }),
      values,
    })),
    {
      key: 'refund',
      label: refundCategory,
      href: (year: string) => buildTableHref({ type: 'income', category: refundCategory, ...yearRange(year) }),
      values: new Map(years.map((year) => [year.year, -year.refundEur])),
    },
    ...(small.length === 0
      ? []
      : [
          {
            key: 'small',
            label: 'Дрібні категорії',
            href: null,
            values: new Map(years.map((year) => [year.year, small.reduce((sum, group) => sum + (group.values.get(year.year) ?? 0), 0)])),
          },
        ]),
  ].filter((row) => [...row.values.values()].some((value) => Math.abs(value) >= SHOWN_EUR));
  // Per year, the rows' whole euros are rounded together, so they add up to that year's «Витрати».
  const rounded = new Map(
    years.map((year) => [year.year, roundToTotal(rows.map((row) => scale(year, row.values.get(year.year) ?? 0)))]),
  );
  const showCell = (year: string, index: number) => rounded.get(year)?.[index] ?? 0;
  const spendOf = (year: string) => (rounded.get(year) ?? []).reduce((sum, value) => sum + value, 0);

  return (
    <section>
      <SectionHead
        title="По роках · усі роки"
        info={
          <>
            <p>Витрати за категоріями по календарних роках, у євро за курсом дня, мінус повернення в їхніх категоріях.</p>
            <p>
              Кожен стовпець складається у «Витрати»: «{refundCategory}» — повернення без категорії, вони зменшують підсумок;
              категорії, що за всі роки не набрали й євро, зібрані в «Дрібні категорії». Суми округлено так, щоб рядки давали
              підсумок.
            </p>
            <p>
              «На місяць» ділить рік на місяці, у яких є записи, тож поточний рік і роки з прогалинами можна порівнювати. Повнота
              кожного місяця — у «Повноті даних» розділу «Доходи й витрати».
            </p>
          </>
        }
      >
        <div className="seg" role="group" aria-label="Суми">
          {MODES.map((option) => (
            <button key={option.value} type="button" aria-pressed={option.value === mode} onClick={() => setMode(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
      </SectionHead>
      <ScrollTable className="year-scroll">
        <div className="tbl wide-table year-table">
          <table>
            <thead>
              <tr>
                <th scope="col">Категорія</th>
                {years.map((year) => (
                  <th key={year.year} scope="col" className="r">
                    {year.year}
                    <span className="th-sub">
                      {year.months}&nbsp;міс.{year.running ? ', триває' : ''}
                    </span>
                  </th>
                ))}
              </tr>
            </thead>
            <tbody>
              <tr className="lead">
                <th scope="row">Дохід</th>
                {years.map((year) => (
                  <td key={year.year} className="r num pos">
                    {formatEur(scale(year, year.incomeEur))}
                  </td>
                ))}
              </tr>
              <tr className="lead">
                <th scope="row">Відкладено</th>
                {years.map((year) => (
                  <td key={year.year} className="r num">
                    {formatSignedEur(scale(year, year.incomeEur - year.spendEur))}
                    {year.incomeEur > 0 && <div className="small muted">{formatPercent((year.incomeEur - year.spendEur) / year.incomeEur)}</div>}
                  </td>
                ))}
              </tr>
              <tr className="lead total">
                <th scope="row">Витрати</th>
                {years.map((year) => (
                  <td key={year.year} className="r num">
                    <a className="plain" href={buildTableHref({ type: 'expense', ...yearRange(year.year) })}>
                      {formatEur(spendOf(year.year))}
                    </a>
                  </td>
                ))}
              </tr>
              {rows.map((row, index) => (
                <tr key={row.key}>
                  <th scope="row" className={row.href === null ? 'muted' : undefined}>
                    {keepTogether(row.label)}
                  </th>
                  {years.map((year) => {
                    const eur = row.values.get(year.year) ?? 0;
                    const cell = showCell(year.year, index);
                    if (Math.abs(eur) < SHOWN_EUR && cell === 0)
                      return (
                        <td key={year.year} className="r num muted">
                          <Nothing why={`У ${year.year} році тут нічого`} />
                        </td>
                      );
                    return (
                      <td key={year.year} className={`r num ${eur < 0 ? 'pos' : ''}`.trim()}>
                        {row.href === null ? (
                          formatEur(cell)
                        ) : (
                          <a className="plain" href={row.href(year.year)}>
                            {formatEur(cell)}
                          </a>
                        )}
                      </td>
                    );
                  })}
                </tr>
              ))}
            </tbody>
          </table>
        </div>
      </ScrollTable>
    </section>
  );
};
