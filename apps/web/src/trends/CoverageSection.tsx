import type { MonthQuality } from '@hroshi/schema';

import { SectionHead } from '../components/InfoTip.tsx';
import { useTooltipHandlers } from '../components/Tooltip.tsx';
import { formatMonthLong, pluralize } from '../format.ts';
import { buildTableHref } from '../route.ts';

/** The ledger starts here: the first ZenMoney month. */
export const COVERAGE_MONTHS = 60;

const STATUS_LABELS: Readonly<Record<MonthQuality['status'], string>> = {
  complete: 'повний',
  sparse: 'неповний',
  missing: 'немає даних',
  partial: 'місяць триває',
};

/** Each origin has a pattern as well as a colour, so the strip reads without telling colours apart. */
const ORIGINS = [
  { key: 'bank', label: 'з банку', className: 'o-bank' },
  { key: 'zenmoney', label: 'ZenMoney', className: 'o-zenmoney' },
  { key: 'hand', label: 'вручну / Claude', className: 'o-hand' },
  { key: 'estimated', label: 'орієнтовні', className: 'o-estimated' },
] as const;

const MonthTip = ({ month }: { month: MonthQuality }) => (
  <>
    <b>{formatMonthLong(month.month)}</b> · {STATUS_LABELS[month.status]}
    <br />
    {pluralize(month.rows, ['запис', 'записи', 'записів'])}
    {ORIGINS.filter((origin) => month[origin.key] > 0).map((origin) => (
      <span key={origin.key}>
        <br />
        {origin.label}: {month[origin.key]}
      </span>
    ))}
    {!month.hasIncome && month.rows > 0 && (
      <>
        <br />
        доходів немає
      </>
    )}
    {month.review > 0 && (
      <>
        <br />
        на перевірці: {month.review}
      </>
    )}
  </>
);

/** Januaries carry the year; the first month only when the next January is far enough not to collide. */
const isYearTick = (months: readonly MonthQuality[], index: number) => {
  const month = months[index]?.month ?? '';
  if (month.endsWith('-01')) return true;
  if (index !== 0) return false;
  const nextJanuary = months.findIndex((entry) => entry.month.endsWith('-01'));
  return nextJanuary < 0 || nextJanuary >= 4;
};

/** Every month since the ledger began, so a gap is visible before it skews an average. */
export const CoverageSection = ({ months }: { months: readonly MonthQuality[] }) => {
  const tooltipFor = useTooltipHandlers();
  const first = months.findIndex((month) => month.rows > 0);
  const shown = first < 0 ? months : months.slice(first);

  return (
    <section>
      <SectionHead
        title="Повнота даних"
        info={
          <>
            <p>Місяць неповний, якщо в ньому менше 60 записів або немає доходів; такі місяці не входять у середні.</p>
            <p>Крапка над місяцем — є орієнтовні суми («орієнтовно» в описі). Натисни на місяць, щоб побачити його записи.</p>
          </>
        }
      />
      <div className="coverage" role="list" aria-label="Повнота даних по місяцях">
        {shown.map((month) => (
          <a
            key={month.month}
            role="listitem"
            className={`m ${month.status}${month.estimated > 0 ? ' estimated' : ''}`}
            href={buildTableHref({ from: month.month, to: month.month })}
            aria-label={`${formatMonthLong(month.month)}: ${STATUS_LABELS[month.status]}, ${pluralize(month.rows, ['запис', 'записи', 'записів'])}`}
            {...tooltipFor(() => <MonthTip month={month} />)}
          />
        ))}
      </div>
      <div className="xlab coverage-x" aria-hidden="true">
        {shown.map((month, index) => (
          <span key={month.month}>{isYearTick(shown, index) ? month.month.slice(0, 4) : ''}</span>
        ))}
      </div>
      <div className="legend">
        <span>
          <span className="sw" style={{ background: 'var(--s1)' }} />
          повний
        </span>
        <span>
          <span className="sw cov-sparse" />
          неповний
        </span>
        <span>
          <span className="sw" style={{ border: '1px dashed var(--line)' }} />
          немає даних
        </span>
        <span>
          <span className="sw" style={{ background: 'repeating-linear-gradient(45deg, var(--s1) 0 2px, transparent 2px 4px)' }} />
          місяць триває
        </span>
        <span>
          <span className="sw" style={{ background: 'var(--warn)', borderRadius: '50%', width: 6, height: 6 }} />
          є орієнтовні суми
        </span>
      </div>
    </section>
  );
};

/** Where one month's rows came from, as a strip under the income chart. */
export const OriginStrip = ({ months }: { months: readonly MonthQuality[] }) => {
  const tooltipFor = useTooltipHandlers();
  return (
    <div style={{ paddingLeft: 44, marginTop: 6 }}>
      <div className="coverage" style={{ alignItems: 'stretch' }}>
        {months.map((month) => (
          <div
            key={month.month}
            className="stack"
            style={{ height: 8, flexDirection: 'row' }}
            tabIndex={0}
            aria-label={`${formatMonthLong(month.month)}: ${ORIGINS.filter((origin) => month[origin.key] > 0)
              .map((origin) => `${origin.label} ${month[origin.key]}`)
              .join(', ')}`}
            {...tooltipFor(() => <MonthTip month={month} />)}
          >
            {ORIGINS.map((origin) =>
              month[origin.key] > 0 ? (
                <i key={origin.key} className={origin.className} style={{ width: `${(month[origin.key] / Math.max(1, month.rows)) * 100}%` }} />
              ) : null,
            )}
          </div>
        ))}
      </div>
      <div className="legend small">
        <span>Звідки записи:</span>
        {ORIGINS.map((origin) => (
          <span key={origin.key}>
            <i className={origin.className} />
            {origin.label}
          </span>
        ))}
      </div>
    </div>
  );
};
