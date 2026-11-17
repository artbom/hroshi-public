import type { Month } from '@hroshi/schema';

import { describeError } from '../api.ts';
import { formatAccountName } from '../format.ts';
import { useAccounts, useComparison, useOverview } from '../queries.ts';
import { DayList } from './DayList.tsx';
import { HealthStrip } from './HealthStrip.tsx';
import { CategoryComparison, ForecastSection, LimitsSection, MonthSummary } from './MonthSections.tsx';
import { NetWorthHeadline } from './NetWorthHeadline.tsx';

/**
 * Two columns on wide screens: the month's shape (forecast, categories, limits) on the left and
 * the latest entries on the right, each about as tall as the other.
 */
export const OverviewView = ({ month }: { month: Month }) => {
  const accounts = useAccounts();
  const overview = useOverview(month);
  const comparison = useComparison(month);

  if (accounts.isPending) return <p className="note loading">Завантажую дані…</p>;
  if (accounts.isError) return <p className="note err">Не вдалося завантажити рахунки: {describeError(accounts.error)}</p>;

  const accountNames = new Map(accounts.data.map((account) => [account.id, formatAccountName(account.name)]));

  return (
    <div className="view">
      <NetWorthHeadline />
      <HealthStrip />
      {comparison.isError && <p className="note err">Не вдалося порахувати місяць: {describeError(comparison.error)}</p>}
      {comparison.data !== undefined && <MonthSummary comparison={comparison.data} />}
      <div className="grid2 overview-cols">
        <div className="view">
          {comparison.data !== undefined && <ForecastSection comparison={comparison.data} />}
          {comparison.data !== undefined && <CategoryComparison comparison={comparison.data} overview={overview.data} />}
          {overview.data !== undefined && comparison.data !== undefined && (
            <LimitsSection month={month} limits={overview.data.limits} comparison={comparison.data} />
          )}
        </div>
        <section>
          <div className="section-head">
            <h2>Останні записи</h2>
            <a className="btn small" href="/api/export.xlsx" download>
              Excel
            </a>
          </div>
          <DayList month={month} accountNames={accountNames} />
        </section>
      </div>
    </div>
  );
};
