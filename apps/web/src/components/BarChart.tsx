import type { Month } from '@hroshi/schema';
import type { ReactNode } from 'react';

import { formatDecimal, formatMonthTick, formatWhole, spansYears } from '../format.ts';
import { findScale } from './scale.ts';
import { useTooltipHandlers } from './Tooltip.tsx';
import { useElementWidth } from './useElementWidth.ts';

export type ChartSeries = { values: readonly number[]; color: string };

export const MIN_TICK_WIDTH = 56;

/** Grid values from here on print in thousands, and the unit label says «тис.». */
const THOUSANDS_FROM = 10_000;

/** The y axis' unit, printed once above the grid instead of beside every line: «тис. €», «грн». */
export const formatAxisUnit = ({ unit, thousands }: { unit: string; thousands: boolean }) =>
  thousands ? `тис.\u00a0${unit}` : unit;

/** Grid labels: plain below ten thousand, in thousands above (with one decimal where a step needs it). */
export const formatAxisValue = ({ value, thousands }: { value: number; thousands: boolean }) => {
  if (!thousands) return formatWhole(value);
  const shown = value / 1000;
  return Number.isInteger(shown) ? formatWhole(shown) : formatDecimal(shown, 1);
};

export const isThousandsAxis = (values: readonly number[]) => values.some((value) => Math.abs(value) >= THOUSANDS_FROM);

export const BarChart = ({
  months,
  series,
  sparse,
  partial = [],
  tooltips,
  height = 200,
  label,
  unit,
}: {
  /** What the chart shows, read out by screen readers in place of the bars. */
  label?: string;
  /** What the bars count, «€» or «грн»; large amounts gain «тис.» on their own. */
  unit: string;
  months: readonly Month[];
  series: readonly ChartSeries[];
  sparse: readonly boolean[];
  /** Months still running: hatched, so a half month does not read as a drop. */
  partial?: readonly boolean[];
  /** One tooltip body per month, same order as `months`. */
  tooltips: readonly ReactNode[];
  height?: number;
}) => {
  const [ref, width] = useElementWidth<HTMLDivElement>();
  const tooltipFor = useTooltipHandlers();
  const { top: max, ticks } = findScale({ min: 0, max: Math.max(1, ...series.flatMap((entry) => entry.values)) });
  const step = Math.max(1, Math.ceil(months.length / Math.max(3, Math.floor((width || 600) / MIN_TICK_WIDTH))));
  const thousands = isThousandsAxis(ticks);
  const withYear = spansYears(months);

  return (
    <>
      <div className="chart" style={{ height }} ref={ref} role={label === undefined ? undefined : 'group'} aria-label={label}>
        <span className="axis-unit">{formatAxisUnit({ unit, thousands })}</span>
        {ticks.map((value) => (
          <div key={value} className="grid" style={{ bottom: `${(value / max) * 100}%` }}>
            <span className="num">{formatAxisValue({ value, thousands })}</span>
          </div>
        ))}
        <div className="cols">
          {months.map((month, index) => (
            <div
              key={month}
              className={['col', sparse[index] === true ? 'sparse' : '', partial[index] === true ? 'partial' : ''].join(' ').trim()}
              tabIndex={0}
              aria-label={formatMonthTick(month, { withYear: true })}
              {...tooltipFor(() => tooltips[index])}
            >
              {series.map((entry) => (
                <i
                  key={entry.color}
                  style={{
                    height: `${(Math.max(0, entry.values[index] ?? 0) / max) * 100}%`,
                    background: entry.color,
                  }}
                />
              ))}
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
