import type { MonthComparison } from '@hroshi/schema';
import { useState } from 'react';

import { SectionHead } from '../components/InfoTip.tsx';
import { Nothing } from '../components/Nothing.tsx';
import {
  formatBaseline,
  formatEur,
  formatMonthLong,
  formatSignedEur,
  formatSignedPercent,
  keepTogether,
  pluralize,
} from '../format.ts';
import { useCategories } from '../queries.ts';
import { buildTableHref } from '../route.ts';
import { findRefundCategory, groupCategories, indexParents, sumMembers } from './rollup.ts';
import { roundColumn } from './sums.ts';

/** A change smaller than this is noise, not a trend. */
const NOTABLE_EUR = 5;
const MOVERS = 5;
/** Below half a euro a figure prints as «0 €»; such a row says nothing. */
const SHOWN_EUR = 0.5;

type Row = {
  key: string;
  label: string;
  /** The rows behind the figures; null for the folded remainder, which has no single filter. */
  href: string | null;
  /** Recorded so far. */
  now: number;
  /** Monthly payments due this month and not recorded yet. */
  expected: number;
  /** Where the month ends: recorded + expected + its share of the month's pace. */
  forecast: number;
  usual: number;
  year: number | null;
  /** The forecast (or the finished month) against the usual level. */
  change: number;
  children: readonly Row[];
};

type Column = 'now' | 'expected' | 'forecast' | 'usual' | 'year' | 'change';

const COLUMNS: readonly Column[] = ['now', 'expected', 'forecast', 'usual', 'year', 'change'];

const formatChangeShare = (change: number, usual: number) => (usual > 0 ? formatSignedPercent(change / usual) : null);

const isShown = (row: Pick<Row, 'now' | 'expected' | 'forecast' | 'usual' | 'year'>) =>
  [row.now, row.expected, row.forecast, row.usual, row.year ?? 0].some((value) => Math.abs(value) >= SHOWN_EUR);

const hasSpending = (row: Row) => Math.abs(row.now) >= SHOWN_EUR || row.expected >= SHOWN_EUR;

/** Rows added together: the remainder line and the total are sums of what they stand for. */
const sumRows = ({ key, label, rows, hasYear }: { key: string; label: string; rows: readonly Row[]; hasYear: boolean }): Row => {
  const add = (pick: (row: Row) => number) => rows.reduce((sum, row) => sum + pick(row), 0);
  return {
    key,
    label,
    href: null,
    now: add((row) => row.now),
    expected: add((row) => row.expected),
    forecast: add((row) => row.forecast),
    usual: add((row) => row.usual),
    year: hasYear ? add((row) => row.year ?? 0) : null,
    change: add((row) => row.change),
    children: [],
  };
};

/**
 * The month (the end of the chosen period) against its usual level and the same month a year ago,
 * per category. Every column adds up to «Витрати разом»: refunds are their own negative row, the
 * categories with nothing this month are one folded row, and whole euros are rounded so they sum.
 */
export const ComparisonSection = ({ comparison }: { comparison: MonthComparison }) => {
  const categories = useCategories();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const { month, current, average, lastYear, projection, daysElapsed, daysInMonth } = comparison;
  const baselineLabel = formatBaseline(comparison.averageMonths.filter((entry) => entry.used).length);
  const running = projection !== null && daysElapsed > 0 && daysElapsed < daysInMonth;
  const expected = running ? (projection?.expectedByCategory ?? {}) : {};
  const pace = running ? (projection?.paceByCategory ?? {}) : {};
  const hasYear = lastYear !== null;
  const monthLink = (filter: Readonly<Record<string, string>>) => buildTableHref({ ...filter, from: month, to: month });

  const buildRow = ({ key, label, category, members }: { key: string; label: string; category: string; members: readonly string[] }): Row => {
    const now = sumMembers({ values: current.categories, members });
    const due = sumMembers({ values: expected, members });
    const forecast = now + due + sumMembers({ values: pace, members });
    const usual = sumMembers({ values: average.categories, members });
    const year = lastYear === null ? null : sumMembers({ values: lastYear.categories, members });
    return { key, label, href: monthLink({ category }), now, expected: due, forecast, usual, year, change: forecast - usual, children: [] };
  };

  const names = [current, average, lastYear ?? { categories: {} }].flatMap((totals) => Object.keys(totals.categories));
  const rows: Row[] = groupCategories({ names: [...names, ...Object.keys(expected), ...Object.keys(pace)], parents: indexParents(categories.data) })
    .map((group) => {
      const row = buildRow({ key: group.name, label: group.name, category: group.name, members: group.members });
      if (group.children.length === 0) return row;
      const children = [
        buildRow({ key: `${group.name}/`, label: `${group.name} (без підкатегорії)`, category: group.name, members: [group.name] }),
        ...group.children.map((child) => buildRow({ key: `${group.name}/${child}`, label: child, category: child, members: [child] })),
      ]
        .filter(isShown)
        .toSorted((left, right) => right.forecast - left.forecast);
      return { ...row, children };
    })
    .toSorted((left, right) => right.forecast - left.forecast || right.usual - left.usual);

  const spent = rows.filter(hasSpending);
  // Everything else, tiny rows included, is one line: the columns still add up to the total.
  const quiet = rows.filter((row) => !hasSpending(row));
  const quietShown = quiet.filter(isShown);
  const refundCategory = findRefundCategory(categories.data);
  const refund: Row = {
    key: 'refund',
    label: refundCategory,
    href: monthLink({ type: 'income', category: refundCategory }),
    now: -current.refundEur,
    expected: 0,
    forecast: -current.refundEur,
    usual: -average.refundEur,
    year: lastYear === null ? null : -lastYear.refundEur,
    change: average.refundEur - current.refundEur,
    children: [],
  };
  const rest = sumRows({
    key: 'rest',
    label: `Ще ${pluralize(quietShown.length, ['категорія', 'категорії', 'категорій'])} без витрат цього місяця`,
    rows: quiet,
    hasYear,
  });
  const tableRows = [...spent, ...(isShown(refund) ? [refund] : []), ...(quietShown.length > 0 ? [rest] : [])];
  const total = sumRows({ key: 'total', label: 'Витрати разом', rows: tableRows, hasYear });
  const rounded = new Map(COLUMNS.map((column) => [column, roundColumn({ rows: tableRows, pick: (row) => row[column] ?? 0, key: (row) => row.key })]));
  const show = (row: Row, column: Column) => rounded.get(column)?.get(row.key) ?? Math.round(row[column] ?? 0);
  const showTotal = (column: Column) => tableRows.reduce((sum, row) => sum + show(row, column), 0);

  const movers = spent
    .filter((row) => Math.abs(row.change) >= NOTABLE_EUR)
    .toSorted((left, right) => Math.abs(right.change) - Math.abs(left.change))
    .slice(0, MOVERS);
  const yearLabel = formatMonthLong(`${Number(month.slice(0, 4)) - 1}${month.slice(4)}`);
  const incomeChange = current.incomeEur - average.incomeEur;
  const toggle = (key: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });

  /** A row's figures; `pick` reads the rounded column for summed rows and the raw one for subcategories. */
  const renderFigures = ({ row, pick, strong = false }: { row: Row; pick: (column: Column) => number; strong?: boolean }) => {
    const notable = Math.abs(row.change) >= NOTABLE_EUR;
    const share = formatChangeShare(row.change, row.usual);
    const now = formatEur(pick('now'));
    return (
      <>
        <td className={`r num ${row.now < 0 ? 'pos' : ''}`.trim()}>{strong ? <b>{now}</b> : now}</td>
        {running && (
          <>
            <td className="r num warn">{row.expected >= SHOWN_EUR ? formatEur(pick('expected')) : <Nothing why="Регулярних платежів не очікується" />}</td>
            <td className={`r num ${row.forecast < 0 ? 'pos' : ''}`.trim()}>{formatEur(pick('forecast'))}</td>
          </>
        )}
        <td className="r num muted">{formatEur(pick('usual'))}</td>
        <td className={`r num ${notable ? (row.change > 0 ? 'neg' : 'pos') : 'muted'}`}>{formatSignedEur(pick('change'))}</td>
        <td className="r num muted">{share ?? <Nothing why="Звично тут нічого не було, відсоток не має сенсу" />}</td>
        <td className="r num muted">{row.year === null ? <Nothing why="За той місяць минулого року даних немає" /> : formatEur(pick('year'))}</td>
      </>
    );
  };

  const describeCard = (row: Row, pick: (column: Column) => number) =>
    [
      running ? `записано ${formatEur(pick('now'))}` : null,
      running && row.expected >= SHOWN_EUR ? `очікується ${formatEur(pick('expected'))}` : null,
      `звично ${formatEur(pick('usual'))}`,
      row.year === null ? null : `${yearLabel}: ${formatEur(pick('year'))}`,
    ]
      .filter((part) => part !== null)
      .join(' · ');

  const renderCard = ({ row, pick, strong = false }: { row: Row; pick: (column: Column) => number; strong?: boolean }) => {
    const notable = Math.abs(row.change) >= NOTABLE_EUR;
    const share = formatChangeShare(row.change, row.usual);
    const main = formatEur(pick(running ? 'forecast' : 'now'));
    const body = (
      <>
        <span className="cmp-card-name">{keepTogether(row.label)}</span>
        <span className={`num cmp-card-main ${row.forecast < 0 ? 'pos' : ''}`.trim()}>{strong ? <b>{main}</b> : main}</span>
        <span className="cmp-card-sub small muted">{describeCard(row, pick)}</span>
        <span className={`cmp-card-delta small num ${notable ? (row.change > 0 ? 'neg' : 'pos') : 'muted'}`}>
          Δ {formatSignedEur(pick('change'))}
          {share !== null && ` · ${share}`}
        </span>
      </>
    );
    return row.href === null ? (
      <div key={row.key} className={strong ? 'cmp-card total' : 'cmp-card'}>
        {body}
      </div>
    ) : (
      <a key={row.key} className="cmp-card" href={row.href}>
        {body}
      </a>
    );
  };

  return (
    <section>
      <SectionHead
        title={`${formatMonthLong(month)} проти звичного`}
        info={
          <>
            <p>
              Це останній місяць обраного періоду. «{baselineLabel}» — середнє за повні місяці серед {comparison.averageMonths.length}{' '}
              попередніх; «{yearLabel}» — той самий місяць минулого року.
            </p>
            {running && (
              <p>
                Місяць триває ({daysElapsed} з {daysInMonth} днів). «Записано» — те, що вже є в записах. «Очікується» — регулярні
                платежі, яких цього місяця ще немає в записах. «Прогноз» — записано + очікується + звичайні витрати в тому ж темпі до
                кінця місяця; темп ділиться між категоріями за їхніми повсякденними витратами, тож прогнози категорій дають той самий
                прогноз місяця, що й на «Огляді».
              </p>
            )}
            <p>
              Кожен стовпець складається в «Витрати разом»: «{refundCategory}» — повернення без категорії, вони зменшують підсумок;
              категорії без витрат цього місяця зібрані в один рядок. Суми округлено до євро так, щоб рядки давали підсумок.
            </p>
            {comparison.lastYearSparse && <p>Минулий рік у цьому місяці неповний, тож порівняння з ним умовне.</p>}
            <p>Дохід приходить кількома платежами, тож порівнюється записане з повним звичним рівнем, без прогнозу.</p>
          </>
        }
      >
        <span className="small muted">останній місяць періоду</span>
      </SectionHead>
      {movers.length > 0 && (
        <div className="small muted" style={{ marginBottom: 6 }}>
          Найбільші зміни{running ? ' за прогнозом' : ''} проти {baselineLabel}:
        </div>
      )}
      {movers.length > 0 && (
        <div className="movers" aria-label={`Найбільші зміни: ${pluralize(movers.length, ['категорія', 'категорії', 'категорій'])}`}>
          {movers.map((row) => (
            <a key={row.key} className="bucket" href={row.href ?? undefined}>
              <span className="small muted">{row.label}</span>
              <span className={`num ${row.change > 0 ? 'neg' : 'pos'}`}>
                {row.change > 0 ? '▲' : '▼'}&nbsp;{formatSignedEur(show(row, 'change'))}
              </span>
              <span className="small muted">{formatChangeShare(row.change, row.usual) ?? 'нове'}</span>
            </a>
          ))}
        </div>
      )}
      <div className="tbl wide-table cmp-table">
        <table>
          <thead>
            <tr>
              <th scope="col">Категорія</th>
              {running ? (
                <>
                  <th scope="col" className="r">
                    Записано
                  </th>
                  <th scope="col" className="r">
                    Очікується
                  </th>
                  <th scope="col" className="r">
                    Прогноз
                  </th>
                </>
              ) : (
                <th scope="col" className="r">
                  {formatMonthLong(month)}
                </th>
              )}
              <th scope="col" className="r">
                {baselineLabel}
              </th>
              <th scope="col" className="r">
                Δ €
              </th>
              <th scope="col" className="r">
                Δ %
              </th>
              <th scope="col" className="r">
                {yearLabel}
              </th>
            </tr>
          </thead>
          <tbody>
            <tr className="income">
              <th scope="row">
                <a className="plain" href={monthLink({ type: 'income' })}>
                  Дохід
                </a>
              </th>
              <td className="r num pos">{formatEur(current.incomeEur)}</td>
              {running && (
                <>
                  <td className="r num muted">
                    <Nothing why="Дохід не прогнозується" />
                  </td>
                  <td className="r num muted">
                    <Nothing why="Дохід не прогнозується" />
                  </td>
                </>
              )}
              <td className="r num muted">{formatEur(average.incomeEur)}</td>
              <td className={`r num ${incomeChange < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(incomeChange)}</td>
              <td className="r num muted">{formatChangeShare(incomeChange, average.incomeEur) ?? <Nothing why="Звично доходу не було" />}</td>
              <td className="r num muted">{lastYear === null ? <Nothing why="За той місяць минулого року даних немає" /> : formatEur(lastYear.incomeEur)}</td>
            </tr>
            <tr className="total">
              <th scope="row">
                <a className="plain" href={monthLink({ type: 'expense' })}>
                  {total.label}
                </a>
              </th>
              {renderFigures({ row: total, pick: showTotal, strong: true })}
            </tr>
            {tableRows.flatMap((row) => {
              const expanded = open.has(row.key);
              return [
                <tr key={row.key} className={row.href === null ? 'rest' : undefined}>
                  <th scope="row">
                    {row.children.length > 0 && (
                      <button
                        type="button"
                        className="fold-toggle"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Згорнути' : 'Розгорнути'} підкатегорії «${row.label}»`}
                        onClick={() => toggle(row.key)}
                      >
                        {expanded ? '▾' : '▸'}
                      </button>
                    )}
                    {row.href === null ? (
                      <span className="muted">{row.label}</span>
                    ) : (
                      <a className="plain" href={row.href}>
                        {row.label}
                      </a>
                    )}
                  </th>
                  {renderFigures({ row, pick: (column) => show(row, column) })}
                </tr>,
                ...(expanded
                  ? row.children.map((child) => (
                      <tr key={child.key} className="child">
                        <th scope="row">
                          <a className="plain" href={child.href ?? undefined}>
                            {child.label}
                          </a>
                        </th>
                        {renderFigures({ row: child, pick: (column) => Math.round(child[column] ?? 0) })}
                      </tr>
                    ))
                  : []),
              ];
            })}
          </tbody>
        </table>
      </div>
      <div className="cmp-cards">
        {renderCard({ row: total, pick: showTotal, strong: true })}
        {tableRows.map((row) => renderCard({ row, pick: (column) => show(row, column) }))}
        <a className="cmp-card income" href={monthLink({ type: 'income' })}>
          <span className="cmp-card-name">Дохід</span>
          <span className="num cmp-card-main pos">{formatEur(current.incomeEur)}</span>
          <span className="cmp-card-sub small muted">
            звично {formatEur(average.incomeEur)}
            {lastYear !== null && ` · ${yearLabel}: ${formatEur(lastYear.incomeEur)}`}
          </span>
          <span className={`cmp-card-delta small num ${incomeChange < 0 ? 'neg' : 'pos'}`}>Δ {formatSignedEur(incomeChange)}</span>
        </a>
      </div>
      {quietShown.length > 0 && (
        <details className="fold">
          <summary>Які категорії без витрат цього місяця</summary>
          <p className="note">{quietShown.map((row) => `${row.label} — звично ${formatEur(row.usual)}`).join(' · ')}</p>
        </details>
      )}
    </section>
  );
};
