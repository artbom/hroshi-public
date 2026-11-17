import type { MonthQuality, MonthStats, Trends } from '@hroshi/schema';

import { BarChart } from '../components/BarChart.tsx';
import { ChartFigure } from '../components/ChartFigure.tsx';
import { InfoTip, SectionHead } from '../components/InfoTip.tsx';
import { TimeChart, type TimePoint } from '../components/TimeChart.tsx';
import { formatEur, formatMonthLong, formatMonthShort, formatPercent, formatSignedEur, pluralize } from '../format.ts';
import { OriginStrip } from './CoverageSection.tsx';
import { TileLabel } from './TileLabel.tsx';

const describeMonthState = (stats: MonthStats): string | null => {
  if (stats.partial) return 'Місяць ще триває';
  if (stats.sparse) return 'Неповні дані за місяць';
  if (stats.noIncome) return 'Доходи за місяць не внесені';
  return null;
};

const findSavingsRate = (stats: MonthStats) => (stats.incomeEur > 0 ? (stats.incomeEur - stats.spendEur) / stats.incomeEur : null);

const MonthTooltip = ({ stats }: { stats: MonthStats }) => {
  const saved = stats.incomeEur - stats.spendEur;
  const state = describeMonthState(stats);
  const rate = findSavingsRate(stats);
  return (
    <>
      <b>{formatMonthLong(stats.month)}</b>
      <br />
      Дохід: <span className="num">{formatEur(stats.incomeEur)}</span>
      <br />
      Витрати: <span className="num">{formatEur(stats.spendEur)}</span>
      <br />
      Різниця: <span className="num">{formatSignedEur(saved)}</span>
      {rate !== null && ` (${formatPercent(rate)})`}
      {state !== null && (
        <>
          <br />
          <span className="note">{state}</span>
        </>
      )}
    </>
  );
};

const describeRatePoint = (point: TimePoint) => (
  <>
    <b>{formatMonthLong(point.date.slice(0, 7))}</b>
    <br />
    Відкладено {point.value}% доходу{point.faded === true ? ' (неповні дані)' : ''}
  </>
);

export const AveragesExplainer = ({ months }: { months: readonly MonthStats[] }) => {
  const used = months.filter((stats) => describeMonthState(stats) === null);
  const left = months.filter((stats) => describeMonthState(stats) !== null);
  return (
    <>
      <p>Середнє за період — лише за повні місяці обраного періоду: закінчені, з доходами і щонайменше 60 записами.</p>
      <p>
        Враховано ({used.length}): {used.map((stats) => formatMonthLong(stats.month)).join(', ') || '—'}.
      </p>
      {left.length > 0 && (
        <p>
          Пропущено:{' '}
          {left.map((stats) => `${formatMonthLong(stats.month)} — ${(describeMonthState(stats) ?? '').toLocaleLowerCase('uk')}`).join('; ')}.
        </p>
      )}
    </>
  );
};

const Tile = ({ label, value, months, baseline }: { label: string; value: string; months: readonly MonthStats[]; baseline: string }) => (
  <div className="tile">
    <TileLabel
      label={label}
      info={
        <InfoTip label={label}>
          <AveragesExplainer months={months} />
        </InfoTip>
      }
    />
    <span className="v num">{value}</span>
    <span className="small muted">середнє за період</span>
    <span className="small muted">{baseline}</span>
  </div>
);

export const IncomeExpenseSection = ({
  trends,
  quality,
  periodLabel,
}: {
  trends: Trends;
  quality: readonly MonthQuality[];
  periodLabel: string;
}) => {
  const { months, averages } = trends;
  const qualityByMonth = new Map(quality.map((entry) => [entry.month, entry]));
  const origins = months.flatMap((stats) => {
    const entry = qualityByMonth.get(stats.month);
    return entry === undefined ? [] : [entry];
  });
  const baseline = `${pluralize(averages.completeMonths, ['повний міс.', 'повні міс.', 'повних міс.'])} з ${averages.totalMonths}`;
  const ratePoints = months
    .filter((stats) => stats.incomeEur > 0 && !stats.partial)
    .map((stats) => ({
      date: `${stats.month}-15`,
      value: Math.round(((stats.incomeEur - stats.spendEur) / stats.incomeEur) * 100),
      faded: stats.sparse,
    }));
  return (
    <section>
      <SectionHead
        title="Дохід і витрати по місяцях"
        info={
          <>
            <p>Дохід — зарплата, підробіток, продаж речей. Витрати — мінус повернення в їхніх категоріях. Усе в євро за курсом дня.</p>
            <p>Бліді смугасті стовпці — завершені місяці з неповними даними; поточний місяць, ще неповний за визначенням, має власну штриховку на обох стовпцях.</p>
          </>
        }
      />
      <div className="legend">
        <span>
          <i style={{ background: 'var(--s1)' }} />
          Дохід
        </span>
        <span>
          <i style={{ background: 'var(--s2)' }} />
          Витрати
        </span>
        <span>
          <i className="sw-sparse" />
          неповні дані
        </span>
        <span>
          <i className="sw-running" />
          місяць триває
        </span>
      </div>
      <ChartFigure
        summary={`Дохід і витрати за ${periodLabel}: середнє за період (${baseline}) — дохід ${formatEur(averages.incomeEur)}, витрати ${formatEur(averages.spendEur)}.`}
        table={{
          columns: ['Місяць', 'Дохід', 'Витрати', 'Різниця', 'Норма', 'Дані'],
          rows: months.map((stats) => {
            const rate = findSavingsRate(stats);
            return {
              key: stats.month,
              cells: [
                formatMonthShort(stats.month),
                formatEur(stats.incomeEur),
                formatEur(stats.spendEur),
                formatSignedEur(stats.incomeEur - stats.spendEur),
                rate === null ? '—' : formatPercent(rate),
                describeMonthState(stats)?.toLocaleLowerCase('uk') ?? 'повні',
              ],
            };
          }),
        }}
      >
        <BarChart
          unit="€"
          months={months.map((stats) => stats.month)}
          series={[
            { values: months.map((stats) => stats.incomeEur), color: 'var(--s1)' },
            { values: months.map((stats) => Math.max(0, stats.spendEur)), color: 'var(--s2)' },
          ]}
          // The running month has one look, «місяць триває», on both bars; «неповні дані» is for finished months only.
          sparse={months.map((stats) => !stats.partial && (stats.sparse || stats.noIncome))}
          partial={months.map((stats) => stats.partial)}
          tooltips={months.map((stats) => (
            <MonthTooltip key={stats.month} stats={stats} />
          ))}
        />
      </ChartFigure>
      {origins.length === months.length && <OriginStrip months={origins} />}
      <div className="tiles" style={{ marginTop: 14 }}>
        <Tile label="Дохід" value={formatEur(averages.incomeEur)} months={months} baseline={baseline} />
        <Tile label="Витрати" value={formatEur(averages.spendEur)} months={months} baseline={baseline} />
        <Tile label="Відкладаєш" value={formatSignedEur(averages.savedEur)} months={months} baseline={baseline} />
        <Tile
          label="Норма заощаджень"
          value={averages.savingsRate === null ? '—' : formatPercent(averages.savingsRate)}
          months={months}
          baseline={baseline}
        />
      </div>
      <div style={{ marginTop: 12 }}>
        <div className="small muted">Норма заощаджень по місяцях, % доходу (пунктир — неповні дані, поточний місяць не показано)</div>
        <ChartFigure
          summary={`Норма заощаджень по місяцях: ${ratePoints.map((point) => `${formatMonthShort(point.date.slice(0, 7))} ${point.value}%`).join(', ')}.`}
          table={{
            columns: ['Місяць', 'Норма'],
            rows: ratePoints.map((point) => ({
              key: point.date,
              cells: [formatMonthShort(point.date.slice(0, 7)), `${point.value}%${point.faded ? ' (неповні дані)' : ''}`],
            })),
          }}
        >
          <TimeChart
            height={130}
            unit="%"
            series={[{ key: 'rate', label: 'Норма заощаджень, %', color: 'var(--s3)', kind: 'line', points: ratePoints }]}
            describePoint={(_series, point) => describeRatePoint(point)}
          />
        </ChartFigure>
      </div>
    </section>
  );
};
