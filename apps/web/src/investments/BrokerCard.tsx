import type { AllTimeIssue, BrokerTrade, ContributionSummary, InvestmentAccount, InvestmentFlow } from '@hroshi/schema';
import { useState } from 'react';

import { ChartFigure } from '../components/ChartFigure.tsx';
import { useDrawer } from '../components/DrawerContext.tsx';
import { InfoTip } from '../components/InfoTip.tsx';
import { Nothing } from '../components/Nothing.tsx';
import { AccountMark } from '../components/SourceMark.tsx';
import { TimeChart, type TimePoint, type TimeSeries } from '../components/TimeChart.tsx';
import {
  formatAccountName,
  formatCurrencySign,
  formatDay,
  formatDecimal,
  formatEur,
  formatMoney,
  formatSignedMoney,
  formatSignedPercent,
  keepTogether,
  pluralize,
} from '../format.ts';
import { buildHref } from '../route.ts';
import { GapsSheet } from './GapsSheet.tsx';
import { BROKER_NAMES, FLOW_LABELS, formatQuantity, formatWeight, formatXirr, SOURCE_LABELS } from './shared.ts';

/** More known values than this means the broker reports one a day (IBKR NAV), worth a line. */
const DAILY_POINTS = 10;

/** A statement total this close to the tracker's balance is the same number, rounded. */
const SAME_VALUE_TOLERANCE = 1;

const Gain = ({ summary, currency }: { summary: Pick<ContributionSummary, 'gain' | 'gainShare'>; currency: string }) => (
  <span className={summary.gain < 0 ? 'num neg' : 'num pos'}>
    {formatSignedMoney(summary.gain, currency)}
    {summary.gainShare !== null && ` (${formatSignedPercent(summary.gainShare)})`}
  </span>
);

const describeIssue = (issue: AllTimeIssue, holding: InvestmentAccount): string => {
  const currency = holding.account.currency;
  switch (issue) {
    case 'no-flows':
      return 'жодного поповнення в записах — внески невідомі';
    case 'negative-history':
      return 'якщо йти назад від початкового балансу, рахунок іде в мінус — частина виводів не записана';
    case 'unexplained-start':
      return `до першого запису на рахунку вже було ≈ ${formatMoney(holding.startValue ?? 0, currency)} — пропущені поповнення або ріст до початку обліку`;
    case 'unknown-credits':
      return `${pluralize(holding.allTime.unknown, ['поповнення', 'поповнення', 'поповнень'])} без суми зарахування — оцінено за курсом НБУ`;
    case 'duplicates':
      return `${pluralize(holding.allTime.duplicates, ['рух', 'рухи', 'рухів'])} схожі на дублі`;
  }
};

/**
 * Where the value on the card comes from, in one place: the statement and its date, the
 * valuation row that put it into the ledger (which can be dated a day apart), or the opening
 * balance when nothing revalued the account yet.
 */
const ValueSource = ({ holding }: { holding: InvestmentAccount }) => {
  const { account, lastValuation, report } = holding;
  const currency = account.currency;
  if (report === null) {
    if (lastValuation !== null) {
      return (
        <>
          оцінка на {formatDay(lastValuation.date)} · {SOURCE_LABELS[lastValuation.source] ?? lastValuation.source}
        </>
      );
    }
    return <>оцінка на {formatDay(account.valuedAt ?? account.openingDate)} · початковий баланс, внесений вручну; переоцінок ще не було</>;
  }
  const matches = report.netAssets !== null && Math.abs(report.netAssets - account.balance) <= SAME_VALUE_TOLERANCE;
  return (
    <>
      {BROKER_NAMES[report.broker] ?? report.broker} на {formatDay(report.asOf)}
      {matches && <span className="check-ok"> · ✓ як у балансі</span>}
      {report.netAssets !== null && !matches && (
        <span className="check-bad"> · у звіті {formatMoney(report.netAssets, currency)}, у балансі {formatMoney(account.balance, currency)}</span>
      )}
      {lastValuation !== null && lastValuation.date !== report.asOf && (
        <>
          {' '}
          · переоцінку записано {formatDay(lastValuation.date)}
          <InfoTip label="дата переоцінки">
            <p>
              Звіт описує {formatDay(report.asOf)}, а рядок переоцінки, що переносить його в баланс, датовано{' '}
              {formatDay(lastValuation.date)}.
            </p>
            <p>{matches ? 'Сума та сама, тож баланс актуальний на дату звіту.' : 'Суми різняться: потрібна нова переоцінка за свіжим звітом.'}</p>
          </InfoTip>
        </>
      )}
    </>
  );
};

const FlowRow = ({ flow, currency, names }: { flow: InvestmentFlow; currency: string; names: ReadonlyMap<string, string> }) => {
  const { openTransaction } = useDrawer();
  const counter = names.get(flow.counterAccountId) ?? flow.counterAccountId;
  return (
    <button type="button" className="row" onClick={() => openTransaction(flow.id)}>
      <span>
        {flow.direction === 'in' ? `з ${counter}` : `на ${counter}`}{' '}
        {flow.amount === null && <span className="chip warn">сума невідома</span>}{' '}
        {flow.suspectedDuplicate && <span className="chip bad">можливий дубль</span>}
      </span>
      <span className={`r num ${flow.direction === 'in' ? 'pos' : 'neg'}`}>
        {flow.direction === 'in' ? '+' : '−'}
        {flow.amount === null ? `≈ ${formatMoney(flow.estimate ?? 0, currency)}` : formatMoney(flow.amount, currency)}
      </span>
      <span className="s">
        {formatDay(flow.date)}
        {flow.counterCurrency !== currency && ` · ${formatMoney(flow.counterAmount, flow.counterCurrency)}`}
      </span>
    </button>
  );
};

/** Sales the broker booked a FIFO result on, summed in the trade currency when they share one. */
const sumRealized = (trades: readonly BrokerTrade[] | null) => {
  const sales = (trades ?? []).filter((trade) => trade.realized !== null);
  const [first] = sales;
  if (first === undefined || sales.some((trade) => trade.currency !== first.currency)) return null;
  return { amount: sales.reduce((sum, trade) => sum + (trade.realized ?? 0), 0), currency: first.currency, count: sales.length };
};

const BrokerBlock = ({ holding }: { holding: InvestmentAccount }) => {
  const { broker, account } = holding;
  if (broker === null) return null;
  const currency = account.currency;
  const realized = sumRealized(holding.trades);
  return (
    <dl className="facts">
      <dt>
        Внесено
        <InfoTip label="внесено за звітом брокера">
          <p>Поповнення мінус виводи з власних грошових записів брокера, у валюті рахунку (євро — за курсом брокера або НБУ на день).</p>
          <p>Тут враховано всі внески, навіть ті, яких немає серед записів трекера.</p>
        </InfoTip>
      </dt>
      <dd className="num">
        {formatMoney(broker.net, currency)}
        {broker.firstDeposit !== null && <span className="muted"> з {formatDay(broker.firstDeposit)}</span>}
      </dd>
      <dt>Результат</dt>
      <dd>
        <Gain summary={broker} currency={currency} />
      </dd>
      <dt>
        XIRR
        <InfoTip label="XIRR">
          <p>
            Грошово-зважена річна дохідність у {formatCurrencySign(currency)}: враховує, коли саме вносились гроші. Для рахунку молодшого за рік —
            дуже чутлива до останніх тижнів.
          </p>
        </InfoTip>
      </dt>
      <dd className="num">{formatXirr(broker.xirr)}</dd>
      <dt>Дохід і витрати</dt>
      <dd className="small">
        дивіденди <span className="num pos">{formatMoney(broker.dividends, currency)}</span> · податки{' '}
        <span className="num neg">{formatMoney(broker.taxes, currency)}</span>
        {broker.fees !== 0 && (
          <>
            {' '}
            · комісії <span className="num neg">{formatMoney(broker.fees, currency)}</span>
          </>
        )}
        {broker.interest !== 0 && <> · відсотки {formatMoney(broker.interest, currency)}</>}
      </dd>
      {realized !== null && (
        <>
          <dt>Продажі</dt>
          <dd className="small">
            {pluralize(realized.count, ['продаж', 'продажі', 'продажів'])}, результат за FIFO{' '}
            <span className={`num ${realized.amount < 0 ? 'neg' : 'pos'}`}>{formatSignedMoney(realized.amount, realized.currency)}</span>
          </dd>
        </>
      )}
    </dl>
  );
};

const LedgerBlock = ({ holding, onShowGaps }: { holding: InvestmentAccount; onShowGaps: () => void }) => {
  const { allTime, account, sinceOpening, broker } = holding;
  const currency = account.currency;
  return (
    <>
      <dl className="facts">
        <dt>
          З {formatDay(account.openingDate)}
          <InfoTip label="прибуток з дати початку обліку">
            <p>Вартість зараз − початковий баланс − внески після дати початку. З цієї дати облік повний.</p>
          </InfoTip>
        </dt>
        <dd>
          <Gain summary={sinceOpening} currency={currency} />
        </dd>
        <dt>
          Записи трекера
          <InfoTip label="внески за записами трекера">
            <p>Скільки поповнень бачить сам трекер. Якщо є звіт брокера, різниця показує, яких переказів бракує в записах.</p>
          </InfoTip>
        </dt>
        <dd className="small">
          {holding.flows.length === 0 ? (
            'поповнень у записах немає'
          ) : (
            <>
              внесено {formatMoney(allTime.estimatedNet, currency)}
              {broker !== null && Math.abs(broker.net - allTime.estimatedNet) > 1 && (
                <>
                  {' · '}
                  <button type="button" className="link-button check-bad" onClick={onShowGaps}>
                    {broker.net > allTime.estimatedNet ? 'бракує' : 'зайві'} {formatMoney(Math.abs(broker.net - allTime.estimatedNet), currency)} проти брокера →
                  </button>
                </>
              )}
            </>
          )}
        </dd>
      </dl>
      {broker === null && holding.allTimeIssues.length > 0 && (
        <div className="note">
          Прибуток за весь час не порахувати:
          <ul style={{ margin: '4px 0 0', paddingLeft: 18 }}>
            {holding.allTimeIssues.map((issue) => (
              <li key={issue}>{keepTogether(describeIssue(issue, holding))}</li>
            ))}
          </ul>
        </div>
      )}
    </>
  );
};

const describeMoneyPoint = ({ series, point, currency }: { series: TimeSeries; point: TimePoint; currency: string }) => (
  <>
    <b>{formatDay(point.date)}</b>
    <br />
    {series.label}: <span className="num">{formatMoney(point.value, currency)}</span>
  </>
);

/** The broker's daily value as the chart's main line; a handful of known days draw no line at all. */
const listValueSeries = ({ values, daily }: { values: readonly TimePoint[]; daily: boolean }): TimeSeries[] =>
  daily ? [{ key: 'value', label: 'Вартість (щодня за брокером)', color: 'var(--s1)', kind: 'line', emphasis: true, points: values }] : [];

/** Value and deposits over time, from the first money in: months before it are empty axis. */
const AccountChart = ({ holding }: { holding: InvestmentAccount }) => {
  const currency = holding.account.currency;
  // The opening, a valuation and a broker value can share a day; one point per day is what the chart can show.
  const values = [...new Map(holding.values.map((point) => [point.date, { date: point.date, value: point.value }])).values()];
  const firstMoney = holding.contributions.findIndex((point) => point.contributed !== 0);
  const contributions = firstMoney === -1 ? [] : holding.contributions.slice(firstMoney);
  // A few known days (the opening, a valuation, today) are no line; the note says when the value is known instead.
  const daily = values.length > DAILY_POINTS;
  const series: TimeSeries[] = [
    ...(contributions.length > 0
      ? [
          {
            key: 'contributed',
            label: holding.broker === null ? 'Внесено (за записами)' : 'Внесено (за брокером)',
            color: 'var(--s2)',
            kind: 'step' as const,
            points: contributions.map((point) => ({ date: point.date, value: point.contributed })),
          },
        ]
      : []),
    ...listValueSeries({ values, daily }),
  ];
  const latest = values.at(-1);
  const contributed = contributions.at(-1)?.contributed;
  const summary = `${formatAccountName(holding.account.name)}: вартість ${latest === undefined ? '—' : formatMoney(latest.value, currency)}${
    contributed === undefined ? '' : `, внесено ${formatMoney(contributed, currency)}`
  }${contributions[0] === undefined ? '' : ` з ${formatDay(contributions[0].date)}`}.`;
  // The table lists month ends; daily broker values would make it hundreds of rows long.
  const rows = contributions.length > 0 ? contributions.map((point) => ({ date: point.date, contributed: point.contributed })) : values.map((point) => ({ date: point.date, contributed: null }));
  const findValue = (date: string) => values.findLast((point) => point.date <= date)?.value;
  return (
    <>
    <ChartFigure
      summary={summary}
      table={{
        columns: ['Дата', 'Вартість', 'Внесено'],
        rows: rows.map((row) => {
          const value = findValue(row.date);
          return {
            key: row.date,
            cells: [
              formatDay(row.date),
              value === undefined ? <Nothing key="value" why="вартість на цю дату невідома" /> : formatMoney(value, currency),
              row.contributed === null ? <Nothing key="contributed" why="внесків у записах немає" /> : formatMoney(row.contributed, currency),
            ],
          };
        }),
      }}
    >
      <TimeChart height={160} unit={formatCurrencySign(currency)} series={series} describePoint={(entry, point) => describeMoneyPoint({ series: entry, point, currency })} />
    </ChartFigure>
      {!daily && (
        <p className="note">
          {keepTogether(
            `Лінія — внески. Вартість ${formatAccountName(holding.account.name)} брокер дає лише на дату звіту${
              latest === undefined ? '' : ` (${formatMoney(latest.value, currency)} на ${formatDay(holding.report?.asOf ?? latest.date)})`
            }, тож історії вартості тут немає.`,
          )}
        </p>
      )}
    </>
  );
};

/** «Купівля META», or for an exchange «Продаж EUR за USD». */
const TradeTitle = ({ trade }: { trade: BrokerTrade }) => {
  const side = trade.side === 'buy' ? 'Купівля' : 'Продаж';
  if (trade.kind === 'security') return <>{side} <b>{trade.symbol.replace(/\.(US|EU)$/u, '')}</b></>;
  const [base = '', quote = ''] = trade.symbol.split('/');
  return (
    <>
      {side} <b>{formatCurrencySign(base)}</b> за {formatCurrencySign(quote)}
    </>
  );
};

/** «4 × 177,09 $» for shares; «97,16 € за курсом 1,1499» for an exchange. */
const describeTradeSize = (trade: BrokerTrade) =>
  trade.kind === 'security'
    ? `${formatQuantity(trade.quantity)} × ${formatMoney(trade.price, trade.currency)}`
    : `${formatMoney(trade.quantity, trade.symbol.split('/')[0] ?? trade.currency)} за курсом ${formatDecimal(trade.price, 4)}`;

/** The broker's own trade log: what was bought, sold or exchanged, at what price and commission. */
const TradeLog = ({ trades }: { trades: readonly BrokerTrade[] }) => (
  <div className="list">
    {trades.map((trade, index) => (
      <div key={`${trade.date}-${trade.symbol}-${index}`} className="row">
        <span>
          <TradeTitle trade={trade} />
        </span>
        <span className={`r num ${trade.side === 'buy' ? '' : 'pos'}`}>
          {trade.side === 'buy' ? '−' : '+'}
          {formatMoney(trade.amount, trade.currency)}
        </span>
        <span className="s">
          {formatDay(trade.date)} · {describeTradeSize(trade)}
          {trade.fee !== null && trade.fee !== 0 && ` · комісія ${formatMoney(trade.fee, trade.feeCurrency ?? trade.currency)}`}
          {trade.realized !== null && ` · результат ${formatSignedMoney(trade.realized, trade.currency)}`}
        </span>
      </div>
    ))}
  </div>
);

export const BrokerCard = ({
  holding,
  color,
  names,
}: {
  holding: InvestmentAccount;
  color: string;
  names: ReadonlyMap<string, string>;
}) => {
  const { account } = holding;
  const currency = account.currency;
  const showChart =
    (holding.broker !== null || !holding.allTimeIssues.includes('negative-history')) &&
    (holding.contributions.some((point) => point.contributed !== 0) || holding.values.length > DAILY_POINTS);
  const [showGaps, setShowGaps] = useState(false);
  const exchanges = holding.trades === null ? 0 : holding.trades.filter((trade) => trade.kind === 'currency').length;

  return (
    <div className="card">
      <div className="head">
        <div>
          <div className="t">
            <span className="sw" style={{ background: color }} aria-hidden="true" />
            <AccountMark account={account} size="sm" />{' '}
            <a className="plain" href={buildHref({ view: 'accounts', param: account.id })}>
              {formatAccountName(account.name)}
            </a>
          </div>
          <div className="s">
            <ValueSource holding={holding} />
          </div>
        </div>
        <div style={{ textAlign: 'right' }}>
          <div className="num" style={{ fontWeight: 600, fontSize: 18 }}>
            {formatMoney(account.balance, currency)}
          </div>
          <div className="small muted num">
            {holding.eur === null ? '' : `≈ ${formatEur(holding.eur)} · `}
            {formatWeight(holding.share)}
          </div>
        </div>
      </div>
      <BrokerBlock holding={holding} />
      <LedgerBlock holding={holding} onShowGaps={() => setShowGaps(true)} />
      {showChart && <AccountChart holding={holding} />}
      {holding.trades !== null && holding.trades.length > 0 && (
        <details className="fold">
          <summary>
            Угоди ({holding.trades.length}
            {exchanges > 0 && `, з них обмін валют — ${exchanges}`})
          </summary>
          <TradeLog trades={holding.trades} />
        </details>
      )}
      {holding.trades === null && holding.report?.broker === 'ibkr' && (
        <p className="note">Угоди IBKR з’являться, коли у Flex-запит додати розділ Trades.</p>
      )}
      {holding.brokerFlows.length > 0 && (
        <details className="fold">
          <summary>Грошові записи брокера ({holding.brokerFlows.length})</summary>
          <div className="list">
            {holding.brokerFlows.map((flow, index) => (
              <div key={`${flow.date}-${index}`} className="row">
                <span>{FLOW_LABELS[flow.kind]}</span>
                <span className={`r num ${flow.amount < 0 ? 'neg' : 'pos'}`}>{formatSignedMoney(flow.amount, currency)}</span>
                <span className="s">
                  {formatDay(flow.date)}
                  {flow.original !== null && ` · надіслано ${formatMoney(flow.original.amount, flow.original.currency)}`}
                  {flow.note !== null && ` · ${keepTogether(flow.note)}`}
                </span>
              </div>
            ))}
          </div>
        </details>
      )}
      {holding.flows.length > 0 && (
        <details className="fold">
          <summary>Перекази в записах трекера ({holding.flows.length})</summary>
          <div className="list">
            {holding.flows.map((flow) => (
              <FlowRow key={flow.id} flow={flow} currency={currency} names={names} />
            ))}
          </div>
        </details>
      )}
      {showGaps && <GapsSheet holding={holding} names={names} onClose={() => setShowGaps(false)} />}
    </div>
  );
};
