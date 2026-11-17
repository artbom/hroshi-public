import type { PositionDetail, PositionIncome, PositionTrade } from '@hroshi/schema';
import { useEffect, useRef } from 'react';

import { describeError } from '../api.ts';
import { Nothing } from '../components/Nothing.tsx';
import {
  formatDay,
  formatEur,
  formatMoney,
  formatPercent,
  formatSignedEur,
  formatSignedMoney,
  formatSignedPercent,
  keepTogether,
  pluralize,
} from '../format.ts';
import { buildHref } from '../route.ts';
import { describePosition } from './PortfolioSections.tsx';
import { usePositionDetail } from './queries.ts';
import { CLASS_COLORS, CLASS_LABELS, formatQuantity, formatWeight } from './shared.ts';

type Names = ReadonlyMap<string, string>;

/** Replaces the drawer's address, so Back from the investments page does not reopen it. */
const closeDrawer = () => window.location.replace(buildHref({ view: 'investments' }));

const describeMissing = ({ missing, detail }: { missing: PositionDetail['missing'][number]; detail: PositionDetail }) => {
  switch (missing) {
    case 'trades':
      return detail.broker === 'ibkr'
        ? 'Купівель і продажів немає: у Flex-запиті IBKR немає розділу Trades. Додай його в запит — і тут з’являться угоди.'
        : 'Купівель і продажів немає: звіт цього рахунку не має журналу угод.';
    case 'cost':
      return 'Собівартості немає: цей рахунок дає лише баланси, тож результату по рядку не видно.';
    case 'price-history':
      return 'Графіка ціни немає: брокер дає ціну лише на дату звіту, а щоденних цін окремих паперів додаток не зберігає.';
    case 'income':
      return 'Грошових записів брокера по цьому рахунку немає, тож дивідендів тут не видно.';
  }
};

const sumIncome = (entries: readonly PositionIncome[], pick: (entry: PositionIncome) => number) =>
  entries.reduce((sum, entry) => sum + pick(entry), 0);

/** A payout and the tax withheld from it arrive the same day; one line each would double the list. */
const IncomeList = ({ income }: { income: readonly PositionIncome[] }) => (
  <div className="list">
    {[...Map.groupBy(income, (entry) => entry.date)].map(([date, entries]) => {
      const currency = entries[0]?.currency ?? 'USD';
      const paid = sumIncome(entries.filter((entry) => entry.kind === 'dividend'), (entry) => entry.amount);
      const withheld = -sumIncome(entries.filter((entry) => entry.kind === 'tax'), (entry) => entry.amount);
      const netEur = sumIncome(entries, (entry) => entry.eur ?? 0);
      return (
        <div key={date} className="row">
          <span>Дивіденди {formatMoney(paid, currency)}</span>
          <span className="r num pos">{formatSignedMoney(paid - withheld, currency)}</span>
          <span className="s">
            {formatDay(date)}
            {withheld !== 0 && ` · утримано ${formatMoney(withheld, currency)}${paid > 0 ? ` (${formatPercent(withheld / paid)})` : ''}`}
            {` · чистими ${formatMoney(netEur, 'EUR')}`}
          </span>
        </div>
      );
    })}
  </div>
);

const TradeList = ({ trades }: { trades: readonly PositionTrade[] }) => (
  <div className="list">
    {trades.map((trade, index) => (
      <div key={`${trade.date}-${index}`} className="row">
        <span>
          {trade.side === 'buy' ? 'Купівля' : 'Продаж'} {formatQuantity(trade.quantity)} × {formatMoney(trade.price, trade.currency)}
        </span>
        <span className="r num">{formatMoney(trade.amount, trade.currency)}</span>
        <span className="s">
          {formatDay(trade.date)} · після: {formatQuantity(trade.holding)} шт.
          {trade.fee !== null && trade.fee !== 0 && ` · комісія ${formatMoney(trade.fee, trade.feeCurrency ?? trade.currency)}`}
          {trade.realized !== null && ` · результат продажу ${formatSignedMoney(trade.realized, trade.currency)}`}
          {trade.eur !== null && ` · ${formatEur(trade.eur)}`}
        </span>
      </div>
    ))}
  </div>
);

const DrawerBody = ({ detail, names }: { detail: PositionDetail; names: Names }) => {
  const { position } = detail;
  const account = names.get(position.accountId) ?? position.accountId;
  const share = detail.gain !== null && detail.cost !== null && detail.cost > 0 ? detail.gain / detail.cost : null;
  const ownCurrency = position.currency !== 'EUR';
  const rate = detail.dividendsEur > 0 ? detail.withholdingEur / detail.dividendsEur : null;

  return (
    <>
      <div>
        <div className="amount num">
          {formatEur(position.eur)}
          {ownCurrency && <span className="muted small"> · {formatMoney(position.value, position.currency)}</span>}
        </div>
        <div className="small muted">
          <span className="class-chip">
            <i style={{ background: CLASS_COLORS[position.assetClass] }} aria-hidden="true" />
            {CLASS_LABELS[position.assetClass]}
          </span>{' '}
          · {formatWeight(position.weight)} портфеля
          {detail.asOf !== null && ` · за звітом на ${formatDay(detail.asOf)}`}
        </div>
      </div>

      <dl className="facts">
        {position.quantity !== null && (
          <>
            <dt>Кількість</dt>
            <dd className="num">{formatQuantity(position.quantity)}</dd>
          </>
        )}
        {position.price !== null && (
          <>
            <dt>Ціна</dt>
            <dd className="num">{formatMoney(position.price, position.currency)}</dd>
          </>
        )}
        <dt>Собівартість</dt>
        <dd className="num">
          {detail.cost === null ? <Nothing why="звіт не дає ціни купівлі" /> : formatMoney(detail.cost, position.currency)}
          {ownCurrency && position.costEur !== null && ` · ${formatEur(position.costEur)}`}
        </dd>
        <dt>Середня ціна штуки</dt>
        <dd className="num">
          {detail.averageCost === null ? <Nothing why="звіт не дає ціни купівлі" /> : formatMoney(detail.averageCost, position.currency)}
        </dd>
        <dt>Результат</dt>
        <dd className={`num ${detail.gain !== null && detail.gain < 0 ? 'neg' : 'pos'}`}>
          {detail.gain === null ? (
            <Nothing why="без собівартості результату не видно" />
          ) : (
            <>
              {formatSignedMoney(detail.gain, position.currency)}
              {share !== null && ` (${formatSignedPercent(share)})`}
              {ownCurrency && position.gainEur !== null && ` · ${formatSignedEur(position.gainEur)}`}
            </>
          )}
        </dd>
        <dt>Брокер</dt>
        <dd>
          <a href={buildHref({ view: 'accounts', param: position.accountId })}>{account} →</a>
        </dd>
      </dl>
      {ownCurrency && position.gainEur !== null && (
        <p className="note">Результат у € — за сьогоднішнім курсом і для купівлі, і для вартості: це рух ринку без курсу долара.</p>
      )}

      {detail.trades !== null && (
        <section>
          <h2>Угоди · {pluralize(detail.trades.length, ['угода', 'угоди', 'угод'])}</h2>
          {detail.trades.length === 0 ? <p className="note">У журналі угод цього паперу немає.</p> : <TradeList trades={detail.trades} />}
        </section>
      )}

      {detail.income.length > 0 && (
        <section>
          <h2>Дивіденди й податок</h2>
          <p className="small">
            Разом <b className="num pos">{formatEur(detail.dividendsEur)}</b>, утримано{' '}
            <b className="num neg">{formatEur(detail.withholdingEur)}</b>
            {rate !== null && ` (${formatPercent(rate)})`} — у € за курсом дня виплати.
          </p>
          <IncomeList income={detail.income} />
        </section>
      )}

      {detail.missing.length > 0 && (
        <section>
          <h2>Чого тут немає</h2>
          <ul className="inv-missing">
            {detail.missing.map((missing) => (
              <li key={missing}>{describeMissing({ missing, detail })}</li>
            ))}
          </ul>
        </section>
      )}
    </>
  );
};

/** `#investments/<position key>`: one position with everything its statements say about it. */
export const PositionDrawer = ({ positionKey, names }: { positionKey: string | null; names: Names }) => {
  const detail = usePositionDetail(positionKey);
  const closeRef = useRef<HTMLButtonElement>(null);

  useEffect(() => {
    if (positionKey === null) return undefined;
    closeRef.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') closeDrawer();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [positionKey]);

  if (positionKey === null) return null;
  const heading = detail.data === undefined ? null : describePosition({ position: detail.data.position, names });

  return (
    <>
      <div className="scrim" onClick={closeDrawer} aria-hidden="true" />
      <aside className="drawer" role="dialog" aria-modal="true" aria-labelledby="position-title">
        <div className="drawer-head">
          <h3 id="position-title">{heading?.title ?? 'Позиція'}</h3>
          <button type="button" className="close" ref={closeRef} aria-label="Закрити" onClick={closeDrawer}>
            ✕
          </button>
          {heading?.detail !== null && heading?.detail !== undefined && <div className="small muted">{keepTogether(heading.detail)}</div>}
        </div>
        {detail.isPending && <p className="note loading">Завантажую…</p>}
        {detail.isError && <p className="note err">{describeError(detail.error)}</p>}
        {detail.data !== undefined && <DrawerBody detail={detail.data} names={names} />}
      </aside>
    </>
  );
};
