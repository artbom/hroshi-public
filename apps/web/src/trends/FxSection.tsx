import type { HryvniaPoint } from '@hroshi/schema';

import { describeError } from '../api.ts';
import { ChartFigure } from '../components/ChartFigure.tsx';
import { SectionHead } from '../components/InfoTip.tsx';
import { TimeChart, type TimePoint, type TimeSeries } from '../components/TimeChart.tsx';
import { formatEur, formatRatePerEur, formatMonthLong, formatMonthShort, formatSignedEur, formatSignedPercent } from '../format.ts';
import { findCurrentMonth } from '../months.ts';
import { useHryvniaExposure } from '../queries.ts';
import { countMonths, type ResolvedPeriod } from './period.ts';

/** The API serves at most this many months. */
const MAX_MONTHS = 120;

const formatRate = (rate: number | null) => (rate === null ? '—' : formatRatePerEur({ perEur: rate, currency: 'UAH' }));

const toPoint = (point: HryvniaPoint, value: number): TimePoint => ({ date: point.date, value });

/** The colour follows the printed whole euros: −0,3 € reads «0 €» and must not be red. */
const toneOf = (eur: number) => (Math.round(eur) < 0 ? 'neg' : Math.round(eur) > 0 ? 'pos' : '');

/** Hryvnias are earned and the card debt is in hryvnias; the euro is what everything is measured in. */
export const FxSection = ({ period }: { period: ResolvedPeriod }) => {
  // Served back from the running month, so a period that ends earlier asks for the months after it too.
  const exposure = useHryvniaExposure(Math.min(MAX_MONTHS, countMonths(period.from, findCurrentMonth())));
  const points = (exposure.data?.points ?? []).filter((point) => point.month >= period.from && point.month <= period.to);

  return (
    <section>
      <SectionHead
        title={`Гривня проти євро · ${period.label}`}
        info={
          <>
            <p>Курс НБУ на кінець кожного місяця: скільки гривень коштує один євро. Більше — гривня слабша.</p>
            <p>
              Курсовий ефект на борг: гривневий борг кредитки на початок місяця, перерахований за курсом кінця місяця, мінус він же за
              курсом початку. Слабшає гривня — борг у євро меншає, і це плюс; міцнішає — мінус. Тому борг у гривні й тримається свідомо.
            </p>
            <p>
              Гривня на рахунках втрачає в євро за тим самим правилом. Її ефект — сума помісячних ефектів на гривню, що лежала на
              рахунках у кожному місяці періоду (часом більше, ніж зараз).
            </p>
          </>
        }
      />
      {exposure.isError && <p className="note err">{describeError(exposure.error)}</p>}
      {exposure.data !== undefined && (
        <FxBody
          points={points}
          assetsFxEur={points.reduce((sum, point) => sum + point.assetsFxEur, 0)}
          debtFxEur={points.reduce((sum, point) => sum + point.debtFxEur, 0)}
        />
      )}
    </section>
  );
};

const FxBody = ({ points, assetsFxEur, debtFxEur }: { points: readonly HryvniaPoint[]; assetsFxEur: number; debtFxEur: number }) => {
  const rated = points.filter((point) => point.uahPerEur !== null);
  const first = rated[0];
  const last = rated.at(-1);
  if (first === undefined || last === undefined) return <div className="empty">Курсів за цей період немає.</div>;
  const firstRate = first.uahPerEur ?? 1;
  const lastRate = last.uahPerEur ?? 1;
  const rateSeries: TimeSeries[] = [
    { key: 'rate', label: 'Гривень за євро', color: 'var(--s4)', kind: 'line', points: rated.map((point) => toPoint(point, point.uahPerEur ?? 0)) },
  ];
  const balanceSeries: TimeSeries[] = [
    { key: 'assets', label: 'Гривня на рахунках, €', color: 'var(--s1)', kind: 'line', points: points.map((point) => toPoint(point, point.assetsEur)) },
    { key: 'debt', label: 'Борг на гривневих кредитках, €', color: 'var(--s2)', kind: 'step', points: points.map((point) => toPoint(point, point.debtEur)) },
  ];
  const byDate = new Map(points.map((point) => [point.date, point]));
  const describe = (series: TimeSeries, point: TimePoint) => {
    const source = byDate.get(point.date);
    return (
      <>
        <b>{formatMonthLong(point.date.slice(0, 7))}</b>
        <br />
        {series.key === 'rate' ? (
          <>
            Курс: <span className="num">{formatRate(point.value)}</span>
          </>
        ) : (
          <>
            {series.label}: <span className="num">{formatEur(point.value)}</span>
            {source !== undefined && (
              <>
                <br />
                Ефект курсу за місяць:{' '}
                <span className="num">{formatSignedEur(series.key === 'debt' ? source.debtFxEur : source.assetsFxEur)}</span>
              </>
            )}
          </>
        )}
      </>
    );
  };

  return (
    <>
      <div className="tiles even-tiles">
        <div className="tile">
          <span className="k">Курс НБУ зараз</span>
          <span className="v num">{formatRate(lastRate)}</span>
          <span className="small muted">
            {formatSignedPercent(lastRate / firstRate - 1)} з {formatMonthShort(first.month)} ({formatRate(firstRate)})
          </span>
        </div>
        <div className="tile">
          <span className="k">Курсовий ефект на борг кредитки</span>
          <span className={`v num ${toneOf(debtFxEur)}`.trim()}>{formatSignedEur(debtFxEur)}</span>
          <span className="small muted">за {formatMonthShort(first.month)} – {formatMonthShort(last.month)}, борг зараз {formatEur(last.debtEur)}</span>
        </div>
        <div className="tile">
          <span className="k">Курсовий ефект на гривню на рахунках</span>
          <span className={`v num ${toneOf(assetsFxEur)}`.trim()}>{formatSignedEur(assetsFxEur)}</span>
          <span className="small muted">
            за {formatMonthShort(first.month)} – {formatMonthShort(last.month)}, на рахунках зараз {formatEur(last.assetsEur)}
          </span>
        </div>
      </div>
      <div className="fx-charts">
        <div>
          <div className="small muted">Гривень за 1 €, курс НБУ на кінець місяця</div>
          <ChartFigure
            summary={`Курс гривні: ${formatRate(firstRate)} за євро на кінець ${formatMonthLong(first.month)}, ${formatRate(lastRate)} зараз.`}
            table={{
              columns: ['Місяць', 'Гривень за €'],
              rows: rated.map((point) => ({ key: point.month, cells: [formatMonthShort(point.month), formatRate(point.uahPerEur)] })),
            }}
          >
            <TimeChart height={150} unit="грн/€" series={rateSeries} describePoint={describe} zeroBased={false} />
          </ChartFigure>
        </div>
        <div>
          <div className="small muted">Гривневі баланси в євро</div>
          <ChartFigure
            summary={`Гривня на рахунках ${formatEur(last.assetsEur)}, борг на гривневих кредитках ${formatEur(last.debtEur)}; ефект курсу на борг за період ${formatSignedEur(debtFxEur)}.`}
            table={{
              columns: ['Місяць', 'На рахунках', 'Борг', 'Курс: рахунки', 'Курс: борг'],
              rows: points.map((point) => ({
                key: point.month,
                cells: [
                  formatMonthShort(point.month),
                  formatEur(point.assetsEur),
                  formatEur(point.debtEur),
                  formatSignedEur(point.assetsFxEur),
                  formatSignedEur(point.debtFxEur),
                ],
              })),
            }}
          >
            <TimeChart height={150} unit="€" series={balanceSeries} describePoint={describe} />
          </ChartFigure>
        </div>
      </div>
    </>
  );
};
