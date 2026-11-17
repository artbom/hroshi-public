import type { IsoDate, Month, MonthComparison, MonthOverview } from '@hroshi/schema';
import type { ReactNode } from 'react';

import { useAdd } from '../components/AddContext.tsx';
import { AmountBar } from '../components/AmountBar.tsx';
import { InfoTip, SectionHead } from '../components/InfoTip.tsx';
import { LimitBar, NEAR_LIMIT_SHARE } from '../components/LimitBar.tsx';
import { findToday } from '../months.ts';
import {
  formatBaseline,
  formatDay,
  formatDecimal,
  formatEur,
  formatMoney,
  formatMonthLong,
  formatPercent,
  formatSignedEur,
  formatSignedPercent,
  formatWhole,
  keepTogether,
  pluralize,
} from '../format.ts';
import { useCategories } from '../queries.ts';
import { buildTableHref } from '../route.ts';
import { findRefundCategory } from '../trends/rollup.ts';
import { TileLabel } from '../trends/TileLabel.tsx';
import { roundToTotal } from '../trends/sums.ts';

/** A change smaller than this is noise, not a trend. */
const NOTABLE_CHANGE_EUR = 5;

/** Months the usual level is the average of: the complete ones among the six before. */
const countUsedMonths = (comparison: MonthComparison) => comparison.averageMonths.filter((entry) => entry.used).length;

const describeAverageMonths = (comparison: MonthComparison) => {
  const used = comparison.averageMonths.filter((entry) => entry.used).map((entry) => formatMonthLong(entry.month));
  const left = comparison.averageMonths.filter((entry) => !entry.used);
  const reasons = { sparse: 'мало записів', noIncome: 'немає доходів', partial: 'ще триває', used: '' } as const;
  return (
    <>
      <p>
        «Звично» ({formatBaseline(countUsedMonths(comparison))}) — середнє за повні місяці серед{' '}
        {pluralize(comparison.averageMonths.length, ['попереднього', 'попередніх', 'попередніх'])}.
      </p>
      <p>Враховано: {used.length === 0 ? 'жодного' : used.join(', ')}.</p>
      {left.length > 0 && (
        <p>
          Пропущено:{' '}
          {left.map((entry) => `${formatMonthLong(entry.month)} (${reasons[entry.reason]})`).join(', ')}.
        </p>
      )}
    </>
  );
};

/** Jumps to a block further down Огляд; a hash anchor would change the route instead. */
const ScrollLink = ({ target, children }: { target: string; children: ReactNode }) => (
  <button type="button" className="link-button" onClick={() => document.getElementById(target)?.scrollIntoView({ behavior: 'smooth', block: 'start' })}>
    {children}
  </button>
);

/** The blocks of Огляд the tiles point at. */
const FORECAST_ID = 'forecast';
const EXPECTED_ID = 'expected';

const SummaryTile = ({
  label,
  value,
  href,
  info,
  tone = '',
  children,
}: {
  label: string;
  value: string;
  /** The rows behind the figure. */
  href: string;
  info: ReactNode;
  tone?: '' | 'neg' | 'pos';
  /** Small print under the number: what is recorded so far, what is still expected, the usual level. */
  children?: ReactNode;
}) => (
  <div className="tile">
    <TileLabel label={label} info={<InfoTip label={label}>{info}</InfoTip>} />
    <a className={`v num tile-value ${tone}`.trim()} href={href}>
      {value}
    </a>
    {children}
  </div>
);

const formatSavingRate = (saved: number, income: number) => (income > 0 ? formatPercent(saved / income) : '—');

/**
 * The month in one currency, against its usual level. While the month runs, a half-booked month
 * would read as a saving (rent is paid in cash and booked late), so the tiles lead with the forecast
 * and keep what is recorded so far as small print. Every figure links to the rows behind it.
 */
export const MonthSummary = ({ comparison }: { comparison: MonthComparison }) => {
  const { current, average, daysElapsed, daysInMonth, projection, month } = comparison;
  const saved = current.incomeEur - current.spendEur;
  const usualSaved = average.incomeEur - average.spendEur;
  const usedMonths = countUsedMonths(comparison);
  const usual = (text: string) =>
    usedMonths === 0 ? null : (
      <span className="small muted">
        звично {text} · {formatBaseline(usedMonths)}
      </span>
    );
  const averageInfo = describeAverageMonths(comparison);
  const expensesHref = buildTableHref({ type: 'expense', from: month, to: month });
  const incomeHref = buildTableHref({ type: 'income', from: month, to: month });
  const monthHref = buildTableHref({ from: month, to: month });
  const projectionInfo = (
    <p>
      Прогноз на кінець місяця = записано + очікується (регулярні платежі, яких цього місяця ще немає в записах) + щоденні витрати в
      тому ж темпі на решту днів. Розклад — у блоці «Прогноз на кінець місяця».
    </p>
  );
  const spendInfo = (
    <p>
      Усі витрати мінус повернення в їхніх категоріях. Перекази між своїми рахунками, P2P, інвестиції й переоцінки не рахуються.
      Натисни суму — побачиш записи.
    </p>
  );
  const incomeInfo = (
    <p>
      Лише категорії «Зарплата/клієнт», «Підробіток», «Продаж речей»; дохід «Інше» (часто свої перекази) не рахується, тож у списку
      надходжень за місяць рядків більше. Дохід не прогнозується: лише те, що вже прийшло.
    </p>
  );
  return (
    <section>
      <SectionHead
        title={projection === null ? `${formatMonthLong(month)} у євро` : `${formatMonthLong(month)} у євро · прогноз на кінець місяця`}
        info={
          <>
            <p>Усе перераховано в євро за курсом НБУ на день операції.</p>
            {projection !== null && projectionInfo}
            {averageInfo}
          </>
        }
      />
      {projection === null ? (
        <div className="tiles">
          <SummaryTile
            label="Витрати"
            value={formatEur(current.spendEur)}
            href={expensesHref}
            info={
              <>
                {spendInfo}
                {averageInfo}
              </>
            }
          >
            {usual(formatEur(average.spendEur))}
          </SummaryTile>
          <SummaryTile label="Дохід" value={formatEur(current.incomeEur)} href={incomeHref} info={incomeInfo} tone="pos">
            {usual(formatEur(average.incomeEur))}
          </SummaryTile>
          <SummaryTile label="Відкладено" value={formatSignedEur(saved)} href={monthHref} info={<p>Дохід мінус витрати за місяць.</p>}>
            {usual(formatSignedEur(usualSaved))}
          </SummaryTile>
          <SummaryTile
            label="Норма заощаджень"
            value={formatSavingRate(saved, current.incomeEur)}
            href={monthHref}
            info={<p>Відкладено ÷ дохід.</p>}
          >
            {average.incomeEur > 0 && usual(formatSavingRate(usualSaved, average.incomeEur))}
          </SummaryTile>
        </div>
      ) : (
        <div className="tiles">
          <SummaryTile
            label="Витрати, прогноз"
            value={`≈ ${formatEur(projection.spendEur)}`}
            href={expensesHref}
            info={
              <>
                {projectionInfo}
                {spendInfo}
                {averageInfo}
              </>
            }
          >
            <span className="small muted">
              <a href={expensesHref}>записано {formatEur(current.spendEur)}</a>
              {projection.expectedEur >= 0.5 && (
                <>
                  {' · '}
                  <ScrollLink target={EXPECTED_ID}>очікується {formatEur(projection.expectedEur)}</ScrollLink>
                </>
              )}
            </span>
            {usual(formatEur(average.spendEur))}
          </SummaryTile>
          <SummaryTile label="Дохід, записано" value={formatEur(current.incomeEur)} href={incomeHref} info={incomeInfo} tone="pos">
            <span className="small muted">без прогнозу — лише те, що прийшло</span>
            {usual(formatEur(average.incomeEur))}
          </SummaryTile>
          <SummaryTile
            label="Відкладено, прогноз"
            value={`≈ ${formatSignedEur(projection.savedEur)}`}
            href={monthHref}
            info={
              <>
                <p>Дохід, що вже прийшов, мінус прогноз витрат на кінець місяця.</p>
                {projectionInfo}
              </>
            }
            tone={projection.savedEur < 0 ? 'neg' : ''}
          >
            <span className="small muted">
              <a href={monthHref}>записано {formatSignedEur(saved)}</a>
            </span>
            {usual(formatSignedEur(usualSaved))}
          </SummaryTile>
          <SummaryTile
            label="Норма заощаджень, прогноз"
            value={`≈ ${formatSavingRate(projection.savedEur, current.incomeEur)}`}
            href={monthHref}
            info={<p>Відкладено ÷ дохід, за прогнозом на кінець місяця.</p>}
          >
            <span className="small muted">записано {formatSavingRate(saved, current.incomeEur)}</span>
            {average.incomeEur > 0 && usual(formatSavingRate(usualSaved, average.incomeEur))}
          </SummaryTile>
        </div>
      )}
      {daysElapsed > 0 && daysElapsed < daysInMonth && projection === null && (
        <p className="note" style={{ marginTop: 8 }}>
          Місяць триває: день {daysElapsed} із {daysInMonth}, тож суми ще ростимуть. «Звично» — за повні місяці.
        </p>
      )}
    </section>
  );
};

const DAY_MS = 86_400_000;

const countDaysLate = ({ due, today }: { due: IsoDate; today: IsoDate }) =>
  Math.round((Date.parse(`${today}T00:00:00Z`) - Date.parse(`${due}T00:00:00Z`)) / DAY_MS);

/** What the running month's forecast is made of, and the payments it still waits for, overdue ones first. */
export const ForecastSection = ({ comparison }: { comparison: MonthComparison }) => {
  const { projection, current, daysElapsed, daysInMonth, month } = comparison;
  const { openAdd } = useAdd();
  if (projection === null) return null;
  const today = findToday();
  const expected = projection.expected
    .map((payment) => ({ payment, late: countDaysLate({ due: payment.nextDate, today }) }))
    .toSorted((left, right) => right.late - left.late);
  return (
    <section id={FORECAST_ID} className="scroll-target">
      <SectionHead
        title="Прогноз на кінець місяця"
        info={
          <>
            <p>Прогноз = записано + очікується (регулярні платежі, яких цього місяця ще немає в записах) + щоденні витрати в тому ж темпі на решту днів.</p>
            <p>Регулярні — ті, що повторювалися щомісяця за останні пів року; їх видно й можна змінити в «Аналітиці» → «Платежі». Дохід — лише те, що вже прийшло.</p>
          </>
        }
      >
        <span className="small muted">
          день {daysElapsed} із {daysInMonth}
        </span>
      </SectionHead>
      <div className="forecast">
        <div className="forecast-sum num">
          <span>
            прогноз витрат ≈ <b>{formatEur(projection.spendEur)}</b>
          </span>
          <span className="muted small">
            = <a href={buildTableHref({ type: 'expense', from: month, to: month })}>{formatEur(current.spendEur)} записано</a> +{' '}
            {formatEur(projection.expectedEur)} очікується + {formatEur(projection.paceEur)} у тому ж темпі
          </span>
        </div>
        {expected.length > 0 && (
          <div id={EXPECTED_ID} className="scroll-target">
            <div className="small muted">Очікується, ще не записано:</div>
            <div className="expected-list">
              {expected.map(({ payment, late }) => (
                <div key={payment.key} className="expected-row">
                  <div className="what">
                    <a className="plain" href={buildTableHref({ payee: payment.key })}>
                      {payment.name} <span className="muted small">· {payment.category}</span>
                    </a>
                    {late > 0 ? (
                      <div className="small warn-text">
                        прострочено {pluralize(late, ['день', 'дні', 'днів'])} · мав бути ~{formatDay(payment.nextDate)}
                      </div>
                    ) : (
                      <div className="small muted">очікується ~{formatDay(payment.nextDate)}</div>
                    )}
                  </div>
                  <div className="side">
                    <span className="num amt">{formatMoney(payment.amount, payment.currency)}</span>
                    <button
                      type="button"
                      className="btn small expected-add"
                      aria-label={`Записати: ${payment.name}, ${formatMoney(payment.amount, payment.currency)}`}
                      onClick={() =>
                        openAdd({
                          type: 'expense',
                          accountId: payment.accountId,
                          amount: formatDecimal(payment.amount, 2),
                          category: payment.category,
                          note: payment.name,
                        })
                      }
                    >
                      <span className="expected-add-icon" aria-hidden="true">
                        +
                      </span>
                      <span className="expected-add-text">Записати</span>
                    </button>
                  </div>
                </div>
              ))}
            </div>
          </div>
        )}
      </div>
    </section>
  );
};

export const CategoryComparison = ({
  comparison,
  overview,
}: {
  comparison: MonthComparison;
  overview: MonthOverview | undefined;
}) => {
  const { current, average, month, daysElapsed, daysInMonth, projection } = comparison;
  const refundCategory = findRefundCategory(useCategories().data);
  const finished = daysElapsed >= daysInMonth;
  const expectedByCategory = projection?.expectedByCategory ?? {};
  const all = [...new Set([...Object.keys(current.categories), ...Object.keys(average.categories), ...Object.keys(expectedByCategory)])].map(
    (category) => ({
      key: category,
      category,
      href: buildTableHref({ category, from: month, to: month }),
      now: current.categories[category] ?? 0,
      expected: expectedByCategory[category] ?? 0,
      usual: average.categories[category] ?? 0,
    }),
  );
  // Refunds booked to no category come off the month's total, so they are a row of their own and the rows add up to it.
  const refund = {
    key: 'refund:',
    category: refundCategory,
    href: buildTableHref({ type: 'income', category: refundCategory, from: month, to: month }),
    now: -current.refundEur,
    expected: 0,
    usual: -average.refundEur,
  };
  const names = [...all, refund]
    .filter((entry) => Math.abs(entry.now) >= 0.5 || entry.expected >= 0.5 || Math.abs(entry.usual) >= 0.5)
    .toSorted((left, right) => right.now + right.expected - left.now - left.expected || right.usual - left.usual);
  const max = Math.max(1, ...names.flatMap((entry) => [entry.now + entry.expected, entry.usual]));
  // Categories with nothing spent and nothing due only say «usually X»; they fold away below the ones that moved.
  const spent = names.filter((entry) => Math.abs(entry.now) >= 0.5 || entry.expected >= 0.5);
  const quiet = names.filter((entry) => Math.abs(entry.now) < 0.5 && entry.expected < 0.5);
  const usedMonths = countUsedMonths(comparison);
  // Whole euros rounded together with everything left out, so the rows give «записано» to the euro.
  const shownKeys = new Set(spent.map((entry) => entry.key));
  const leftOver = [...all, refund].filter((entry) => !shownKeys.has(entry.key)).reduce((sum, entry) => sum + entry.now, 0);
  const roundedNow = roundToTotal([...spent.map((entry) => entry.now), leftOver]);
  const recorded = roundedNow.reduce((sum, value) => sum + value, 0);
  const smallRest = roundedNow.at(-1) ?? 0;

  return (
    <section>
      <SectionHead
        title="Категорії проти звичного"
        info={
          <>
            <p>
              Смуга — витрати категорії за місяць у євро, мінус повернення. Риска — звичний рівень ({formatBaseline(usedMonths)}).
            </p>
            {projection !== null && (
              <p>
                Заштрихована частина — регулярний платіж, якого цього місяця ще немає в записах (оренда готівкою, комуналка), щоб
                незаписаний платіж не виглядав як економія.
              </p>
            )}
            <p>
              «{refundCategory}» — повернення, не віднесені до жодної категорії; вони зменшують підсумок, тож рядки разом дають
              «Разом записано», ту саму суму, що й плитка «Витрати». Суми округлено так, щоб рядки давали підсумок.
            </p>
            {describeAverageMonths(comparison)}
            <p>Натисни на категорію, щоб побачити її записи.</p>
          </>
        }
      />
      {names.length === 0 ? (
        <div className="empty">За {formatMonthLong(month)} витрат немає.</div>
      ) : (
        <div className="list">
          {spent.map(({ key, category, href, now, expected, usual }, index) => {
            const change = now - usual;
            const showChange = finished && Math.abs(change) >= NOTABLE_CHANGE_EUR;
            const label = [
              `${category}: ${formatEur(now)}`,
              expected >= 0.5 ? `ще очікується ${formatEur(expected)}` : null,
              `звично ${formatEur(usual)}`,
            ]
              .filter((part) => part !== null)
              .join(', ');
            return (
              <a key={key} className="cmp" href={href} aria-label={label}>
                <span className="name" title={category}>
                  {keepTogether(category)}
                </span>
                <span className="bar split" aria-hidden="true">
                  {now > 0 && <i style={{ width: `${Math.max(2, (now / max) * 100)}%` }} />}
                  {expected >= 0.5 && <i className="exp" style={{ width: `${(expected / max) * 100}%` }} />}
                  {usual > 0 && <span className="avg" style={{ left: `${(usual / max) * 100}%` }} />}
                </span>
                <span className={now < 0 ? 'num pos' : 'num'}>{formatEur(roundedNow[index] ?? now)}</span>
                <span className={`delta num ${showChange ? (change > 0 ? 'up' : 'down') : expected >= 0.5 ? 'due' : 'muted'}`}>
                  {showChange
                    ? `${change > 0 ? '▲' : '▼'} ${formatEur(Math.abs(change))}${usual > 0 ? ` ${formatSignedPercent(change / usual)}` : ''}`
                    : expected >= 0.5
                      ? `+${formatEur(expected)} очікується`
                      : `звично ${formatEur(usual)}`}
                </span>
              </a>
            );
          })}
          <a className="cmp cmp-total" href={buildTableHref({ type: 'expense', from: month, to: month })}>
            <span className="name">Разом записано</span>
            <span aria-hidden="true" />
            <span className="num">
              <b>{formatEur(recorded)}</b>
            </span>
            <span className="delta num muted">
              {smallRest !== 0 && `з них дрібні ${formatEur(smallRest)}`}
              {smallRest !== 0 && projection !== null && projection.expectedEur >= 0.5 && ' · '}
              {projection !== null && projection.expectedEur >= 0.5 && `+${formatEur(projection.expectedEur)} очікується`}
            </span>
          </a>
        </div>
      )}
      {quiet.length > 0 && (
        <details className="fold" style={{ marginTop: 8 }}>
          <summary>
            Ще {pluralize(quiet.length, ['категорія', 'категорії', 'категорій'])} без витрат (звично разом {formatEur(quiet.reduce((sum, entry) => sum + entry.usual, 0))})
          </summary>
          <p className="note">{quiet.map((entry) => `${entry.category} — звично ${formatEur(entry.usual)}`).join(' · ')}</p>
        </details>
      )}
      {overview !== undefined && overview.byCurrency.length > 0 && (
        <details className="fold" style={{ marginTop: 8 }}>
          <summary>У валютах рахунків</summary>
          <OriginalCurrencies overview={overview} />
        </details>
      )}
    </section>
  );
};

const CURRENCY_NAMES: ReadonlyMap<string, string> = new Map([
  ['UAH', 'У гривні'],
  ['EUR', 'В євро'],
  ['USD', 'У доларах'],
  ['GBP', 'У фунтах'],
  ['USDT', 'В USDT'],
]);

const OriginalCurrencies = ({ overview }: { overview: MonthOverview }) => (
  <div className="cats">
    {overview.byCurrency.map(({ currency, spent, income, categories }) => {
      const max = Math.max(0, ...categories.map((entry) => entry.amount));
      return (
        <div key={currency} className="cats">
          <div className="cur-head">
            <span>
              {CURRENCY_NAMES.get(currency) ?? currency}: витрачено <span className="num neg">{formatMoney(spent, currency)}</span>
            </span>
            {income > 0 && (
              <span>
                дохід <span className="num pos">{formatMoney(income, currency)}</span>
              </span>
            )}
          </div>
          {categories.map((entry) => (
            <AmountBar
              key={entry.category}
              label={entry.category}
              value={entry.amount}
              max={max}
              display={formatMoney(entry.amount, currency)}
              valueClassName={entry.amount < 0 ? 'pos' : ''}
            />
          ))}
        </div>
      );
    })}
  </div>
);

/** Soft limits stay quiet until a category nears its limit or runs ahead of the month's pace. */
export const LimitsSection = ({ month, limits, comparison }: { month: Month; limits: MonthOverview['limits']; comparison: MonthComparison }) => {
  if (limits.length === 0) return null;
  const pace = Math.min(1, comparison.daysElapsed / comparison.daysInMonth);
  const loud = limits.filter(({ limitEur, spentEur }) => spentEur >= limitEur * NEAR_LIMIT_SHARE || (pace < 1 && spentEur > limitEur * pace));
  return (
    <section>
      <SectionHead
        title="Орієнтири"
        info={
          <p>
            Показуються лише категорії, де витрачено ≥ 90% орієнтиру або більше, ніж «належить» на сьогодні (риска — частка
            місяця, що минула). У євро, з урахуванням повернень.
          </p>
        }
      />
      {loud.length === 0 ? (
        <p className="note">Усі орієнтири в нормі ({pluralize(limits.length, ['орієнтир', 'орієнтири', 'орієнтирів'])}).</p>
      ) : (
        <div className="cats">
          {loud.map(({ category, limitEur, spentEur }) => {
            const share = spentEur / limitEur;
            return (
              <a key={category} className="cat link-row" href={buildTableHref({ category, from: month, to: month })}>
                <span>{category}</span>
                <LimitBar share={share} pace={pace} />
                <span className={share > 1 ? 'num neg' : 'num'}>
                  {formatWhole(spentEur)} / {formatEur(limitEur)}
                </span>
              </a>
            );
          })}
          <p className="note">Решта в нормі: {pluralize(limits.length - loud.length, ['орієнтир', 'орієнтири', 'орієнтирів'])}.</p>
        </div>
      )}
    </section>
  );
};
