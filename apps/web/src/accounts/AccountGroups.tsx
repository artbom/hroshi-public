import type { AccountBalance, CurrentNetWorth, RateUsage } from '@hroshi/schema';

import { NET_WORTH_BUCKETS } from '../components/netWorthBuckets.ts';
import { formatDayNoYear, formatEur, formatMoney, formatRatePerEur, pluralize } from '../format.ts';
import { useNetWorth, useSyncStatus } from '../queries.ts';
import { ACCOUNT_GROUPS, AccountCard, isShown, sumByCurrency } from './AccountCard.tsx';

type BucketKey = (typeof NET_WORTH_BUCKETS)[number]['key'];

/**
 * Which net-worth parts a group adds up to, so its euro total is the very number Огляд shows.
 * A card in debt is its own part, never netted against the cash beside it.
 */
const GROUP_BUCKETS: Readonly<Record<string, { positive: BucketKey; negative: BucketKey | null }>> = {
  'Рахунки зараз': { positive: 'cashEur', negative: 'creditDebtEur' },
  Інвестиції: { positive: 'investmentsEur', negative: null },
};

const findBucketLabel = (key: BucketKey) => NET_WORTH_BUCKETS.find((bucket) => bucket.key === key)?.label ?? key;

/** «51,10 грн/€ (сер. 2026)»: a rate that is not the day's own says which one it is. */
const describeRateKind = (rate: RateUsage) => {
  const figure = formatRatePerEur({ perEur: rate.perEur, currency: rate.currency });
  if (rate.kind === 'yearly') return `${figure} (сер. ${String(rate.year ?? '')})`;
  return rate.kind === 'latest' && rate.date !== null ? `${figure} (останній, ${formatDayNoYear(rate.date)})` : figure;
};

/** «за курсом НБУ на 11 лист.: 1,1180 $/€, 51,10 грн/€» — the rates the euro total above was converted at. */
const describeRates = (rates: readonly RateUsage[]) => {
  const [first] = rates;
  if (first === undefined) return null;
  const sameDay = rates.every((rate) => rate.kind === 'daily' && rate.date === first.date);
  const nbu = rates.every((rate) => rate.source === 'nbu') ? ' НБУ' : '';
  const when = sameDay && first.date !== null ? ` на ${formatDayNoYear(first.date)}` : '';
  return `за курсом${nbu}${when}: ${rates.map(describeRateKind).join(', ')}`;
};

const TotalLine = ({
  label,
  eur,
  accounts,
  rates,
}: {
  label: string;
  eur: number | undefined;
  accounts: readonly AccountBalance[];
  rates: readonly RateUsage[];
}) => {
  const sums = sumByCurrency(accounts);
  const used = rates.filter((rate) => sums.some(([currency]) => currency === rate.currency));
  const ratesText = describeRates(used);
  return (
    <span className="total-line">
      {label}: <b className="num">{eur === undefined ? '…' : formatEur(eur)}</b>
      <span className="muted num">
        {' '}
        = {sums.map(([currency, total]) => formatMoney(total, currency)).join(' + ')}
      </span>
      {ratesText !== null && <span className="total-rates small muted">{ratesText}</span>}
    </span>
  );
};

const Totals = ({
  title,
  accounts,
  worth,
}: {
  title: string;
  accounts: readonly AccountBalance[];
  worth: CurrentNetWorth | undefined;
}) => {
  const buckets = GROUP_BUCKETS[title];
  if (buckets === undefined) return null;
  const { negative } = buckets;
  const owing = negative === null ? [] : accounts.filter((account) => account.balance < 0);
  const holding = accounts.filter((account) => !owing.includes(account));
  return (
    <div className="totals">
      {holding.length > 0 && (
        <TotalLine label={findBucketLabel(buckets.positive)} eur={worth?.[buckets.positive]} accounts={holding} rates={worth?.rates ?? []} />
      )}
      {negative !== null && owing.length > 0 && (
        <TotalLine label={findBucketLabel(negative)} eur={worth?.[negative]} accounts={owing} rates={worth?.rates ?? []} />
      )}
    </div>
  );
};

/** Accounts by what they are for; empty ones fold away so the money in use stays in view. */
export const AccountGroups = ({
  accounts,
  only,
}: {
  accounts: readonly AccountBalance[];
  /** Group titles to show; all when left out. */
  only?: readonly string[];
}) => {
  const status = useSyncStatus();
  const worth = useNetWorth();
  const statuses = status.data ?? [];
  const visible = accounts.filter(isShown);
  if (visible.length === 0) return <div className="empty">Рахунків ще немає.</div>;

  return (
    <>
      {ACCOUNT_GROUPS.filter((group) => only === undefined || only.includes(group.title)).map(({ title, test }) => {
        const group = visible.filter(test);
        if (group.length === 0) return null;
        const used = group.filter((account) => account.balance !== 0);
        const empty = group.filter((account) => account.balance === 0);
        return (
          <section key={title}>
            <h2>{title}</h2>
            <div className="accounts">
              {used.map((account) => (
                <AccountCard key={account.id} account={account} statuses={statuses} />
              ))}
              <Totals title={title} accounts={used} worth={worth.data} />
            </div>
            {empty.length > 0 && (
              <details className="zero-fold">
                <summary>ще {pluralize(empty.length, ['рахунок', 'рахунки', 'рахунків'])} з нулем</summary>
                <div className="accounts">
                  {empty.map((account) => (
                    <AccountCard key={account.id} account={account} statuses={statuses} />
                  ))}
                </div>
              </details>
            )}
          </section>
        );
      })}
    </>
  );
};
