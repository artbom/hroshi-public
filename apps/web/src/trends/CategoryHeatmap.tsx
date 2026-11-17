import type { MonthStats } from '@hroshi/schema';
import { useState } from 'react';

import { SectionHead } from '../components/InfoTip.tsx';
import { useTooltipHandlers } from '../components/Tooltip.tsx';
import { useElementWidth } from '../components/useElementWidth.ts';
import { formatEur, formatMonthLong, formatMonthTick, formatWhole, pluralize } from '../format.ts';
import { useCategories } from '../queries.ts';
import { parseBoolean, useStoredState } from './period.ts';
import { type CategoryGroup, groupCategories, indexParents, sumMembers } from './rollup.ts';

const LABEL_COLUMN = 130;
const MIN_HEADER_WIDTH = 48;
/** Wide enough for «1 800» in the cell's small mono type. */
const MIN_VALUE_CELL = 38;
/** Categories that never reach a euro over the range are noise. */
const MIN_CATEGORY_TOTAL = 1;
/** Above this saturation the cell is dark enough to need light figures. */
const LIGHT_TEXT_FROM = 55;
/** A desktop screen has room for every figure, so the map opens with values; a phone opens with colour only. */
const VALUES_BY_DEFAULT = window.matchMedia('(min-width: 641px)').matches;

type HeatRow = { key: string; label: string; category: string; values: number[]; total: number; children: HeatRow[] };

/** A month's cell never goes below zero (a month of refunds is an empty month), and «Разом» sums the cells shown. */
const buildHeatRow = ({
  months,
  key,
  label,
  members,
}: {
  months: readonly MonthStats[];
  key: string;
  label: string;
  members: readonly string[];
}): HeatRow => {
  const values = months.map((stats) => Math.max(0, sumMembers({ values: stats.categories, members })));
  return { key, label, category: members[0] ?? label, values, total: values.reduce((sum, value) => sum + value, 0), children: [] };
};

/** Rows in the order of the «Разом» column they show, subcategories folded into their parent. */
const rankRows = ({ months, groups }: { months: readonly MonthStats[]; groups: readonly CategoryGroup[] }): HeatRow[] =>
  groups
    .map((group) => {
      const row = buildHeatRow({ months, key: group.name, label: group.name, members: group.members });
      if (group.children.length === 0) return row;
      const children = [
        buildHeatRow({ months, key: `${group.name}/`, label: `${group.name} (без підкатегорії)`, members: [group.name] }),
        ...group.children.map((child) => buildHeatRow({ months, key: `${group.name}/${child}`, label: child, members: [child] })),
      ]
        .filter((child) => child.total > MIN_CATEGORY_TOTAL)
        .toSorted((left, right) => right.total - left.total);
      return { ...row, children };
    })
    .filter((row) => row.total > MIN_CATEGORY_TOTAL)
    .toSorted((left, right) => right.total - left.total);

/** Saturation in percent: the scale's maximum is the most expensive finished month, of the row or of the whole map. */
const findSaturation = (value: number, max: number) =>
  value > 0 ? Math.round(12 + (88 * Math.min(value, max || value)) / (max || value)) : 0;

const pickCellColor = (saturation: number) =>
  saturation > 0 ? `color-mix(in srgb, var(--s1) ${saturation}%, var(--surface))` : 'var(--line)';

const SCALES = [
  { value: 'row', label: 'по категорії' },
  { value: 'global', label: 'спільна' },
] as const;
type HeatScale = (typeof SCALES)[number]['value'];
const parseScale = (raw: unknown): HeatScale | null => SCALES.find((scale) => scale.value === raw)?.value ?? null;

export const CategoryHeatmap = ({
  months,
  selected,
  onSelect,
}: {
  months: readonly MonthStats[];
  selected: string | null;
  onSelect: (category: string | null) => void;
}) => {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const tooltipFor = useTooltipHandlers();
  const [scale, setScale] = useStoredState({ key: 'trends.heatScale', initial: 'row', parse: parseScale });
  const [showValues, setShowValues] = useStoredState({ key: 'trends.heatValues', initial: VALUES_BY_DEFAULT, parse: parseBoolean });
  const categories = useCategories();
  const [open, setOpen] = useState<ReadonlySet<string>>(new Set());
  const groups = groupCategories({ names: months.flatMap((stats) => Object.keys(stats.categories)), parents: indexParents(categories.data) });
  const ranked = rankRows({ months, groups });
  const rows = ranked.flatMap((row) => [row, ...(open.has(row.key) ? row.children : [])]);
  const toggle = (key: string) =>
    setOpen((previous) => {
      const next = new Set(previous);
      if (!next.delete(key)) next.add(key);
      return next;
    });
  const step = Math.max(
    1,
    Math.ceil(months.length / Math.max(2, Math.floor(((width || 600) - LABEL_COLUMN) / MIN_HEADER_WIDTH))),
  );
  const finished = (index: number) => months[index]?.partial !== true;
  const globalMax = Math.max(0, ...rows.flatMap((row) => row.values.filter((_, index) => finished(index))));
  const monthWord = pluralize(months.length, ['місяць', 'місяці', 'місяців']);

  return (
    <section>
      <SectionHead
        title="Категорії по місяцях"
        info={
          <>
            <p>
              «По категорії»: кожен рядок порівнюється сам із собою, найнасиченіша клітинка — найдорожчий повний місяць
              категорії, тож і дрібні категорії показують свою форму. «Спільна»: одна шкала на всю карту, видно, які категорії
              важать найбільше.
            </p>
            <p>Поточний місяць заштрихований і в масштаб не входить. Смужки — неповні дані.</p>
            <p>«Разом» — сума за період, €; рядки впорядковані за нею. Підкатегорії згорнуті в батьківську, ▸ розгортає їх.</p>
          </>
        }
      >
        <div className="heat-controls">
          <div className="seg" role="group" aria-label="Шкала кольору">
            {SCALES.map((option) => (
              <button key={option.value} type="button" aria-pressed={option.value === scale} onClick={() => setScale(option.value)}>
                {option.label}
              </button>
            ))}
          </div>
          <label className="check">
            <input type="checkbox" checked={showValues} onChange={(event) => setShowValues(event.target.checked)} />
            показати значення
          </label>
        </div>
      </SectionHead>
      <div className="legend heat-legend">
        <span className="heat-key">
          менше
          <span className="heat-scale" aria-hidden="true" />
          більше{scale === 'global' && ` (до ${formatEur(globalMax)})`}
        </span>
        <span className="heat-key">
          <span className="sw sw-sparse" aria-hidden="true" />
          неповні дані
        </span>
      </div>
      <div className="heat" ref={ref}>
        <table
          className={showValues ? 'with-values' : undefined}
          style={showValues ? { minWidth: LABEL_COLUMN + 60 + months.length * MIN_VALUE_CELL } : undefined}
        >
          <caption className="sr-only">
            Витрати за категоріями й місяцями, € за {monthWord}. Кнопка з назвою категорії відкриває її деталі.
          </caption>
          <colgroup>
            <col className="lc" />
            {months.map((stats) => (
              <col key={stats.month} />
            ))}
            <col className="tc" />
          </colgroup>
          <thead>
            <tr>
              <th scope="col">
                <span className="sr-only">Категорія</span>
              </th>
              {months.map((stats, index) => (
                <th key={stats.month} scope="col" aria-label={formatMonthLong(stats.month)}>
                  {index % step === 0 || showValues ? formatMonthTick(stats.month, { withYear: index === 0 || stats.month.endsWith('-01') }) : ''}
                </th>
              ))}
              <th className="r" scope="col">
                Разом
              </th>
            </tr>
          </thead>
          <tbody>
            {rows.map(({ key, label, category, values, total, children }) => {
              const rowMax = Math.max(0, ...values.filter((_, index) => finished(index)));
              const max = scale === 'row' ? rowMax : globalMax;
              const child = key.includes('/');
              const expanded = open.has(key);
              const peak = months[values.indexOf(rowMax)];
              const isSelected = category === selected;
              const classes = [isSelected ? 'sel' : '', child ? 'child' : ''].filter(Boolean).join(' ');
              return (
                <tr key={key} className={classes || undefined} onClick={() => onSelect(isSelected ? null : category)}>
                  <th scope="row" className="l">
                    {children.length > 0 && (
                      <button
                        type="button"
                        className="fold-toggle"
                        aria-expanded={expanded}
                        aria-label={`${expanded ? 'Згорнути' : 'Розгорнути'} підкатегорії «${label}»`}
                        onClick={(event) => {
                          event.stopPropagation();
                          toggle(key);
                        }}
                      >
                        {expanded ? '▾' : '▸'}
                      </button>
                    )}
                    <button
                      type="button"
                      aria-pressed={isSelected}
                      title={label}
                      onClick={(event) => {
                        event.stopPropagation();
                        onSelect(isSelected ? null : category);
                      }}
                      {...tooltipFor(() => (
                        <>
                          <b>{label}</b>
                          <br />
                          Разом за {monthWord}: <span className="num">{formatEur(total)}</span>
                          {peak !== undefined && rowMax > 0 && (
                            <>
                              <br />
                              Найдорожчий місяць: {formatMonthLong(peak.month)}, <span className="num">{formatEur(rowMax)}</span>
                            </>
                          )}
                          <br />
                          <span className="note">Enter — помісячно й де найбільше</span>
                        </>
                      ))}
                    >
                      {label}
                    </button>
                  </th>
                  {months.map((stats, index) => {
                    const value = values[index] ?? 0;
                    const saturation = findSaturation(value, max);
                    return (
                      <td
                        key={stats.month}
                        className={stats.sparse || stats.partial ? 'c sparse' : 'c'}
                        style={{
                          background: pickCellColor(saturation),
                          color: saturation >= LIGHT_TEXT_FROM ? '#fff' : undefined,
                        }}
                        {...tooltipFor(() => (
                          <>
                            <b>{label}</b> · {formatMonthLong(stats.month)}
                            <br />
                            <span className="num">{formatEur(value)}</span>
                            {(stats.sparse || stats.partial) && (
                              <>
                                <br />
                                <span className="note">{stats.partial ? 'Місяць ще триває' : 'Неповні дані'}</span>
                              </>
                            )}
                          </>
                        ))}
                      >
                        {showValues && value >= 0.5 ? formatWhole(value) : null}
                      </td>
                    );
                  })}
                  <td className="t num">{formatWhole(total)}</td>
                </tr>
              );
            })}
          </tbody>
        </table>
      </div>
    </section>
  );
};
