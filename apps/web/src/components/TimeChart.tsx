import type { IsoDate } from '@hroshi/schema';
import type { ReactNode } from 'react';

import { formatDay, formatDayNoYear, formatDecimal, formatMonthTick, formatWhole, spansYears } from '../format.ts';
import { findScale } from './scale.ts';
import { useTooltipHandlers } from './Tooltip.tsx';
import { useElementWidth } from './useElementWidth.ts';

export type TimePoint = { date: IsoDate; value: number; faded?: boolean };

export type TimeSeries = {
  key: string;
  label: string;
  color: string;
  kind: 'line' | 'step' | 'dots';
  points: readonly TimePoint[];
  /** A hypothetical or reference line reads as secondary: dashed, and the legend swatch says so. */
  dashed?: boolean;
  /** The series the chart is about: a thicker stroke, so a benchmark never outweighs it. */
  emphasis?: boolean;
};

const LEFT = 48;
const RIGHT = 10;
const TOP = 22;
const BOTTOM = 22;
const DAY_MS = 86_400_000;
/** Shorter than this, ticks name days, or every tick would read the same month. */
const DAY_TICKS_BELOW_MS = 62 * DAY_MS;
/** Grid values from here on print in thousands, and the unit label says «тис.». */
const THOUSANDS_FROM = 10_000;

const toTime = (date: IsoDate) => Date.parse(`${date}T00:00:00Z`);

/** Steps of 2,5 or 0,5 keep their decimal, so the grid does not read 43, 45, 48. */
const formatAxis = ({ value, thousands }: { value: number; thousands: boolean }) => {
  const shown = thousands ? value / 1000 : value;
  return Number.isInteger(shown) ? formatWhole(shown) : formatDecimal(shown, 1);
};

/** A legend swatch drawn as the line itself: solid, dashed or a dot. */
export const LineSwatch = ({ color, dashed = false, dot = false }: { color: string; dashed?: boolean; dot?: boolean }) => (
  <svg className="line-swatch" width={18} height={10} aria-hidden="true">
    {dot ? (
      <circle cx={9} cy={5} r={4} fill={color} />
    ) : (
      <line x1={1} x2={17} y1={5} y2={5} stroke={color} strokeWidth={2.5} strokeDasharray={dashed ? '4 3' : undefined} />
    )}
  </svg>
);

/** Grid labels closer than this collide. */
const MIN_LABEL_GAP = 14;

/**
 * Values over real dates: lines for month-end series (faded where the month's data is thin),
 * steps for running totals, dots for the few days a value is actually known.
 */
export const TimeChart = ({
  series,
  unit,
  height = 190,
  describePoint,
  zeroBased = true,
}: {
  series: readonly TimeSeries[];
  /** What the y axis counts: «€», «грн», «%», «грн/€»; large amounts gain «тис.» on their own. */
  unit: string;
  height?: number;
  describePoint: (series: TimeSeries, point: TimePoint) => ReactNode;
  /** False for a rate or a price, whose movement a zero-based axis would flatten. */
  zeroBased?: boolean;
}) => {
  const [ref, measured] = useElementWidth<HTMLDivElement>();
  const tooltipFor = useTooltipHandlers();
  const width = measured || 600;
  const all = series.flatMap((entry) => entry.points);
  if (all.length === 0) return <div ref={ref} className="empty">Даних для графіка ще немає.</div>;

  const times = all.map((point) => toTime(point.date));
  const start = Math.min(...times);
  const end = Math.max(...times, start + DAY_MS);
  const values = all.map((point) => point.value);
  const { top, bottom, ticks: gridTicks } = findScale({
    min: Math.min(...values),
    max: Math.max(...values),
    includeZero: zeroBased,
  });
  const span = top - bottom || 1;
  const x = (date: IsoDate) => LEFT + ((toTime(date) - start) / (end - start)) * (width - LEFT - RIGHT);
  const y = (value: number) => TOP + ((top - value) / span) * (height - TOP - BOTTOM);
  const tickCount = Math.max(2, Math.min(6, Math.floor(width / 110)));
  const ticks = Array.from({ length: tickCount }, (_, index) =>
    new Date(start + ((end - start) * index) / (tickCount - 1)).toISOString().slice(0, 10),
  );
  const withYear = spansYears(ticks.map((date) => date.slice(0, 7)));
  const formatTick = (date: IsoDate) =>
    end - start < DAY_TICKS_BELOW_MS ? formatDayNoYear(date) : formatMonthTick(date.slice(0, 7), { withYear });
  const thousands = Math.max(Math.abs(top), Math.abs(bottom)) >= THOUSANDS_FROM;
  // Zero always gets its line when it is on the axis; other labels only where they do not collide with one already kept.
  const gridValues = gridTicks.reduce<number[]>(
    (kept, value) => (kept.every((other) => Math.abs(y(other) - y(value)) >= MIN_LABEL_GAP) ? [...kept, value] : kept),
    bottom <= 0 && top >= 0 ? [0] : [],
  );

  return (
    <div ref={ref}>
      <svg className="line-chart" width={width} height={height} role="img" aria-label={series.map((entry) => entry.label).join(', ')}>
        <text className="axis-unit" x={LEFT - 6} y={10} textAnchor="end">
          {thousands ? `тис.\u00a0${unit}` : unit}
        </text>
        {gridValues.map((value) => (
          <g key={value}>
            <line
              x1={LEFT}
              x2={width - RIGHT}
              y1={y(value)}
              y2={y(value)}
              stroke={value === 0 ? 'var(--muted)' : 'var(--line)'}
              strokeWidth={1}
            />
            <text x={LEFT - 6} y={y(value) + 3} textAnchor="end">
              {formatAxis({ value, thousands })}
            </text>
          </g>
        ))}
        {ticks.map((date, index) => (
          <text
            key={date}
            x={x(date)}
            y={height - 6}
            textAnchor={index === 0 ? 'start' : index === ticks.length - 1 ? 'end' : 'middle'}
          >
            {formatTick(date)}
          </text>
        ))}
        {series.map((entry) => {
          if (entry.kind === 'dots') return null;
          return entry.points.slice(1).map((point, index) => {
            const previous = entry.points[index] ?? point;
            const path =
              entry.kind === 'step'
                ? `M${x(previous.date)},${y(previous.value)} H${x(point.date)} V${y(point.value)}`
                : `M${x(previous.date)},${y(previous.value)} L${x(point.date)},${y(point.value)}`;
            return (
              <path
                key={`${entry.key}-${point.date}`}
                d={path}
                fill="none"
                stroke={entry.color}
                strokeWidth={entry.emphasis === true ? 3 : entry.dashed === true ? 1.6 : 2}
                strokeDasharray={entry.dashed === true ? '6 4' : point.faded === true || previous.faded === true ? '3 4' : undefined}
                opacity={point.faded === true ? 0.6 : 1}
              />
            );
          });
        })}
        {series.map((entry) =>
          entry.points.map((point) => (
            <g key={`${entry.key}-dot-${point.date}`} tabIndex={0} {...tooltipFor(() => describePoint(entry, point))}>
              <circle cx={x(point.date)} cy={y(point.value)} r={12} fill="transparent" />
              {(entry.kind === 'dots' || entry.points.length < 30) && (
                <circle
                  cx={x(point.date)}
                  cy={y(point.value)}
                  r={entry.kind === 'dots' ? 5 : 3}
                  fill={entry.color}
                  stroke="var(--surface)"
                  strokeWidth={2}
                />
              )}
            </g>
          )),
        )}
      </svg>
      {series.length > 1 && (
        <div className="legend">
          {series.map((entry) => (
            <span key={entry.key}>
              <LineSwatch color={entry.color} dashed={entry.dashed} dot={entry.kind === 'dots'} />
              {entry.label}
            </span>
          ))}
        </div>
      )}
    </div>
  );
};

export const describeDayValue = ({ label, point, unit }: { label: string; point: TimePoint; unit: string }) => (
  <>
    <b>{formatDay(point.date)}</b>
    <br />
    {label}: <span className="num">{formatWhole(point.value)} {unit}</span>
    {point.faded === true && (
      <>
        <br />
        <span className="note">Місяць з неповними даними: баланс оцінений</span>
      </>
    )}
  </>
);
