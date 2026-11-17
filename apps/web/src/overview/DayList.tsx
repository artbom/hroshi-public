import type { Month, TransactionRow } from '@hroshi/schema';

import { describeError } from '../api.ts';
import { formatDayHeading, pluralize } from '../format.ts';
import { buildTableHref } from '../route.ts';
import { useTransactions } from '../queries.ts';
import { findEntryKey, groupChains, TransactionEntry } from '../transactions/TransactionLine.tsx';

type PlacedEntry = ReturnType<typeof groupChains>[number];

/** Rows under day headings, one money move per line. */
const EntriesByDay = ({
  entries,
  accountNames,
}: {
  entries: readonly PlacedEntry[];
  accountNames: ReadonlyMap<string, string>;
}) => (
  <div>
    {[...Map.groupBy(entries, (item) => item.date)].map(([date, items]) => (
      <div key={date} className="day">
        <div className="day-h">{formatDayHeading(date)}</div>
        {items.map(({ entry }) => (
          <TransactionEntry key={findEntryKey(entry)} entry={entry} accountNames={accountNames} />
        ))}
      </div>
    ))}
  </div>
);

/** Entries (a hold and its release count once) the overview shows before linking to the full list. */
const RECENT_ENTRIES = 15;

/** Enough rows for the recent entries and the chains they belong to; a chain cut at the edge stays a plain row. */
const RECENT_ROW_LIMIT = 80;

export const DayList = ({ month, accountNames }: { month: Month; accountNames: ReadonlyMap<string, string> }) => {
  const page = useTransactions({ from: month, to: month, limit: RECENT_ROW_LIMIT, sort: 'date', dir: 'desc' });

  if (page.isPending) return <p className="note loading">Завантажую записи…</p>;
  if (page.isError) return <p className="note err">Не вдалося завантажити записи: {describeError(page.error)}</p>;
  if (page.data.items.length === 0) {
    return <div className="empty">Тут з'являться витрати. Додай запис вручну або попроси Claude.</div>;
  }

  return (
    <>
      <EntriesByDay entries={groupChains(page.data.items).slice(0, RECENT_ENTRIES)} accountNames={accountNames} />
      <a className="btn" href={buildTableHref({ from: month, to: month })}>
        Усі {pluralize(page.data.total, ['запис', 'записи', 'записів'])} за місяць в «Операціях» →
      </a>
    </>
  );
};

/** The same for plain rows, as the operations list on phones shows them. */
export const RowsByDay = ({ rows, accountNames }: { rows: readonly TransactionRow[]; accountNames: ReadonlyMap<string, string> }) => (
  <EntriesByDay entries={groupChains(rows)} accountNames={accountNames} />
);
