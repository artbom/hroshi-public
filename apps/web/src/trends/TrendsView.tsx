import { type Month, MonthSchema } from '@hroshi/schema';
import { useState } from 'react';
import { z } from 'zod';

import { describeError } from '../api.ts';
import { findCurrentMonth, shiftMonth } from '../months.ts';
import { useComparison, useDataQuality, usePayees, useRecurring, useTrends } from '../queries.ts';
import { replaceRouteMonth, useRoute } from '../route.ts';
import { CategoryDetailSection } from './CategoryDetailSection.tsx';
import { CategoryHeatmap } from './CategoryHeatmap.tsx';
import { ComparisonSection } from './ComparisonSection.tsx';
import { COVERAGE_MONTHS, CoverageSection } from './CoverageSection.tsx';
import { FxSection } from './FxSection.tsx';
import { IncomeExpenseSection } from './IncomeExpenseSection.tsx';
import { IncomeSourcesSection, PayeesSection } from './InsightSections.tsx';
import { NetWorthSection } from './NetWorthSection.tsx';
import { parseBoolean, PERIOD_KINDS, type Period, type ResolvedPeriod, resolvePeriod, useStoredState } from './period.ts';
import { RecurringSection } from './RecurringSection.tsx';
import { TripsSection } from './TripsSection.tsx';
import { PeriodBar, resolveTrendSection, TrendTabs } from './TrendBar.tsx';
import { YearSection } from './YearSection.tsx';

const DEFAULT_PERIOD: Period = { kind: '12', from: '', to: '' };

const StoredPeriodSchema = z.object({
  kind: z.enum(PERIOD_KINDS),
  from: MonthSchema.or(z.literal('')).catch(''),
  to: MonthSchema.or(z.literal('')).catch(''),
});

const parsePeriod = (raw: unknown): Period | null => StoredPeriodSchema.safeParse(raw).data ?? null;

export type SectionProps = { month: Month; period: ResolvedPeriod; spreadTax: boolean };

const CapitalSection = ({ period }: SectionProps) => (
  <>
    <NetWorthSection period={period} />
    <FxSection period={period} />
  </>
);

const PaymentsSection = ({ period }: SectionProps) => {
  const recurring = useRecurring();
  const payees = usePayees({ from: period.from, to: period.to });
  return (
    <>
      {recurring.isError && <p className="note err">{describeError(recurring.error)}</p>}
      {recurring.data !== undefined && <RecurringSection recurring={recurring.data} />}
      {payees.isError && <p className="note err">{describeError(payees.error)}</p>}
      {payees.data !== undefined && (
        <div className="grid2">
          <PayeesSection payees={payees.data} />
          <IncomeSourcesSection payees={payees.data} />
        </div>
      )}
    </>
  );
};

const FlowSection = ({ period, spreadTax }: SectionProps) => {
  const trends = useTrends({ month: period.to, range: period.range, spreadTax });
  const quality = useDataQuality(COVERAGE_MONTHS);
  return (
    <>
      {trends.isError && <p className="note err">Не вдалося порахувати динаміку: {describeError(trends.error)}</p>}
      {trends.isPending && <p className="note">Рахую динаміку…</p>}
      {trends.data !== undefined && (
        <IncomeExpenseSection trends={trends.data} quality={quality.data?.months ?? []} periodLabel={period.label} />
      )}
      {quality.data !== undefined && <CoverageSection months={quality.data.months} />}
    </>
  );
};

/** The comparison is one month: the period's last, so Аналітика keeps a single clock. */
const CategoriesSection = ({ period, spreadTax }: SectionProps) => {
  const trends = useTrends({ month: period.to, range: period.range, spreadTax });
  const comparison = useComparison(period.to, { spreadTax });
  const [selected, setSelected] = useState<string | null>(null);
  return (
    <>
      {comparison.isError && <p className="note err">{describeError(comparison.error)}</p>}
      {comparison.data !== undefined && <ComparisonSection comparison={comparison.data} />}
      {trends.isError && <p className="note err">{describeError(trends.error)}</p>}
      {trends.data !== undefined && (
        <>
          <CategoryHeatmap months={trends.data.months} selected={selected} onSelect={setSelected} />
          {selected !== null && (
            <CategoryDetailSection month={period.to} range={period.range} category={selected} spreadTax={spreadTax} />
          )}
        </>
      )}
      <YearSection spreadTax={spreadTax} />
    </>
  );
};

const SECTION_VIEWS = {
  capital: CapitalSection,
  payments: PaymentsSection,
  flow: FlowSection,
  categories: CategoriesSection,
  trips: TripsSection,
} as const;

/** `section` is the sub-route (`#trends/capital`); null shows the first one. Only the visible section fetches. */
export const TrendsView = ({ month, section }: { month: Month; section: string | null }) => {
  const [period, setPeriod] = useStoredState({ key: 'trends.period', initial: DEFAULT_PERIOD, parse: parsePeriod });
  const [spreadTax, setSpreadTax] = useStoredState({ key: 'trends.spreadTax', initial: false, parse: parseBoolean });
  const route = useRoute();
  const current = resolveTrendSection(section);
  const resolved = resolvePeriod({ period, month });
  // A custom range moves as a whole; every other kind ends at the route month, so ‹ › move that.
  const shiftPeriod = (step: number) => {
    if (period.kind === 'custom' && period.to !== '') {
      setPeriod({ kind: 'custom', from: period.from === '' ? '' : shiftMonth(period.from, step), to: shiftMonth(period.to, step) });
      return;
    }
    replaceRouteMonth({ route, month: shiftMonth(month, step) });
  };
  const Section = SECTION_VIEWS[current.id];
  const drawsSpending = current.id === 'flow' || current.id === 'categories';

  return (
    <div className="view trends">
      <div className="trend-head">
        <TrendTabs current={current.id} month={month} />
        <PeriodBar
          period={period}
          resolved={resolved}
          scope={current.scope}
          onPeriodChange={setPeriod}
          onShift={shiftPeriod}
          canShiftForward={resolved.to < findCurrentMonth()}
          spreadTax={drawsSpending ? { value: spreadTax, onChange: setSpreadTax } : null}
        />
      </div>
      <div className="view">
        <Section month={month} period={resolved} spreadTax={spreadTax} />
      </div>
      <p className="note">
        Суми перераховані в євро за курсом НБУ на день операції (або середнім курсом року, якщо денного немає). Перекази між
        своїми рахунками, P2P та інвестиції не рахуються як витрати; повернення від друзів віднімаються від своїх категорій.
      </p>
    </div>
  );
};
