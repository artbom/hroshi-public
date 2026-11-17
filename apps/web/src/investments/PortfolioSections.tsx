import type { AssetClassShare, IncomeYear, Investments, PortfolioPoint, Position } from '@hroshi/schema';
import { useState } from 'react';

import { ChartFigure } from '../components/ChartFigure.tsx';
import { SectionHead } from '../components/InfoTip.tsx';
import { Nothing } from '../components/Nothing.tsx';
import { TimeChart, type TimeSeries } from '../components/TimeChart.tsx';
import {
  formatCurrencySign,
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
import { AllocationTargets, formatDrift } from './AllocationTargets.tsx';
import { CLASS_COLORS, CLASS_LABELS, EXPOSURE_COLORS, EXPOSURE_LABELS, formatQuantity, formatWeight, formatXirr } from './shared.ts';

type Names = ReadonlyMap<string, string>;

const nameAccount = (names: Names, id: string) => names.get(id) ?? id;

const describePortfolioPoint = (entry: PortfolioPoint | undefined) =>
  entry === undefined ? null : (
    <>
      <b>{formatDay(entry.date)}</b>
      <br />
      Вартість: <span className="num">{formatEur(entry.valueEur)}</span>
      {entry.estimated && <span className="muted"> (оцінка)</span>}
      <br />
      Внесено: <span className="num">{formatEur(entry.contributedEur)}</span>
      <br />
      Різниця: <span className="num">{formatSignedEur(entry.valueEur - entry.contributedEur)}</span>
      {entry.benchmarkEur !== null && (
        <>
          <br />
          Якби в VWCE: <span className="num">{formatEur(entry.benchmarkEur)}</span>
        </>
      )}
    </>
  );

/** The same deposits in the index fund: a reference, so it is drawn dashed and thin under the real value. */
const listBenchmarkSeries = ({ benchmark, history }: Investments): TimeSeries[] =>
  benchmark === null
    ? []
    : [
        {
          key: 'benchmark',
          label: `Якби ті самі внески йшли у ${benchmark.symbol}`,
          color: 'var(--s3)',
          kind: 'line',
          dashed: true,
          points: history.points.flatMap((point) => (point.benchmarkEur === null ? [] : [{ date: point.date, value: point.benchmarkEur }])),
        },
      ];

/** Value against what went in, for the accounts where every deposit is known. */
export const PortfolioChart = ({ data, names }: { data: Investments; names: Names }) => {
  const { history } = data;
  if (history.points.length < 2) return null;
  const byDate = new Map(history.points.map((point) => [point.date, point]));
  const series: TimeSeries[] = [
    {
      key: 'value',
      label: 'Вартість',
      color: 'var(--s1)',
      kind: 'line',
      emphasis: true,
      // Modelled months stay solid: the line is the portfolio's best-known value; the note and the table mark the estimate.
      points: history.points.map((point) => ({ date: point.date, value: point.valueEur })),
    },
    {
      key: 'contributed',
      label: 'Внесено',
      color: 'var(--s2)',
      kind: 'step',
      points: history.points.map((point) => ({ date: point.date, value: point.contributedEur })),
    },
    ...listBenchmarkSeries(data),
  ];
  const latest = history.points.at(-1);
  const included = history.accountIds.map((id) => nameAccount(names, id)).join(' + ');
  const modelled = history.modelled.map((entry) => `${nameAccount(names, entry.accountId)} (${formatXirr(entry.xirr)})`).join(', ');
  const excluded = history.excluded.map(
    (entry) => `${nameAccount(names, entry.accountId)} (${entry.reason === 'no-flows' ? 'внесків у записах немає' : 'історія внесків неповна'})`,
  );
  const summary =
    latest === undefined
      ? ''
      : `${included}: вартість ${formatEur(latest.valueEur)}, внесено ${formatEur(latest.contributedEur)}, різниця ${formatSignedEur(
          latest.valueEur - latest.contributedEur,
        )} на ${formatDay(latest.date)}${latest.benchmarkEur === null ? '' : `; у VWCE було б ${formatEur(latest.benchmarkEur)}`}.`;

  return (
    <section>
      <SectionHead
        title="Вартість і внески"
        info={
          <>
            <p>Вартість {included} у євро на кінець кожного місяця проти внесків мінус виводи.</p>
            <p>Кожен внесок перераховано за курсом дня, коли гроші зайшли; вартість — за курсом на ту дату. Тож різниця тут містить і ефект курсу долара, на відміну від «Результату за звітами брокерів», де все в сьогоднішньому курсі.</p>
            {data.benchmark !== null && (
              <p>
                Пунктир — якби кожне поповнення купувало {data.benchmark.name} за ціною закриття того дня (у €, Xetra), а кожен вивід
                продавав. Ціни — щоденні закриття з Yahoo Finance, по {formatDay(data.benchmark.pricesUntil)}.
              </p>
            )}
            {modelled !== '' && (
              <p>
                {modelled}: брокер дає вартість лише на дату звіту, тож раніше вона оцінена — кожен внесок наростає за річною дохідністю
                рахунку (XIRR). У таблиці такі місяці позначено «оцінка». За визначенням XIRR оцінка сходиться з реальною вартістю на дату звіту.
              </p>
            )}
          </>
        }
      />
      <ChartFigure
        summary={summary}
        table={{
          columns: ['Дата', 'Вартість', 'Внесено', 'Різниця', 'Якби в VWCE'],
          rows: history.points.toReversed().map((point) => ({
            key: point.date,
            cells: [
              `${formatDay(point.date)}${point.estimated ? ' (оцінка)' : ''}`,
              formatEur(point.valueEur),
              formatEur(point.contributedEur),
              formatSignedEur(point.valueEur - point.contributedEur),
              point.benchmarkEur === null ? '—' : formatEur(point.benchmarkEur),
            ],
          })),
        }}
      >
        <TimeChart
          height={220}
          unit="€"
          series={series}
          describePoint={(_, point) => describePortfolioPoint(byDate.get(point.date))}
        />
      </ChartFigure>
      {modelled !== '' && (
        <p className="note inv-chart-note">
          Вартість {history.modelled.map((entry) => nameAccount(names, entry.accountId)).join(', ')} брокер дає лише на дату звіту; раніше
          вона оцінена за річною дохідністю рахунку.
        </p>
      )}
      {excluded.length > 0 && <p className="note inv-chart-note">Не входять: {excluded.join(', ')} — звіту з їхньою вартістю до відкриття в трекері немає, тож лінія вводила б в оману.</p>}
    </section>
  );
};

const DONUT_RADIUS = 52;
const DONUT_STROKE = 22;
const CIRCUMFERENCE = 2 * Math.PI * DONUT_RADIUS;

const Donut = ({ classes }: { classes: readonly AssetClassShare[] }) => {
  const starts = classes.reduce<number[]>((offsets, entry, index) => [...offsets, (offsets[index] ?? 0) + entry.weight], [0]);
  return (
    <svg className="donut" viewBox="0 0 140 140" width={140} height={140} aria-hidden="true">
      <circle cx={70} cy={70} r={DONUT_RADIUS} fill="none" stroke="var(--line)" strokeWidth={DONUT_STROKE} />
      {classes.map((entry, index) => (
        <circle
          key={entry.assetClass}
          cx={70}
          cy={70}
          r={DONUT_RADIUS}
          fill="none"
          stroke={CLASS_COLORS[entry.assetClass]}
          strokeWidth={DONUT_STROKE}
          strokeDasharray={`${Math.max(0, entry.weight * CIRCUMFERENCE - 2)} ${CIRCUMFERENCE}`}
          strokeDashoffset={-(starts[index] ?? 0) * CIRCUMFERENCE}
          transform="rotate(-90 70 70)"
        />
      ))}
    </svg>
  );
};

/** Positions priced in another currency than their account: the broker converts them at its own rate. */
const listForeignPositions = (data: Investments) => {
  const accountCurrencies = new Map(data.accounts.map((holding) => [holding.account.id, holding.account.currency]));
  return data.positions
    .filter((position) => position.remainder === null && position.currency !== accountCurrencies.get(position.accountId))
    .map((position) => `${position.symbol} у ${formatCurrencySign(position.currency)}`);
};

/** The donut sums positions; the headline sums account balances. A gap between them is the broker's rate, said once, here. */
const PositionsVsAccounts = ({ data, total }: { data: Investments; total: number }) => {
  if (Math.abs(total - data.valueEur) < 1) return null;
  const foreign = listForeignPositions(data);
  return (
    <p className="note inv-donut-note">
      {keepTogether(
        `${formatEur(total)} за позиціями проти ${formatEur(data.valueEur)} на рахунках: брокер переводить позиції в іншій валюті${
          foreign.length > 0 ? ` (${foreign.join(', ')})` : ''
        } за своїм курсом, а тут — за курсом НБУ.`,
      )}
    </p>
  );
};

/** What the money is in, whichever broker holds it. */
export const AllocationSection = ({ data, colors, names }: { data: Investments; colors: ReadonlyMap<string, string>; names: Names }) => {
  const total = data.assetClasses.reduce((sum, entry) => sum + entry.eur, 0);
  const cashLike = data.positions.filter((position) => position.cashLike && position.assetClass !== 'cash');
  const cashLikeEur = cashLike.reduce((sum, position) => sum + position.eur, 0);
  const cashEur = data.assetClasses.find((entry) => entry.assetClass === 'cash')?.eur ?? 0;
  const summary = data.assetClasses.map((entry) => `${CLASS_LABELS[entry.assetClass]} ${formatWeight(entry.weight)}`).join(', ');
  const targets = new Map(data.targets.map((target) => [target.assetClass, target.share]));

  return (
    <section>
      <SectionHead
        title="Розподіл"
        info={
          <>
            <p>Позиції всіх брокерів за класом активу, у євро за сьогоднішнім курсом, за останніми звітами.</p>
            <p>VGSH — фонд коротких (1–3 роки) казначейських облігацій США: ціна майже не рухається, тож це радше кеш у доларах, ніж ризик.</p>
            <p>Крипта — Binance (здебільшого USDT) і Walt без розбивки.</p>
          </>
        }
      />
      <ChartFigure
        summary={`Розподіл за класами: ${summary}.`}
        table={{
          columns: ['Клас', 'Частка', 'Вартість'],
          rows: data.assetClasses.map((entry) => ({
            key: entry.assetClass,
            cells: [CLASS_LABELS[entry.assetClass], formatWeight(entry.weight), formatEur(entry.eur)],
          })),
        }}
      >
        <div className="alloc">
          <div className="donut-wrap">
            <Donut classes={data.assetClasses} />
            <div className="donut-center">
              <span className="num">{formatEur(total)}</span>
            </div>
          </div>
          <ul className={targets.size > 0 ? 'alloc-legend with-targets' : 'alloc-legend'}>
            {data.assetClasses.map((entry) => {
              const target = targets.get(entry.assetClass);
              const drift = formatDrift({ weight: entry.weight, target: target ?? 0 });
              return (
                <li key={entry.assetClass}>
                  <i style={{ background: CLASS_COLORS[entry.assetClass] }} aria-hidden="true" />
                  <span>{CLASS_LABELS[entry.assetClass]}</span>
                  <span className="num">{formatWeight(entry.weight)}</span>
                  <span className="num muted">{formatEur(entry.eur)}</span>
                  {targets.size > 0 && (
                    <span className={`small num ${target !== undefined && drift.off ? 'warn-text' : 'muted'}`}>
                      {target === undefined ? 'без цілі' : drift.label}
                    </span>
                  )}
                </li>
              );
            })}
          </ul>
        </div>
      </ChartFigure>
      <PositionsVsAccounts data={data} total={total} />
      <div className="inv-targets-bar">
        <AllocationTargets data={data} />
      </div>
      {cashLikeEur > 0 && total > 0 && (
        <p className="note">
          Гроші й майже гроші: <b className="num">{formatPercent((cashEur + cashLikeEur) / total)}</b> ({formatEur(cashEur + cashLikeEur)}) —
          готівка на брокерах і {cashLike.map((position) => position.symbol).join(', ')} (короткі казначейські облігації).
        </p>
      )}
      <div className="alloc-accounts">
        <div className="small muted">За рахунками</div>
        <div className="stack" aria-hidden="true">
          {data.accounts.map((holding) => (
            <i key={holding.account.id} style={{ width: `${holding.share * 100}%`, background: colors.get(holding.account.id) }} />
          ))}
        </div>
        <div className="legend">
          {data.accounts.map((holding) => (
            <span key={holding.account.id}>
              <i style={{ background: colors.get(holding.account.id) }} />
              {nameAccount(names, holding.account.id)} {formatWeight(holding.share)}
            </span>
          ))}
        </div>
      </div>
      <CurrencyExposureBar data={data} />
    </section>
  );
};

/** Look-through notes: why a fund bought in dollars sits under another currency. */
const LOOK_THROUGH_NOTES: Readonly<Record<string, string>> = {
  VEA: 'VEA — акції Європи, Японії та інших розвинених ринків, куплені за долари',
  NVO: 'Novo Nordisk — данська крона, прив’язана до євро',
};

/** What the money moves with when the euro moves: spending is in euros, so a dollar share is a currency bet. */
const CurrencyExposureBar = ({ data }: { data: Investments }) => {
  const exposure = data.currencyExposure;
  if (exposure.length === 0) return null;
  const notes = exposure.flatMap((entry) => entry.lookThrough).flatMap((symbol) => {
    const note = LOOK_THROUGH_NOTES[symbol];
    return note === undefined ? [] : [note];
  });
  return (
    <div className="alloc-accounts">
      <div className="small muted">За валютою, у якій лежать гроші</div>
      <div className="stack" aria-hidden="true">
        {exposure.map((entry) => (
          <i key={entry.currency} style={{ width: `${entry.weight * 100}%`, background: EXPOSURE_COLORS[entry.currency] }} />
        ))}
      </div>
      <div className="legend">
        {exposure.map((entry) => (
          <span key={entry.currency}>
            <i style={{ background: EXPOSURE_COLORS[entry.currency] }} />
            {EXPOSURE_LABELS[entry.currency]} {formatWeight(entry.weight)} <span className="num">· {formatEur(entry.eur)}</span>
          </span>
        ))}
      </div>
      <p className="note">
        Не за валютою рахунку, а за тим, у чому позиція: USDT рахується як долар, інші токени — як інші валюти
        {notes.length > 0 && `; ${notes.join('; ')}`}. Витрати в євро, тож усе, крім євро, рухається разом із курсом.
      </p>
    </div>
  );
};

export const describePosition = ({ position, names }: { position: Position; names: Names }): { title: string; detail: string | null } => {
  switch (position.remainder) {
    case 'cash':
      return { title: `Гроші, ${formatCurrencySign(position.currency)}`, detail: 'у звіті немає окремим рядком: вартість рахунку мінус позиції' };
    case 'tokens':
      return { title: 'Інші токени', detail: 'Binance оцінює їх лише в загальній сумі гаманця' };
    case 'whole-account':
      return { title: nameAccount(names, position.accountId), detail: 'весь рахунок: звіту з розбивкою на активи немає' };
    case null:
      if (position.assetClass === 'cash') return { title: `Гроші, ${formatCurrencySign(position.currency)}`, detail: 'вільний залишок на рахунку брокера' };
      return { title: position.symbol, detail: position.name !== null && position.name !== position.symbol ? position.name : null };
  }
};

const Gain = ({ position, stacked = false }: { position: Position; stacked?: boolean }) => {
  if (position.gainEur === null || position.costEur === null) return <Nothing why="собівартості немає: звіт дає лише баланс" />;
  const share = position.costEur > 0 ? formatSignedPercent(position.gainEur / position.costEur) : null;
  return (
    <span className={position.gainEur < 0 ? 'num neg' : 'num pos'}>
      {formatSignedEur(position.gainEur)}
      {share !== null && (stacked ? <span className="small block">{share}</span> : <span className="small"> {share}</span>)}
    </span>
  );
};

/** What one unit cost on average, in the position's own currency; cash and balances have none. */
const findAverageCost = (position: Position): number | null =>
  position.cost === null || position.quantity === null || position.quantity <= 0 || position.price === 1 ? null : position.cost / position.quantity;

const Cost = ({ position }: { position: Position }) => {
  if (position.costEur === null) return <Nothing why="собівартості немає: звіт дає лише баланс" />;
  const average = findAverageCost(position);
  return (
    <>
      {formatEur(position.costEur)}
      {average !== null && <span className="small block muted">{`сер.\u00a0${formatMoney(average, position.currency)}`}</span>}
    </>
  );
};

const buildPositionHref = (key: string) => buildHref({ view: 'investments', param: key });

const openPosition = (key: string) => {
  window.location.hash = buildPositionHref(key);
};

const ClassChip = ({ position }: { position: Position }) => (
  <span className="class-chip">
    <i style={{ background: CLASS_COLORS[position.assetClass] }} aria-hidden="true" />
    {CLASS_LABELS[position.assetClass]}
    {position.cashLike && position.assetClass !== 'cash' && <span className="chip muted">≈ кеш</span>}
  </span>
);

const SORT_KEYS = ['weight', 'value', 'cost', 'gain', 'broker'] as const;
type SortKey = (typeof SORT_KEYS)[number];
type Sort = { key: SortKey; dir: 'asc' | 'desc' };

const SORT_LABELS: Readonly<Record<SortKey, string>> = {
  weight: 'Частка',
  value: 'Вартість',
  cost: 'Собівартість',
  gain: 'Результат',
  broker: 'Брокер',
};

/** Rows without the sorted figure (no cost, no result) go last whichever way the column is sorted. */
const sortPositions = ({ positions, sort, names }: { positions: readonly Position[]; sort: Sort; names: Names }): Position[] => {
  const direction = sort.dir === 'asc' ? 1 : -1;
  const pick = (position: Position): number | null => {
    switch (sort.key) {
      case 'weight':
        return position.weight;
      case 'value':
        return position.eur;
      case 'cost':
        return position.costEur;
      case 'gain':
        return position.gainEur;
      case 'broker':
        return null;
    }
  };
  return positions.toSorted((left, right) => {
    if (sort.key === 'broker') {
      return direction * nameAccount(names, left.accountId).localeCompare(nameAccount(names, right.accountId), 'uk') || right.weight - left.weight;
    }
    const a = pick(left);
    const b = pick(right);
    if (a === null || b === null) return Number(a === null) - Number(b === null);
    return direction * (a - b);
  });
};

/** A name sorts A→Я first; a figure biggest first. */
const nextSort = ({ sort, key }: { sort: Sort; key: SortKey }): Sort =>
  sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: key === 'broker' ? 'asc' : 'desc' };

const SortHeader = ({ column, sort, onSort, align }: { column: SortKey; sort: Sort; onSort: (sort: Sort) => void; align?: 'r' }) => (
  <th className={align} aria-sort={sort.key === column ? (sort.dir === 'asc' ? 'ascending' : 'descending') : 'none'}>
    <button type="button" className="sort-head" onClick={() => onSort(nextSort({ sort, key: column }))}>
      {SORT_LABELS[column]}
      <span className="sort-arrow" aria-hidden="true">
        {sort.key === column ? (sort.dir === 'asc' ? '↑' : '↓') : '↕'}
      </span>
    </button>
  </th>
);

const DEFAULT_SORT: Sort = { key: 'weight', dir: 'desc' };

/** Every position across brokers in one list, largest first; cards on a phone, where a seven-column table cannot fit. */
export const PositionsSection = ({ data, names }: { data: Investments; names: Names }) => {
  const [sort, setSort] = useState<Sort>(DEFAULT_SORT);
  const positions = sortPositions({ positions: data.positions, sort, names });
  const totalEur = positions.reduce((sum, position) => sum + position.eur, 0);
  const costed = positions.filter((position) => position.costEur !== null && position.gainEur !== null);
  const costEur = costed.reduce((sum, position) => sum + (position.costEur ?? 0), 0);
  const gainEur = costed.reduce((sum, position) => sum + (position.gainEur ?? 0), 0);
  const unpriced = data.accounts.reduce(
    (sum, holding) => sum + (holding.report?.holdings.filter((entry) => entry.value === null).length ?? 0),
    0,
  );

  return (
    <section id="inv-positions">
      <SectionHead
        title={`Позиції · ${pluralize(positions.length, ['рядок', 'рядки', 'рядків'])}`}
        info={
          <>
            <p>Позиції з останніх звітів IBKR і Freedom24, баланси Binance і Walt. Вартість на дату звіту, у євро за сьогоднішнім курсом.</p>
            <p>
              Собівартість — скільки позиція коштувала разом, як її рахує брокер, у валюті позиції й теж за сьогоднішнім курсом: тож результат
              показує рух ринку, без курсу долара. Під нею — середня ціна однієї штуки.
            </p>
            <p>Частка — від суми всіх рядків. Заголовок колонки сортує. Натисни рядок — кількість, дивіденди й угоди цієї позиції.</p>
          </>
        }
      >
        <label className="pos-sort">
          <span className="sr-only">Сортувати</span>
          <select
            value={sort.key}
            onChange={(event) => {
              const key = SORT_KEYS.find((candidate) => candidate === event.target.value);
              if (key !== undefined) setSort({ key, dir: key === 'broker' ? 'asc' : 'desc' });
            }}
          >
            {SORT_KEYS.map((key) => (
              <option key={key} value={key}>
                за: {SORT_LABELS[key].toLowerCase()}
              </option>
            ))}
          </select>
        </label>
      </SectionHead>
      <div className="tbl pos-table">
        <table>
          <thead>
            <tr>
              <th>Позиція</th>
              <th>Клас</th>
              <SortHeader column="weight" sort={sort} onSort={setSort} align="r" />
              <SortHeader column="value" sort={sort} onSort={setSort} align="r" />
              <SortHeader column="cost" sort={sort} onSort={setSort} align="r" />
              <SortHeader column="gain" sort={sort} onSort={setSort} align="r" />
              <SortHeader column="broker" sort={sort} onSort={setSort} />
            </tr>
          </thead>
          <tbody>
            {positions.map((position) => {
              const { title, detail } = describePosition({ position, names });
              return (
                <tr key={position.key} className="clickable" onClick={() => openPosition(position.key)}>
                  <td>
                    <a className="plain" href={buildPositionHref(position.key)} onClick={(event) => event.stopPropagation()}>
                      <b>{title}</b>
                    </a>
                    {detail !== null && <div className="small muted">{keepTogether(detail)}</div>}
                    {position.quantity !== null && position.price !== null && position.price !== 1 && (
                      <div className="small muted num">
                        {formatQuantity(position.quantity)} × {formatMoney(position.price, position.currency)}
                      </div>
                    )}
                  </td>
                  <td>
                    <ClassChip position={position} />
                  </td>
                  <td className="r num">{formatWeight(position.weight)}</td>
                  <td className="r num">{formatEur(position.eur)}</td>
                  <td className="r num muted">
                    <Cost position={position} />
                  </td>
                  <td className="r">
                    <Gain position={position} stacked />
                  </td>
                  <td className="inv-broker">{nameAccount(names, position.accountId)}</td>
                </tr>
              );
            })}
          </tbody>
          <tfoot>
            <tr>
              <th>Разом</th>
              <td />
              <td className="r num">100%</td>
              <td className="r num">{formatEur(totalEur)}</td>
              <td className="r num muted">{formatEur(costEur)}</td>
              <td className={`r num ${gainEur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(gainEur)}</td>
              <td />
            </tr>
          </tfoot>
        </table>
      </div>
      <div className="pos-cards">
        {positions.map((position) => {
          const { title, detail } = describePosition({ position, names });
          const average = findAverageCost(position);
          return (
            <a key={position.key} className="pos-card plain" href={buildPositionHref(position.key)}>
              <div className="pos-line">
                <b>{title}</b>
                <span className="num">{formatEur(position.eur)}</span>
              </div>
              {detail !== null && <div className="small muted">{keepTogether(detail)}</div>}
              <div className="pos-line small">
                <ClassChip position={position} />
                <span className="num muted">{formatWeight(position.weight)}</span>
              </div>
              <div className="pos-line small">
                <span className="muted">
                  {nameAccount(names, position.accountId)}
                  {position.costEur !== null && ` · собівартість ${formatEur(position.costEur)}`}
                  {average !== null && ` · сер.\u00a0${formatMoney(average, position.currency)}`}
                </span>
                <Gain position={position} />
              </div>
            </a>
          );
        })}
        <div className="pos-card pos-total">
          <div className="pos-line">
            <b>Разом</b>
            <span className="num">{formatEur(totalEur)}</span>
          </div>
          <div className="pos-line small">
            <span className="muted">результат позицій з відомою собівартістю</span>
            <span className={`num ${gainEur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(gainEur)}</span>
          </div>
        </div>
      </div>
      {unpriced > 0 && (
        <p className="note">
          Ще {pluralize(unpriced, ['токен', 'токени', 'токенів'])} Binance без ціни у файлі (аірдропи й залишки): їхня вартість — у рядку «Інші
          токени».
        </p>
      )}
    </section>
  );
};

/** Treaty rate a W-8BEN brings US dividend withholding down to; 30% is the rate without the form. */
const TREATY_RATE = 0.15;
const NO_FORM_RATE = 0.3;
/** Withholding this close to 30% is the no-form rate, not a mix of payouts. */
const NO_FORM_THRESHOLD = 0.25;

const isNoFormRate = (row: IncomeYear) => row.withholdingRate !== null && row.withholdingRate >= NO_FORM_THRESHOLD;

const NO_TRADE_LOG = 'журналу угод у звіті немає (у Flex-запиті IBKR — розділу Trades)';
const NO_SALES = 'продажів не було';

const Realized = ({ row }: { row: IncomeYear }) => {
  if (row.realized === null) return <Nothing why={NO_TRADE_LOG} />;
  return row.realized === 0 ? <Nothing why={NO_SALES} /> : <>{formatSignedMoney(row.realized, row.currency)}</>;
};

/** A year's realised result in euros: a sum only where some broker sold something. */
const RealizedTotal = ({ rows }: { rows: readonly IncomeYear[] }) => {
  const known = rows.flatMap((row) => (row.eur.realized === null ? [] : [row.eur.realized]));
  const total = known.reduce((sum, value) => sum + value, 0);
  if (Math.round(total) === 0) return <Nothing why={known.length < rows.length ? `${NO_SALES} або ${NO_TRADE_LOG}` : NO_SALES} />;
  return <>{formatSignedEur(total)}</>;
};

const IncomeCard = ({ row, names }: { row: IncomeYear; names: Names }) => (
  <div className="pos-card">
    <div className="pos-line">
      <b>
        {row.year} · {nameAccount(names, row.accountId)}
      </b>
      <span className="num pos">{formatMoney(row.dividends, row.currency)}</span>
    </div>
    <div className="pos-line small">
      <span className="muted">
        утримано {row.withholdingRate === null ? '' : formatPercent(row.withholdingRate)}{' '}
        {isNoFormRate(row) && <span className="chip warn">W-8BEN?</span>}
      </span>
      <span className="num neg">{formatMoney(row.withholding, row.currency)}</span>
    </div>
    <div className="pos-line small">
      <span className="muted">реалізовано</span>
      <span className="num">
        <Realized row={row} />
      </span>
    </div>
  </div>
);

const IncomeRow = ({ row, names }: { row: IncomeYear; names: Names }) => {
  const flagged = isNoFormRate(row);
  return (
    <tr>
      <td className="num">{row.year}</td>
      <td>{nameAccount(names, row.accountId)}</td>
      <td className="r num pos">{formatMoney(row.dividends, row.currency)}</td>
      <td className="r num neg">{formatMoney(row.withholding, row.currency)}</td>
      <td className="r num">
        {row.withholdingRate === null ? <Nothing why="дивідендів не було" /> : formatPercent(row.withholdingRate)}
        {flagged && (
          <>
            {' '}
            <span className="chip warn">W-8BEN?</span>
          </>
        )}
      </td>
      <td className="r num">
        <Realized row={row} />
      </td>
    </tr>
  );
};

/** Dividends, the US tax withheld from them, and realised gains, per year: what a tax return asks for. */
export const IncomeSection = ({ data, names }: { data: Investments; names: Names }) => {
  const { income } = data;
  if (income.length === 0) return null;
  const flagged = income.filter(isNoFormRate);
  const years = [...new Set(income.map((row) => row.year))];
  const flaggedAccounts = [...new Set(flagged.map((row) => nameAccount(names, row.accountId)))].join(', ');
  const excess = flagged.reduce((sum, row) => sum + (row.eur.withholding - row.eur.dividends * TREATY_RATE), 0);

  return (
    <section id="inv-income">
      <SectionHead
        title="Дивіденди й податки"
        info={
          <>
            <p>З грошових записів брокерів: дивіденди і податок, який брокер утримав з них у США. Ставка — утримано ÷ дивіденди.</p>
            <p>
              З формою W-8BEN брокер утримує {formatPercent(TREATY_RATE)} (ставка договору про подвійне оподаткування), без неї —{' '}
              {formatPercent(NO_FORM_RATE)}.
            </p>
            <p>Реалізовано — прибуток з продажів за FIFO зі звіту брокера. «—» — продажів не було або журналу угод у звіті немає (наведи, щоб побачити).</p>

          </>
        }
      />
      {flagged.length > 0 && (
        <div className="callout warn">
          <b>{flaggedAccounts} утримує {formatPercent(NO_FORM_RATE)} з дивідендів, а не {formatPercent(TREATY_RATE)}.</b> Схоже, форму W-8BEN
          там не подано (у Freedom24 ставка ≈ {formatPercent(TREATY_RATE)}). Зайво утримано ≈ {formatEur(excess)} — і далі буде вдвічі більше
          податку з кожної виплати, доки форму не заповнено.
        </div>
      )}
      <div className="tbl income-table">
        <table>
          <thead>
            <tr>
              <th>Рік</th>
              <th>Брокер</th>
              <th className="r">Дивіденди</th>
              <th className="r">Утримано</th>
              <th className="r">Ставка</th>
              <th className="r">Реалізовано</th>
            </tr>
          </thead>
          {years.map((year) => {
            const rows = income.filter((row) => row.year === year);
            const dividends = rows.reduce((sum, row) => sum + row.eur.dividends, 0);
            const withholding = rows.reduce((sum, row) => sum + row.eur.withholding, 0);
            return (
              <tbody key={year}>
                {rows.map((row) => (
                  <IncomeRow key={row.accountId} row={row} names={names} />
                ))}
                <tr className="subtotal">
                  <td className="num">{year}</td>
                  <td className="muted">разом у євро</td>
                  <td className="r num">{formatEur(dividends)}</td>
                  <td className="r num">{formatEur(withholding)}</td>
                  <td className="r num">{dividends > 0 ? formatPercent(withholding / dividends) : <Nothing why="дивідендів не було" />}</td>
                  <td className="r num">
                    <RealizedTotal rows={rows} />
                  </td>
                </tr>
              </tbody>
            );
          })}
        </table>
      </div>
      <div className="pos-cards">
        {income.map((row) => (
          <IncomeCard key={`${row.year}-${row.accountId}`} row={row} names={names} />
        ))}
      </div>
      <p className="note">Суми в євро — за курсом дня виплати; у розкладі результату вище ті самі дивіденди за сьогоднішнім курсом.</p>
    </section>
  );
};
