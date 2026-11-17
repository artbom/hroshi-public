import type { Month } from '@hroshi/schema';
import { useEffect, useRef } from 'react';

import { InfoTip } from '../components/InfoTip.tsx';
import { MonthPicker } from '../components/MonthPicker.tsx';
import { buildHref, buildMonthQuery } from '../route.ts';
import { PERIOD_KINDS, PERIOD_LABELS, type Period, type ResolvedPeriod } from './period.ts';

/** Each section is its own address (`#trends/capital`), so Back and shared links land on it. */
export const TREND_SECTIONS = [
  { id: 'capital', label: 'Капітал', scope: 'капітал, розклад його змін і курс гривні' },
  { id: 'payments', label: 'Платежі', scope: 'отримувачі й джерела доходу; регулярні платежі — за останні пів року' },
  { id: 'flow', label: 'Доходи й витрати', scope: 'доходи й витрати по місяцях' },
  { id: 'categories', label: 'Категорії', scope: 'карта категорій; порівняння — за останній місяць періоду, «По роках» — усі роки' },
  { id: 'trips', label: 'Поїздки', scope: 'поїздки й мітки, що припадають на період' },
] as const;

export type TrendSectionId = (typeof TREND_SECTIONS)[number]['id'];

export const resolveTrendSection = (param: string | null): (typeof TREND_SECTIONS)[number] =>
  TREND_SECTIONS.find((section) => section.id === param) ?? TREND_SECTIONS[0];

export const TrendTabs = ({ current, month }: { current: TrendSectionId; month: Month }) => {
  const nav = useRef<HTMLElement>(null);
  // On a phone the row scrolls; the section being read must not sit behind the edge.
  useEffect(() => {
    const element = nav.current;
    const active = element?.querySelector<HTMLElement>(`[data-section="${current}"]`);
    if (element === null || active === null || active === undefined) return;
    const box = element.getBoundingClientRect();
    const tab = active.getBoundingClientRect();
    element.scrollLeft += tab.left - box.left - (box.width - tab.width) / 2;
  }, [current]);
  return (
    <nav ref={nav} className="trend-tabs scroll-row" aria-label="Розділи аналітики">
      {TREND_SECTIONS.map((section) => (
        <a
          key={section.id}
          data-section={section.id}
          href={buildHref({ view: 'trends', param: section.id, query: buildMonthQuery(month) })}
          aria-current={section.id === current ? 'page' : undefined}
        >
          {section.label}
        </a>
      ))}
    </nav>
  );
};

/**
 * The one clock of «Аналітика»: the range every section reads, named with its months and years,
 * stepped a month at a time with ‹ ›; there is no separate month switcher in the header here.
 */
export const PeriodBar = ({
  period,
  resolved,
  scope,
  onPeriodChange,
  onShift,
  canShiftForward,
  spreadTax,
}: {
  period: Period;
  resolved: ResolvedPeriod;
  /** What in the visible section the period applies to. */
  scope: string;
  onPeriodChange: (period: Period) => void;
  /** Moves the whole range by whole months; the range keeps its length. */
  onShift: (months: number) => void;
  /** False once the range ends at the running month. */
  canShiftForward: boolean;
  /** Shown only where monthly spending is drawn. */
  spreadTax: { value: boolean; onChange: (spread: boolean) => void } | null;
}) => (
  <div className="period-bar">
    <div className="period-clock" role="group" aria-label={`Період: ${resolved.label}`}>
      <button type="button" className="btn" aria-label="На місяць раніше" onClick={() => onShift(-1)}>
        ‹
      </button>
      <b className="period-range num">{resolved.label}</b>
      <button type="button" className="btn" aria-label="На місяць пізніше" disabled={!canShiftForward} onClick={() => onShift(1)}>
        ›
      </button>
    </div>
    <label className="period-select">
      <span className="sr-only">Тривалість періоду</span>
      <select
        value={period.kind}
        onChange={(event) => {
          const kind = PERIOD_KINDS.find((candidate) => candidate === event.target.value);
          if (kind !== undefined) onPeriodChange({ ...period, kind });
        }}
      >
        {PERIOD_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {PERIOD_LABELS[kind]}
          </option>
        ))}
      </select>
    </label>
    {period.kind === 'custom' && (
      <div className="period-range">
        <MonthPicker label="Від" value={period.from} onChange={(from) => onPeriodChange({ ...period, from })} placeholder="рік тому" />
        <MonthPicker label="До" value={period.to} onChange={(to) => onPeriodChange({ ...period, to })} placeholder="обраний місяць" />
      </div>
    )}
    <span className="small muted period-scope">{scope}</span>
    {spreadTax !== null && (
      <span className="check">
        <label>
          <input type="checkbox" checked={spreadTax.value} onChange={(event) => spreadTax.onChange(event.target.checked)} />
          розподілити квартальний податок
        </label>
        <InfoTip label="розподіл квартального податку">
          <p>
            Єдиний податок і ЄСВ ФОП (платежі «УК у …», «ГУК у …», ДПС у «Податки і збори») ділиться на три рівні частини між
            місяцями кварталу, за який сплачено, тож жовтневий платіж за ІІІ квартал не робить жовтень найдорожчим місяцем.
          </p>
          <p>Платіж протягом 50 днів після кінця кварталу — за цей квартал; пізніший — аванс за поточний.</p>
          <p>
            Діє на місячні графіки, порівняння, теплову карту й таблицю по роках. Сума податку та сама, змінюється лише місяць
            (січневий платіж за IV квартал переходить у попередній рік).
          </p>
        </InfoTip>
      </span>
    )}
  </div>
);
