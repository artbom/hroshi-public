import type { Month } from '@hroshi/schema';
import type { ReactNode } from 'react';

import { formatMonthTick, formatWhole, spansYears } from '../format.ts';
import { formatAxisUnit, formatAxisValue, isThousandsAxis, MIN_TICK_WIDTH } from './BarChart.tsx';
import { findScale } from './scale.ts';
import { useTooltipHandlers } from './Tooltip.tsx';
import { useElementWidth } from './useElementWidth.ts';

export type StackSeries = { key: string; label: string; color: string; values: readonly number[] };

/**
 * Monthly stacks around a zero line: positive buckets grow up, negative ones down, and a
 * dark tick marks the net. Months with thin data fade.
 */
export const StackedChart = ({
  months,
  series,
  totals,
  sparse,
  tooltips,
  height = 220,
  label,
  unit,
}: {
  label?: string;
  /** What the stacks count, «€»; large amounts gain «тис.» on their own. */
  unit: string;
  months: readonly Month[];
  series: readonly StackSeries[];
  totals: readonly number[];
  sparse: readonly boolean[];
  tooltips: readonly ReactNode[];
  height?: number;
}) => {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const tooltipFor = useTooltipHandlers();
  const sumAt = (index: number, sign: 1 | -1) =>
    series.reduce((sum, entry) => sum + Math.max(0, sign * (entry.values[index] ?? 0)), 0);
  const scale = findScale({
    min: -Math.max(0, ...months.map((_, index) => sumAt(index, -1))),
    max: Math.max(1, ...months.map((_, index) => sumAt(index, 1))),
  });
  const { top, ticks } = scale;
  const bottom = -scale.bottom;
  const span = top + bottom;
  const zero = (bottom / span) * 100;
  const toPercent = (value: number) => (Math.abs(value) / span) * 100;
  const step = Math.max(1, Math.ceil(months.length / Math.max(3, Math.floor((width || 600) / MIN_TICK_WIDTH))));
  const thousands = isThousandsAxis(ticks);
  const withYear = spansYears(months);

  return (
    <>
      <div className="chart" style={{ height }} ref={ref} role={label === undefined ? undefined : 'group'} aria-label={label}>
        <span className="axis-unit">{formatAxisUnit({ unit, thousands })}</span>
        {ticks.map((value) => (
          <div key={value} className="grid" style={{ bottom: `${zero + (value / span) * 100}%` }}>
            <span className="num">{formatAxisValue({ value, thousands })}</span>
          </div>
        ))}
        <div className="zero" style={{ bottom: `${zero}%` }} />
        <div className="cols">
          {months.map((month, index) => (
            <div
              key={month}
              className={sparse[index] === true ? 'col stacked sparse' : 'col stacked'}
              tabIndex={0}
              aria-label={`${formatMonthTick(month, { withYear: true })}: разом ${formatWhole(totals[index] ?? 0)} ${unit}`}
              {...tooltipFor(() => tooltips[index])}
            >
              <div className="pos-stack" style={{ bottom: `${zero}%` }}>
                {series.map((entry) => {
                  const value = entry.values[index] ?? 0;
                  return value > 0 ? (
                    <i key={entry.key} style={{ height: `${(toPercent(value) / 100) * height}px`, background: entry.color }} />
                  ) : null;
                })}
              </div>
              <div className="neg-stack" style={{ top: `${100 - zero}%` }}>
                {series.map((entry) => {
                  const value = entry.values[index] ?? 0;
                  return value < 0 ? (
                    <i key={entry.key} style={{ height: `${(toPercent(value) / 100) * height}px`, background: entry.color }} />
                  ) : null;
                })}
              </div>
              <span className="mark" style={{ bottom: `${zero + ((totals[index] ?? 0) / span) * 100}%` }} />
            </div>
          ))}
        </div>
      </div>
      <div className="xlab" aria-hidden="true">
        {months.map((month, index) => (
          <span key={month}>{index % step === 0 ? formatMonthTick(month, { withYear }) : ''}</span>
        ))}
      </div>
    </>
  );
};
