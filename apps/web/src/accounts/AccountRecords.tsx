import type { AccountBalance, AccountRecord } from '@hroshi/schema';
import { Fragment, useState } from 'react';

import { describeError } from '../api.ts';
import { InfoTip } from '../components/InfoTip.tsx';
import { useDrawer } from '../components/DrawerContext.tsx';
import { formatDayShort, formatMoney, formatMonthLong, formatSignedMoney } from '../format.ts';
import { buildTableHref } from '../route.ts';
import { describeLine, SourceChips } from '../transactions/TransactionLine.tsx';
import { useAccountRecords } from './queries.ts';

const PAGE_SIZE = 50;

/** Below this two balances are the same money. */
const BALANCE_TOLERANCE = 0.005;

/** Where the money came from or went, from this account's side. */
const describeCounterpart = ({
  record,
  accountId,
  names,
}: {
  record: AccountRecord;
  accountId: string;
  names: ReadonlyMap<string, string>;
}) => {
  const { row } = record;
  if (row.type === 'valuation') return 'переоцінка';
  if (row.type !== 'transfer') return row.category ?? '';
  const otherId = row.accountId === accountId ? row.toAccountId : row.accountId;
  const other = otherId === null ? '?' : (names.get(otherId) ?? otherId);
  return row.accountId === accountId ? `→ ${other}` : `← ${other}`;
};

const agreesWithBank = ({ bankBalance, computedBalance }: Pick<AccountRecord, 'bankBalance' | 'computedBalance'>) =>
  bankBalance !== null && Math.abs(bankBalance - computedBalance) < BALANCE_TOLERANCE;

/**
 * Rows after which the two balances meet again: a gap there is only the order of holds and
 * cancellations, not money missing. Rows come newest first, so «after» is earlier in the list; a
 * matching balance check stands for the end of the newest day.
 */
const findConverging = ({ records, checkMatches }: { records: readonly AccountRecord[]; checkMatches: boolean }): ReadonlySet<string> => {
  const converging = new Set<string>();
  let metLater = checkMatches;
  for (const record of records) {
    if (metLater) converging.add(record.row.id);
    if (agreesWithBank(record)) metLater = true;
  }
  return converging;
};

/**
 * The running balance reads row by row, so it leads; the bank's own figure, where its line printed
 * one, confirms it («✓ банк») or stands beside it when the bank ordered the day's holds differently.
 */
const BalanceCell = ({ record, currency, converges }: { record: AccountRecord; currency: string; converges: boolean }) => {
  const { bankBalance, computedBalance, history } = record;
  const agrees = agreesWithBank(record);
  return (
    <span className={history ? 'rec-bal muted' : 'rec-bal'}>
      <span className="num">{formatMoney(computedBalance, currency)}</span>
      {bankBalance === null ? (
        history && <span className="rec-src">назад від початку</span>
      ) : agrees ? (
        <span className="rec-src bank">✓ банк</span>
      ) : (
        <span
          className="rec-alt num"
          title={
            converges
              ? 'Розбіжність через порядок холдів: банк ставить холди й скасування в іншому порядку, а за кілька рядків баланси знову збігаються.'
              : 'Банк надрукував у своєму рядку іншу цифру, і пізніші рядки її не наздогнали — дивись звірку з банком угорі.'
          }
        >
          банк {formatMoney(bankBalance, currency)}
          {converges && <span className="rec-why">порядок холдів · далі ✓</span>}
        </span>
      )}
    </span>
  );
};

const RecordRow = ({
  record,
  account,
  names,
  bankSince,
  converges,
}: {
  record: AccountRecord;
  account: AccountBalance;
  names: ReadonlyMap<string, string>;
  bankSince: Readonly<Record<string, string>> | undefined;
  converges: boolean;
}) => {
  const { openTransaction } = useDrawer();
  const { row, delta } = record;
  const { title } = describeLine({ transaction: row, accountNames: names });
  const tone = delta < 0 ? 'neg' : delta > 0 ? 'pos' : '';
  return (
    <button type="button" className="rec-row" onClick={() => openTransaction(row.id)}>
      <span className="rec-date num">{formatDayShort(row.date)}</span>
      <span className="rec-what">
        <span className="t">
          {title} <SourceChips transaction={row} bankSince={bankSince} />
        </span>
        <span className="s">
          <span className="rec-date-inline num">{formatDayShort(row.date)} · </span>
          {describeCounterpart({ record, accountId: account.id, names })}
        </span>
      </span>
      <span className={`rec-delta num ${tone}`.trim()}>{formatSignedMoney(delta, account.currency)}</span>
      <BalanceCell record={record} currency={account.currency} converges={converges} />
    </button>
  );
};

/** «Записи рахунку»: the statement newest first, each row with the balance right after it. */
export const AccountRecords = ({ account, names }: { account: AccountBalance; names: ReadonlyMap<string, string> }) => {
  const [limit, setLimit] = useState(PAGE_SIZE);
  const records = useAccountRecords({ id: account.id, limit });
  const items = records.data?.items ?? [];
  const bankSince = records.data?.bankSince ?? null;
  const since = bankSince === null ? undefined : { [account.id]: bankSince };
  const converging = findConverging({ records: items, checkMatches: account.check?.matches === true });

  return (
    <section>
      <div className="section-head">
        <h2>
          Записи рахунку
          <InfoTip label="баланс після запису">
            <p>
              «Баланс після» — початковий баланс плюс усі записи до цього рядка включно, тож його можна читати рядок за рядком.
              «✓ банк» — банк надрукував у своєму рядку ту саму цифру. «банк …» — банк надрукував іншу: холди й скасування дня він
              ставить в іншому порядку; «далі ✓» — за кілька рядків цифри знову однакові, тож гроші не загубились. Чи сходиться
              підсумок, показує звірка з банком угорі.
            </p>
            <p>Записи до дати початку — історія: баланс для них відновлено назад від початкового.</p>
          </InfoTip>
        </h2>
        <a className="link" href={buildTableHref({ accountId: account.id })}>
          Відкрити в операціях →
        </a>
      </div>
      {records.isError && <p className="note err">{describeError(records.error)}</p>}
      {records.isPending && <p className="note loading">Завантажую…</p>}
      {records.data !== undefined && items.length === 0 && <div className="empty">Записів ще немає.</div>}
      {items.length > 0 && (
        <div className="records">
          <div className="rec-head" aria-hidden="true">
            <span>Дата</span>
            <span>Запис</span>
            <span className="r">Сума</span>
            <span className="r">Баланс після</span>
          </div>
          {items.map((record, index) => {
            const month = record.row.date.slice(0, 7);
            const startsMonth = month !== items[index - 1]?.row.date.slice(0, 7);
            return (
              <Fragment key={record.row.id}>
                {startsMonth && <div className="rec-month">{formatMonthLong(month)}</div>}
                <RecordRow record={record} account={account} names={names} bankSince={since} converges={converging.has(record.row.id)} />
              </Fragment>
            );
          })}
        </div>
      )}
      {records.data !== undefined && records.data.total > items.length && (
        <button type="button" className="btn" style={{ marginTop: 10 }} disabled={records.isFetching} onClick={() => setLimit(limit + PAGE_SIZE)}>
          Показати ще
        </button>
      )}
    </section>
  );
};
