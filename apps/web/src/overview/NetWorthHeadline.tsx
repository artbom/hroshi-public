import { InfoTip } from '../components/InfoTip.tsx';
import { NET_WORTH_BUCKETS } from '../components/netWorthBuckets.ts';
import { formatEur, formatMonthLong, formatSignedEur } from '../format.ts';
import { useNetWorth, useNetWorthHistory } from '../queries.ts';
import { buildHref } from '../route.ts';

/** Loans and debts live at the bottom of Рахунки; their tiles land there, not at the top of the page. */
const OWED_BUCKETS: ReadonlySet<string> = new Set(['owedToMeEur', 'iOweEur']);

/** The one number first: what everything is worth, and how that moved since last month. */
export const NetWorthHeadline = () => {
  const worth = useNetWorth();
  const history = useNetWorthHistory(2);
  if (worth.data === undefined) return null;
  const previous = history.data?.points[0];
  const change = previous === undefined ? null : worth.data.totalEur - previous.totalEur;

  return (
    <section className="headline">
      <div className="small muted">
        Чистий капітал
        <InfoTip label="чистий капітал">
          <p>Усі рахунки, інвестиції й позики мінус борги, у євро за сьогоднішнім курсом НБУ.</p>
          <p>Кредитка — мінус, але це свідомий борг у гривні, без тривоги.</p>
          {previous !== undefined && <p>Зміна — проти кінця {formatMonthLong(previous.month)}; з чого вона складається — в «Аналітиці».</p>}
        </InfoTip>
      </div>
      <a className="plain headline-figure" href={buildHref({ view: 'trends', param: 'capital' })}>
        <span className="big num">{formatEur(worth.data.totalEur)}</span>
        {change !== null && (
          <span className={`headline-delta num ${change < 0 ? 'neg' : 'pos'}`}>
            <span aria-hidden="true">{change < 0 ? '▼' : '▲'}</span> {formatSignedEur(change)} за місяць
          </span>
        )}
      </a>
      <div className="bucket-row">
        {NET_WORTH_BUCKETS.filter((bucket) => worth.data[bucket.key] !== 0).map((bucket) => (
          <a
            key={bucket.key}
            className="bucket"
            href={buildHref({ view: bucket.view, query: OWED_BUCKETS.has(bucket.key) ? { focus: 'owed' } : {} })}
          >
            <span className="small muted">{bucket.label}</span>
            <span className="num">{formatEur(worth.data[bucket.key])}</span>
          </a>
        ))}
      </div>
    </section>
  );
};
