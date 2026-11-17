import type { BridgeOtherPart, BridgeValuationPart, NetWorthBridge } from '@hroshi/schema';
import type { ReactNode } from 'react';

import { describeError } from '../api.ts';
import { ChartFigure } from '../components/ChartFigure.tsx';
import { InfoTip, SectionHead } from '../components/InfoTip.tsx';
import { NET_WORTH_BUCKETS } from '../components/netWorthBuckets.ts';
import { StackedChart } from '../components/StackedChart.tsx';
import {
  formatAccountName,
  formatCurrencySign,
  formatDay,
  formatEur,
  formatMoneyWhole,
  formatMonthLong,
  formatMonthShort,
  formatSignedEur,
  keepTogether,
  pluralize,
} from '../format.ts';
import { findCurrentMonth } from '../months.ts';
import { useAccounts, useNetWorth, useNetWorthBridge, useNetWorthHistory } from '../queries.ts';
import { buildHref, buildTableHref } from '../route.ts';
import { countMonths, type ResolvedPeriod } from './period.ts';

const BUCKET_COLORS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'] as const;
const BUCKETS = NET_WORTH_BUCKETS.map((bucket, index) => ({ ...bucket, color: BUCKET_COLORS[index] ?? 'var(--s1)' }));

/** The API serves at most this many months of history. */
const MAX_HISTORY_MONTHS = 120;

const Tile = ({ label, value, main = false, href }: { label: string; value: number; main?: boolean; href?: string }) => (
  <a className={main ? 'tile main plain' : 'tile plain'} href={href}>
    <span className="k">{label}</span>
    {/* Card debt is deliberate, so it is not painted as a loss. */}
    <span className="v num">{formatEur(value)}</span>
  </a>
);

const StepBar = ({ value, max }: { value: number; max: number }) => (
  <span className="bar" style={{ gridColumn: '1 / -1', height: 4 }} aria-hidden="true">
    <i style={{ width: `${(Math.abs(value) / max) * 100}%`, background: value < 0 ? 'var(--neg)' : 'var(--pos)' }} />
  </span>
);

type Range = { from: string; to: string };

const RowsLink = ({ href, children }: { href: string; children: ReactNode }) => (
  <a className="bridge-link" href={href}>
    {children}
  </a>
);

const describeOtherPart = ({
  part,
  range,
  names,
  fromStatement,
}: {
  part: BridgeOtherPart;
  range: Range;
  names: ReadonlyMap<string, string>;
  /** Accounts whose market move in this bridge comes from the broker's statement. */
  fromStatement: ReadonlySet<string>;
}): { label: ReactNode; note: string } => {
  const rows = pluralize(part.rows, ['запис', 'записи', 'записів']);
  switch (part.kind) {
    case 'spending':
      return {
        label: <RowsLink href={buildTableHref({ type: 'expense', category: part.category, ...range })}>Витрати «{part.category}»</RowsLink>,
        note: `${rows}; категорія не рахується витратою, але гроші пішли з рахунків`,
      };
    case 'income':
      return {
        label: <RowsLink href={buildTableHref({ type: 'income', category: part.category, ...range })}>Надходження «{part.category}»</RowsLink>,
        note: `${rows}; не дохід і не повернення, але гроші прийшли на рахунки`,
      };
    case 'transfers':
      return {
        label: <RowsLink href={buildTableHref({ type: 'transfer', ...range })}>Перекази</RowsLink>,
        note: `${rows}: різниця курсу обміну між рахунками та перекази з невідомою сумою зарахування`,
      };
    case 'brokers': {
      const name = keepTogether(names.get(part.accountId ?? '') ?? part.accountId ?? 'Брокер');
      const covered = fromStatement.has(part.accountId ?? '');
      return {
        label: <RowsLink href={buildHref({ view: 'investments' })}>{name}: внески за звітом брокера</RowsLink>,
        note: covered
          ? `${pluralize(part.rows, ['внесок', 'внески', 'внесків'])} у звіті брокера за період; на цю суму в трекері немає переказів із сумою зарахування — гроші пішли з банку як «Інвестиції» або переказом без суми`
          : 'вартість за звітом брокера замість оцінки трекера на одному з кінців періоду',
      };
    }
    case 'rates':
      return {
        label: <RowsLink href={buildTableHref({ ...range })}>Курс на гроші, що прийшли й пішли за період</RowsLink>,
        note: `${rows} не в євро: кожен рахується за курсом свого дня, баланс на кінець — за курсом кінця`,
      };
    case 'rest':
      return { label: 'Незведений залишок', note: 'записи без курсу на свій день, оплати карткою в євро, округлення' };
  }
};

const describeValuationPart = (part: BridgeValuationPart): string =>
  part.source === 'broker'
    ? `за звітом брокера: вартість на кінець мінус на початок і мінус внески${part.firstDate === null ? '' : `; рахунок з ${formatDay(part.firstDate)}`}`
    : `записи «переоцінка»${part.firstDate === null ? '' : ` з ${formatDay(part.firstDate)}`}; раніших ринкових змін трекер не знає`;

const findEarliest = (parts: readonly BridgeValuationPart[]) =>
  parts
    .map((part) => part.firstDate)
    .filter((date) => date !== null)
    .toSorted()[0];

/**
 * «IBKR — за звітом брокера, з 15 черв. 2026; Freedom24, Binance — лише записи «переоцінка» з 10 лист. 2026»:
 * where each figure starts, in one line.
 */
const describeCoverage = ({ parts, names }: { parts: readonly BridgeValuationPart[]; names: ReadonlyMap<string, string> }): string => {
  const nameOf = (part: BridgeValuationPart) => names.get(part.accountId) ?? part.accountId;
  const statement = parts.filter((part) => part.source === 'broker');
  const records = parts.filter((part) => part.source === 'rows');
  const opened = findEarliest(statement);
  const recorded = findEarliest(records);
  return keepTogether(
    [
      statement.length === 0
        ? null
        : `${statement.map(nameOf).join(', ')} — за звітом брокера${opened === undefined ? '' : `, з першого внеску ${formatDay(opened)}`}`,
      records.length === 0
        ? null
        : `${records.map(nameOf).join(', ')} — лише записи «переоцінка»${recorded === undefined ? '' : ` з ${formatDay(recorded)}`}; їхні раніші зміни — в оцінці капіталу на початок`,
    ]
      .filter((line) => line !== null)
      .join('; '),
  );
};

const BridgeBlock = ({ bridge, period, names }: { bridge: NetWorthBridge; period: ResolvedPeriod; names: ReadonlyMap<string, string> }) => {
  const {
    startEur,
    endEur,
    savingsEur,
    earnedEur,
    spentEur,
    valuationsEur,
    valuationParts,
    fxEur,
    fxParts,
    otherEur,
    otherParts,
    creditDebtChangeEur,
    from,
    to,
  } = bridge;
  const max = Math.max(1, ...[savingsEur, valuationsEur, fxEur, otherEur].map((value) => Math.abs(value)));
  const range = { from: period.from, to: period.to };
  const fromStatement = new Set(valuationParts.filter((part) => part.source === 'broker').map((part) => part.accountId));
  const coverage = describeCoverage({ parts: valuationParts, names });
  return (
    <div className="card bridge">
      <div className="t" style={{ fontWeight: 600 }}>
        Чому змінився капітал: {formatDay(from)} → {formatDay(to)}
        <InfoTip label="розклад зміни капіталу">
          <p>Заощадження — дохід мінус витрати, як у місячній аналітиці.</p>
          <p>
            Переоцінки — ринкові зміни. Де звіт брокера знає вартість на обидва кінці періоду (щоденна вартість IBKR, звіт
            Freedom24 від першого внеску), зміна береться зі звіту: вартість мінус внески, які він показує. Де не знає — лише записи
            «переоцінка» трекера.
          </p>
          <p>
            Минуле брокерського рахунку трекер відновлює назад від відкриття. Якщо звіт знає вартість на той день, береться вона, а
            внески, яких трекер не має як переказів, стоять окремим рядком в «Іншому».
          </p>
          <p>Курси — ті самі баланси на початок періоду, перераховані за курсом кінця. Інше розкладено нижче, рядок за рядком.</p>
          <p>Натисни на назву рядка, щоб побачити записи за ним.</p>
        </InfoTip>
      </div>
      <div className="list">
        <div className="row">
          <span>На {formatDay(from)}</span>
          <span className="r num">{formatEur(startEur)}</span>
        </div>
        <div className="row">
          <span>Заощадження</span>
          <span className={`r num ${savingsEur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(savingsEur)}</span>
          <span className="s">
            <a href={buildTableHref({ type: 'income', ...range })}>дохід {formatEur(earnedEur)}</a> −{' '}
            <a href={buildTableHref({ type: 'expense', ...range })}>витрати {formatEur(spentEur)}</a>
          </span>
          <StepBar value={savingsEur} max={max} />
        </div>
        <details className="row bridge-fold">
          <summary>
            <span>Переоцінки інвестицій</span>
            <span className={`r num ${valuationsEur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(valuationsEur)}</span>
            {coverage !== '' && <span className="s">{coverage}</span>}
            <StepBar value={valuationsEur} max={max} />
          </summary>
          <ul className="bridge-parts">
            {valuationParts.map((part) => (
              <li key={part.accountId}>
                <span>
                  {keepTogether(names.get(part.accountId) ?? part.accountId)}
                  <span className="small muted"> · {describeValuationPart(part)}</span>
                </span>
                <span className={`num ${part.eur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(part.eur)}</span>
              </li>
            ))}
            {valuationParts.length === 0 && <li className="muted">Ринкових змін за період не записано.</li>}
            <li>
              <RowsLink href={buildTableHref({ type: 'valuation', ...range })}>Усі записи «переоцінка» за період</RowsLink>
            </li>
          </ul>
        </details>
        <details className="row bridge-fold">
          <summary>
            <span>Курси валют</span>
            <span className={`r num ${fxEur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(fxEur)}</span>
            <StepBar value={fxEur} max={max} />
          </summary>
          <ul className="bridge-parts">
            {fxParts.map((part) => (
              <li key={part.currency}>
                <span>
                  {formatMoneyWhole(part.balance, part.currency)} на {formatDay(from)}
                  <span className="small muted"> · курс {formatCurrencySign(part.currency)} до € змінився</span>
                </span>
                <span className={`num ${part.eur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(part.eur)}</span>
              </li>
            ))}
            {fxParts.length === 0 && <li className="muted">Курси майже не рухались.</li>}
          </ul>
        </details>
        <details className="row bridge-fold">
          <summary>
            <span>Інше</span>
            <span className={`r num ${otherEur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(otherEur)}</span>
            <StepBar value={otherEur} max={max} />
          </summary>
          <ul className="bridge-parts">
            {otherParts.map((part) => {
              const { label, note } = describeOtherPart({ part, range, names, fromStatement });
              return (
                <li key={`${part.kind}:${part.category ?? ''}:${part.accountId ?? ''}`}>
                  <span>
                    {label}
                    <span className="small muted"> · {note}</span>
                  </span>
                  <span className={`num ${part.eur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(part.eur)}</span>
                </li>
              );
            })}
            {otherParts.length === 0 && <li className="muted">Нічого суттєвого.</li>}
          </ul>
        </details>
        <div className="row">
          <span>
            <b>На {formatDay(to)}</b>
          </span>
          <span className="r num">
            <b>{formatEur(endEur)}</b>
          </span>
          <span className="s">
            разом {formatSignedEur(endEur - startEur)}; борг на кредитці змінився на {formatSignedEur(creditDebtChangeEur)} (уже в цих рядках)
          </span>
        </div>
      </div>
    </div>
  );
};

/** Net worth over the page period, and why it moved from its first month to its last. */
export const NetWorthSection = ({ period }: { period: ResolvedPeriod }) => {
  const worth = useNetWorth();
  // History is served back from the running month, so a period ending earlier asks for the months after it too.
  const history = useNetWorthHistory(Math.min(MAX_HISTORY_MONTHS, countMonths(period.from, findCurrentMonth())));
  const bridge = useNetWorthBridge({ from: period.from, month: period.to });
  const accounts = useAccounts();
  const names = new Map((accounts.data ?? []).map((account) => [account.id, formatAccountName(account.name)]));
  const points = (history.data?.points ?? []).filter((point) => point.month >= period.from && point.month <= period.to);

  return (
    <section>
      <SectionHead
        title={`Чистий капітал · ${period.label}`}
        info={
          <>
            <p>Сума балансів усіх рахунків у євро за курсом на кінець кожного місяця.</p>
            <p>
              Минулі баланси відновлено з історії записів назад від початкових балансів; архівні рахунки (стара готівка,
              Dukascopy, Crypto) теж враховані. Кредитка — мінус, але це свідомий борг у гривні.
            </p>
            <p>
              Брокерський рахунок до його відкриття в трекері береться зі звіту брокера, де той знає вартість (щоденна вартість
              IBKR): відновлення назад не бачить внесків, записаних як витрати «Інвестиції», і рахувало б ті самі гроші двічі.
            </p>
            <p>Бліді смугасті стовпці — місяці з неповними даними: там капітал лише оцінка. Темна риска — разом.</p>
          </>
        }
      />
      {worth.isError && <p className="note err">{describeError(worth.error)}</p>}
      {worth.data !== undefined && (
        <div className="tiles even-tiles">
          <Tile label="Разом зараз" value={worth.data.totalEur} main />
          {BUCKETS.filter((bucket) => bucket.key !== 'iOweEur' || worth.data[bucket.key] !== 0).map((bucket) => (
            <Tile key={bucket.key} label={bucket.label} value={worth.data[bucket.key]} href={buildHref({ view: bucket.view })} />
          ))}
        </div>
      )}
      {history.isError && <p className="note err">{describeError(history.error)}</p>}
      {points.length > 0 && (
        <>
          <div className="legend" style={{ marginTop: 12 }}>
            {BUCKETS.map((bucket) => (
              <span key={bucket.key}>
                <i style={{ background: bucket.color }} />
                {bucket.label}
              </span>
            ))}
            <span>
              <i className="sw-sparse" />
              неповні дані: оцінка
            </span>
          </div>
          <ChartFigure
            summary={`Чистий капітал по місяцях: від ${formatEur(points[0]?.totalEur ?? 0)} на кінець ${formatMonthLong(points[0]?.month ?? period.from)} до ${formatEur(points.at(-1)?.totalEur ?? 0)} на кінець ${formatMonthLong(points.at(-1)?.month ?? period.to)}.`}
            table={{
              columns: ['Місяць', 'Разом', ...BUCKETS.map((bucket) => bucket.label)],
              rows: points.map((point) => ({
                key: point.month,
                cells: [
                  `${formatMonthShort(point.month)}${point.sparse ? ' ≈' : ''}`,
                  formatEur(point.totalEur),
                  ...BUCKETS.map((bucket) => formatEur(point[bucket.key])),
                ],
              })),
            }}
          >
            <StackedChart
              unit="€"
              months={points.map((point) => point.month)}
              series={BUCKETS.map((bucket) => ({ ...bucket, values: points.map((point) => point[bucket.key]) }))}
              totals={points.map((point) => point.totalEur)}
              sparse={points.map((point) => point.sparse)}
              tooltips={points.map((point) => (
                <span key={point.month}>
                  <b>{formatMonthLong(point.month)}</b>
                  <br />
                  Разом: <span className="num">{formatEur(point.totalEur)}</span>
                  {BUCKETS.filter((bucket) => point[bucket.key] !== 0).map((bucket) => (
                    <span key={bucket.key}>
                      <br />
                      {bucket.label}: <span className="num">{formatEur(point[bucket.key])}</span>
                    </span>
                  ))}
                  {point.sparse && (
                    <>
                      <br />
                      <span className="note">Неповні дані: оцінка</span>
                    </>
                  )}
                </span>
              ))}
            />
          </ChartFigure>
        </>
      )}
      {bridge.isError && <p className="note err">{describeError(bridge.error)}</p>}
      {bridge.data !== undefined && <BridgeBlock bridge={bridge.data} period={period} names={names} />}
    </section>
  );
};
