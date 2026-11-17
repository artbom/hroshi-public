import { describeError } from '../api.ts';
import { formatEur, pluralize } from '../format.ts';
import { buildTableHref } from '../route.ts';
import { TagsSection } from './InsightSections.tsx';
import type { ResolvedPeriod } from './period.ts';
import { useTrips } from './tripQueries.ts';

/** Trips and tags of the period, side by side, and the travel money no trip accounts for. */
export const TripsSection = ({ period }: { period: ResolvedPeriod }) => {
  const trips = useTrips({ from: period.from, to: period.to });
  const untagged = trips.data?.untagged ?? null;
  return (
    <>
      {trips.isError && <p className="note err">{describeError(trips.error)}</p>}
      {trips.data !== undefined && <TagsSection tags={trips.data.tags} />}
      {untagged !== null && Math.abs(untagged.eur) >= 0.5 && (
        <a className="card plain trips-outside" href={buildTableHref({ type: 'expense', category: untagged.category, from: period.from, to: period.to })}>
          <span>
            <b>{untagged.category} поза поїздками</b>
            <span className="small muted">
              {' '}
              · {pluralize(untagged.rows, ['запис', 'записи', 'записів'])} за {period.label} без мітки «trip:»: квитки наперед або
              поїздка без мітки. Список покаже всю категорію →
            </span>
          </span>
          <span className="num trips-outside-sum">{formatEur(untagged.eur)}</span>
        </a>
      )}
    </>
  );
};
