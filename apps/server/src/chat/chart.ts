import type { ReactElement } from 'react';
import { z } from 'zod';

import { COLORS, type Child, formatWhole, h, PADDING, renderPicture, type Style, truncate } from '../picture.ts';

/** Categorical slots stepped for the dark surface and checked for colour-blind separation, in this order. */
const SERIES_COLORS = ['#3987e5', '#d95926', '#199e70'] as const;
const MAX_BARS = 20;
const MAX_POINTS = 36;

export const ChartSchema = z
  .object({
    title: z.string().min(1).max(60),
    subtitle: z.string().max(100).optional(),
    kind: z.enum(['bar', 'column', 'line']),
    /** Printed after every value: «€», «грн», «%»; empty for counts. */
    unit: z.string().max(6).default('€'),
    labels: z.array(z.string().min(1).max(30)).min(1).max(MAX_POINTS),
    series: z
      .array(z.object({ name: z.string().min(1).max(30), values: z.array(z.number()) }))
      .min(1)
      .max(SERIES_COLORS.length),
  })
  .refine(({ labels, series }) => series.every(({ values }) => values.length === labels.length), {
    message: 'Кожен ряд має мати по значенню на кожну мітку',
  })
  .refine(({ kind, labels }) => kind !== 'bar' || labels.length <= MAX_BARS, { message: `bar вміщує до ${MAX_BARS} рядків` });
export type Chart = z.infer<typeof ChartSchema>;

const WIDTH = 1080;
/** Sizes are in image pixels: Telegram shows the picture at about a third of its width. */
const PLOT_HEIGHT = 700;
const AXIS_WIDTH = 130;
const PLOT_WIDTH = WIDTH - 2 * PADDING - AXIS_WIDTH;
const X_LABEL_WIDTH = 72;
const BAR_THICKNESS = 26;
const SERIES_GAP = 3;
const LINE_WIDTH = 5;
const DOT_RADIUS = 10;

/** Money reads in whole units; a share or a rate below ten keeps one decimal. */
const formatValue = (value: number, unit: string) => {
  const number = Math.abs(value) < 10 && !Number.isInteger(value) ? value.toFixed(1).replace('.', ',').replace('-', '−') : formatWhole(value);
  if (unit === '') return number;
  return unit === '%' ? `${number}%` : `${number} ${unit}`;
};

/** Round gridline values covering `low`…`high`: a step of 1, 2 or 5 times a power of ten. */
export const findTicks = ({ low, high, count }: { low: number; high: number; count: number }) => {
  const span = high - low || Math.abs(high) || 1;
  const rough = span / count;
  const power = 10 ** Math.floor(Math.log10(rough));
  const step = [1, 2, 5, 10].map((factor) => factor * power).find((candidate) => candidate >= rough) ?? 10 * power;
  const first = Math.floor(low / step) * step;
  const last = Math.max(Math.ceil(high / step) * step, first + step);
  return Array.from({ length: Math.round((last - first) / step) + 1 }, (_, index) => first + index * step);
};

/** Where a value sits between the ends of the axis, 0 to 1. */
const placeOnAxis = (ticks: readonly number[]) => {
  const low = ticks[0] ?? 0;
  const high = ticks.at(-1) ?? 1;
  return (value: number) => (value - low) / (high - low);
};

const listValues = ({ series }: Chart) => series.flatMap(({ values }) => values);

/** Bars and columns grow from zero, so zero is always on their axis. */
const findZeroBasedTicks = (chart: Chart) => {
  const values = listValues(chart);
  return findTicks({ low: Math.min(0, ...values), high: Math.max(0, ...values), count: 4 });
};

const DATA_END_CORNERS = {
  Right: ['borderTopRightRadius', 'borderBottomRightRadius'],
  Left: ['borderTopLeftRadius', 'borderBottomLeftRadius'],
  Top: ['borderTopLeftRadius', 'borderTopRightRadius'],
  Bottom: ['borderBottomLeftRadius', 'borderBottomRightRadius'],
} as const;

/** A bar is round at the value it reaches and square where it grows from. */
const roundDataEnd = (end: keyof typeof DATA_END_CORNERS): Style => Object.fromEntries(DATA_END_CORNERS[end].map((corner) => [corner, 4]));

const svg = (type: string, props: Record<string, unknown>): ReactElement => ({ type, key: null, props });

const renderHeader = ({ title, subtitle }: Chart) =>
  h(
    { flexDirection: 'column', gap: 8 },
    h({ fontSize: 40, fontWeight: 700 }, title),
    subtitle === undefined ? null : h({ fontSize: 24, color: COLORS.muted }, subtitle),
  );

/** A legend only when color has to tell series apart; with one series the title names it. */
const renderLegend = ({ series, unit }: Chart, withLast: boolean) =>
  series.length < 2
    ? null
    : h(
        { gap: 32, fontSize: 22, color: COLORS.muted },
        ...series.map(({ name, values }, index) =>
          h(
            { alignItems: 'center', gap: 10 },
            h({ width: 16, height: 16, borderRadius: 4, background: SERIES_COLORS[index] ?? COLORS.muted }),
            h({}, name),
            withLast && values.length > 0 ? h({ color: COLORS.fg, fontWeight: 700 }, formatValue(values.at(-1) ?? 0, unit)) : null,
          ),
        ),
      );

const renderBarRows = (chart: Chart) => {
  const { labels, series, unit } = chart;
  const place = placeOnAxis(findZeroBasedTicks(chart));
  const zero = place(0) * 100;
  return labels.map((label, row) =>
    h(
      { flexDirection: 'column', gap: 8 },
      h(
        { justifyContent: 'space-between', alignItems: 'baseline', fontSize: 26 },
        h({}, truncate(label, 34)),
        h(
          { gap: 18, alignItems: 'baseline' },
          ...series.map(({ values }, index) =>
            h(
              { fontWeight: index === 0 ? 700 : 400, color: index === 0 ? COLORS.fg : COLORS.muted, fontSize: index === 0 ? 26 : 22 },
              formatValue(values[row] ?? 0, unit),
            ),
          ),
        ),
      ),
      h(
        { flexDirection: 'column', gap: SERIES_GAP },
        ...series.map(({ values }, index) => {
          const value = values[row] ?? 0;
          const end = place(value) * 100;
          const rounded = roundDataEnd(value >= 0 ? 'Right' : 'Left');
          return h(
            { position: 'relative', height: BAR_THICKNESS },
            h({
              position: 'absolute',
              left: `${Math.min(zero, end)}%`,
              width: `${Math.max(0.4, Math.abs(end - zero))}%`,
              height: BAR_THICKNESS,
              background: SERIES_COLORS[index] ?? COLORS.muted,
              ...rounded,
            }),
          );
        }),
      ),
    ),
  );
};

const describeBarHeight = ({ labels, series, subtitle }: Chart) => {
  const header = 190 + (subtitle === undefined ? 0 : 36) + (series.length > 1 ? 46 : 0);
  const row = 26 * 1.4 + 8 + series.length * (BAR_THICKNESS + SERIES_GAP) + 22;
  return Math.round(Math.min(1800, Math.max(640, header + labels.length * row)));
};

/** Gridlines with their values on the left; the plot itself sits on top of them. */
const renderPlotFrame = ({ ticks, unit, plot }: { ticks: readonly number[]; unit: string; plot: Child[] }) => {
  const place = placeOnAxis(ticks);
  const top = (value: number) => (1 - place(value)) * PLOT_HEIGHT;
  return h(
    { height: PLOT_HEIGHT },
    h(
      { position: 'relative', width: AXIS_WIDTH, height: PLOT_HEIGHT },
      ...ticks.map((tick) =>
        h(
          { position: 'absolute', top: top(tick) - 14, right: 18, fontSize: 20, color: COLORS.muted },
          formatValue(tick, unit),
        ),
      ),
    ),
    h(
      { position: 'relative', width: PLOT_WIDTH, height: PLOT_HEIGHT },
      ...ticks.map((tick) =>
        h({ position: 'absolute', left: 0, top: top(tick), width: PLOT_WIDTH, height: tick === 0 ? 2 : 1, background: COLORS.line }),
      ),
      ...plot,
    ),
  );
};

/** Every label when they fit, otherwise every n-th counted back from the last, so the latest one shows. */
const renderXLabels = ({ labels }: Chart) => {
  const slot = PLOT_WIDTH / labels.length;
  const every = Math.ceil(X_LABEL_WIDTH / slot);
  return h(
    { position: 'relative', height: 30, marginLeft: AXIS_WIDTH, width: PLOT_WIDTH, fontSize: 20, color: COLORS.muted },
    ...labels.map((label, index) =>
      (labels.length - 1 - index) % every === 0
        ? h({ position: 'absolute', left: (index + 0.5) * slot - X_LABEL_WIDTH, width: 2 * X_LABEL_WIDTH, justifyContent: 'center' }, truncate(label, 10))
        : null,
    ),
  );
};

/** A value printed above (or, below zero, under) its mark: only the peak and the latest, never every point. */
const renderValueLabel = ({ x, y, value, unit, below }: { x: number; y: number; value: number; unit: string; below: boolean }) =>
  h(
    { position: 'absolute', left: x - 100, width: 200, top: below ? y + 8 : y - 38, justifyContent: 'center', fontSize: 22, fontWeight: 700 },
    formatValue(value, unit),
  );

const pickLabelledPoints = (values: readonly number[]) => {
  const peak = values.reduce((best, value, index) => (Math.abs(value) > Math.abs(values[best] ?? 0) ? index : best), 0);
  return new Set([peak, values.length - 1]);
};

const renderColumns = (chart: Chart) => {
  const { labels, series, unit } = chart;
  const ticks = findZeroBasedTicks(chart);
  const place = placeOnAxis(ticks);
  const y = (value: number) => (1 - place(value)) * PLOT_HEIGHT;
  const slot = PLOT_WIDTH / labels.length;
  const thickness = Math.min(BAR_THICKNESS * 1.4, Math.floor((slot * 0.7 - (series.length - 1) * SERIES_GAP) / series.length));
  const group = series.length * thickness + (series.length - 1) * SERIES_GAP;
  const labelled = series.length === 1 ? pickLabelledPoints(series[0]?.values ?? []) : new Set<number>();

  const columns = series.flatMap(({ values }, index) =>
    values.map((value, point) => {
      const top = Math.min(y(value), y(0));
      const rounded = roundDataEnd(value >= 0 ? 'Top' : 'Bottom');
      return h({
        position: 'absolute',
        left: point * slot + (slot - group) / 2 + index * (thickness + SERIES_GAP),
        top,
        width: thickness,
        height: Math.max(2, Math.abs(y(value) - y(0))),
        background: SERIES_COLORS[index] ?? COLORS.muted,
        ...rounded,
      });
    }),
  );
  const values = series[0]?.values ?? [];
  const valueLabels = [...labelled].map((point) =>
    renderValueLabel({ x: (point + 0.5) * slot, y: y(values[point] ?? 0), value: values[point] ?? 0, unit, below: (values[point] ?? 0) < 0 }),
  );
  return [renderPlotFrame({ ticks, unit, plot: [...columns, ...valueLabels] }), renderXLabels(chart)];
};

const renderLines = (chart: Chart) => {
  const { labels, series, unit } = chart;
  const values = listValues(chart);
  const ticks = findTicks({ low: Math.min(...values), high: Math.max(...values), count: 4 });
  const place = placeOnAxis(ticks);
  const slot = PLOT_WIDTH / labels.length;
  const x = (point: number) => (point + 0.5) * slot;
  const y = (value: number) => (1 - place(value)) * PLOT_HEIGHT;

  const lines = svg('svg', {
    width: PLOT_WIDTH,
    height: PLOT_HEIGHT,
    viewBox: `0 0 ${PLOT_WIDTH} ${PLOT_HEIGHT}`,
    style: { position: 'absolute', left: 0, top: 0 },
    children: series.flatMap(({ values: points }, index) => {
      const color = SERIES_COLORS[index] ?? COLORS.muted;
      const last = points.length - 1;
      return [
        svg('path', {
          d: points.map((value, point) => `${point === 0 ? 'M' : 'L'}${x(point).toFixed(1)} ${y(value).toFixed(1)}`).join(' '),
          fill: 'none',
          stroke: color,
          strokeWidth: LINE_WIDTH,
          strokeLinejoin: 'round',
          strokeLinecap: 'round',
        }),
        svg('circle', { cx: x(last), cy: y(points[last] ?? 0), r: DOT_RADIUS, fill: color, stroke: COLORS.bg, strokeWidth: 3 }),
      ];
    }),
  });
  const single = series.length === 1 ? (series[0]?.values ?? []) : [];
  const valueLabels = [...pickLabelledPoints(single)].flatMap((point) =>
    single.length === 0 ? [] : [renderValueLabel({ x: Math.min(x(point), PLOT_WIDTH - 100), y: y(single[point] ?? 0), value: single[point] ?? 0, unit, below: false })],
  );
  return [renderPlotFrame({ ticks, unit, plot: [lines, ...valueLabels] }), renderXLabels(chart)];
};

/** The model picks the numbers and the form; the look stays the app's. */
export const renderChart = (chart: Chart): Promise<Buffer> => {
  const head = [renderHeader(chart), renderLegend(chart, chart.kind === 'line')];
  if (chart.kind === 'bar') {
    return renderPicture({ width: WIDTH, height: describeBarHeight(chart), gap: 22, children: [...head, ...renderBarRows(chart)] });
  }
  const body = chart.kind === 'column' ? renderColumns(chart) : renderLines(chart);
  return renderPicture({ width: WIDTH, height: WIDTH, gap: 28, children: [...head, ...body] });
};
