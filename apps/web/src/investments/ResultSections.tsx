import type { Investments, PeriodReturn, ResidualCause, ReturnPeriod } from '@hroshi/schema';
import type { ReactNode } from 'react';

import { InfoTip } from '../components/InfoTip.tsx';
import { Nothing } from '../components/Nothing.tsx';
import { formatDay, formatSignedEur, formatSignedPercentPrecise } from '../format.ts';
import { buildTableHref } from '../route.ts';
import { formatDayRange } from './shared.ts';

type Names = ReadonlyMap<string, string>;

/** Below half a euro a term rounds to «0 €» and only adds a line. */
const isVisible = (value: number) => Math.abs(value) >= 0.5;

const findNextDay = (date: string) => new Date(Date.parse(`${date}T00:00:00Z`) + 86_400_000).toISOString().slice(0, 10);

/** Sections further down the same page; the router owns the hash, so they are reached by scrolling. */
export const scrollToSection = (id: string) => document.getElementById(id)?.scrollIntoView({ behavior: 'smooth', block: 'start' });

const JumpLink = ({ target, children }: { target: string; children: ReactNode }) => (
  <button type="button" className="inv-jump" onClick={() => scrollToSection(target)}>
    {children}
  </button>
);

/** The sign column follows the value, so a cost reads «−» and a gain «+» whatever the line is called. */
const Term = ({ label, period, value, link }: { label: ReactNode; period: string | null; value: number; link?: ReactNode }) => (
  <div className="inv-term">
    <span className="inv-sign" aria-hidden="true">
      {value < 0 ? '−' : '+'}
    </span>
    <span>
      {label}
      {period !== null && <span className="small muted"> · {period}</span>}
      {link !== undefined && <span className="small"> · {link}</span>}
    </span>
    <span className={`num ${value < 0 ? 'neg' : value > 0 ? 'pos' : 'muted'}`}>{formatSignedEur(value)}</span>
  </div>
);

const CAUSE_LABELS: Readonly<Record<ResidualCause, string>> = {
  trades: 'Trades (угоди й обмін валют)',
  'nav-change': 'Change in NAV (комісії й курсові різниці IBKR)',
};

/** Who the residual belongs to and which statement sections would explain it. */
const ResidualInfo = ({ data, names }: { data: Investments; names: Names }) => {
  const parts = data.breakdown.residual.filter((part) => isVisible(part.eur));
  return (
    <>
      <p>Те, що лишається після всіх рядків вище: результат брокера мінус розписане.</p>
      {parts.length === 0 && <p>Звіти пояснюють результат повністю, до копійок.</p>}
      {parts.map((part) => (
        <p key={part.accountId}>
          {names.get(part.accountId) ?? part.accountId}: <span className="num">{formatSignedEur(part.eur)}</span>
          {part.missing.length > 0
            ? ` — у Flex-запиті немає розділів ${part.missing.map((cause) => CAUSE_LABELS[cause]).join(' і ')}. Тут IBKR міняє євро поповнень на долари за своїм курсом і бере за це комісію; додай ці розділи в запит, і залишок розпишеться.`
            : ' — дрібні округлення курсів.'}
        </p>
      ))}
    </>
  );
};

/**
 * The three results the page shows, in one sum: what the positions gained over the broker's
 * cost, plus income and costs the statements book, makes the brokers' result; the tracker's own
 * figure only starts at its opening dates.
 */
export const ResultBreakdown = ({ data, names }: { data: Investments; names: Names }) => {
  const { breakdown } = data;
  const brokers = data.accounts.filter((holding) => holding.broker !== null);
  const withoutTrades = brokers
    .filter((holding) => holding.report !== null && holding.report.broker === 'ibkr')
    .map((holding) => names.get(holding.account.id) ?? holding.account.id);
  const brokerPeriod = breakdown.brokerFrom === null ? null : `з ${formatDay(breakdown.brokerFrom)}`;
  const opening =
    breakdown.openingFrom === null || breakdown.openingTo === null ? null : formatDayRange(breakdown.openingFrom, breakdown.openingTo);

  return (
    <details className="inv-breakdown" open>
      <summary>
        Як складається результат брокерів{' '}
        <span className={`num ${breakdown.brokerGainEur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(breakdown.brokerGainEur)}</span>
        <InfoTip label="як складається результат">
          <p>Усе в євро за сьогоднішнім курсом, тож рух долара проти євро сюди не входить — він у «Дохідності».</p>
          <p>Кожен рядок узято зі звітів брокерів: позиції — з ціни купівлі, дивіденди, податки й комісії — з грошових записів і журналу угод.</p>
        </InfoTip>
      </summary>
      <div className="inv-terms">
        <Term
          label="Позиції: вартість зараз − собівартість"
          period="з купівлі"
          value={breakdown.positionsGainEur}
          link={<JumpLink target="inv-positions">позиції</JumpLink>}
        />
        {breakdown.realizedEur !== null && isVisible(breakdown.realizedEur) && (
          <Term
            label={withoutTrades.length > 0 ? `Продажі (крім ${withoutTrades.join(', ')}: угод у звіті немає)` : 'Продажі, FIFO'}
            period={brokerPeriod}
            value={breakdown.realizedEur}
          />
        )}
        <Term label="Дивіденди" period={brokerPeriod} value={breakdown.dividendsEur} link={<JumpLink target="inv-income">по роках</JumpLink>} />
        <Term label="Податок з дивідендів" period={brokerPeriod} value={breakdown.taxesEur} />
        {isVisible(breakdown.commissionsEur) && (
          <Term
            label={
              <>
                Комісії за угоди
                <InfoTip label="комісії за угоди">
                  <p>
                    З журналу угод: Freedom24 бере комісію окремо від ціни купівлі, тож її тут видно. В IBKR комісія входить у собівартість
                    позиції — вона вже в рядку «Позиції».
                  </p>
                </InfoTip>
              </>
            }
            period={brokerPeriod}
            value={breakdown.commissionsEur}
          />
        )}
        {isVisible(breakdown.feesEur) && (
          <Term
            label={
              <>
                Інші комісії брокера
                <InfoTip label="інші комісії">
                  <p>З грошових записів і переліку комісій: 2% за поповнення карткою у Freedom24, плата за вивід, рахунок.</p>
                </InfoTip>
              </>
            }
            period={brokerPeriod}
            value={breakdown.feesEur}
          />
        )}
        {isVisible(breakdown.interestEur) && <Term label="Відсотки на готівку" period={brokerPeriod} value={breakdown.interestEur} />}
        {isVisible(breakdown.fxEur) && (
          <Term
            label={
              <>
                Курс євро в доларовому рахунку
                <InfoTip label="курс у рахунку брокера">
                  <p>
                    Рахунки брокерів — у доларах, а частина грошей там у євро (поповнення в євро, акції в євро). Відколи ці євро зайшли, курс
                    змінився: на собівартості позицій в євро це видно лише тут, бо рядок «Позиції» рахує їх у євро.
                  </p>
                  <p>Сюди ж — різниця між курсом, за яким брокер міняв валюту, і курсом НБУ того дня, і між курсом брокера й НБУ сьогодні.</p>
                </InfoTip>
              </>
            }
            period={brokerPeriod}
            value={breakdown.fxEur}
          />
        )}
        {isVisible(breakdown.otherEur) ? (
          <Term
            label={
              <>
                Нерозписаний залишок
                <InfoTip label="нерозписаний залишок">
                  <ResidualInfo data={data} names={names} />
                </InfoTip>
              </>
            }
            period={null}
            value={breakdown.otherEur}
          />
        ) : (
          <div className="inv-term">
            <span className="inv-sign" aria-hidden="true" />
            <span className="muted">Нерозписаного залишку немає</span>
            <Nothing why="Звіти пояснюють результат повністю" />
          </div>
        )}
        <div className="inv-term total">
          <span className="inv-sign" aria-hidden="true">
            =
          </span>
          <span>
            Результат за звітами брокерів
            {brokerPeriod !== null && <span className="small muted"> · {brokerPeriod}</span>}
          </span>
          <span className={`num ${breakdown.brokerGainEur < 0 ? 'neg' : 'pos'}`}>{formatSignedEur(breakdown.brokerGainEur)}</span>
        </div>
      </div>
      {opening !== null && breakdown.openingFrom !== null && (
        <p className="note">
          Окремо, «за час у трекері» ({opening}): {formatSignedEur(data.sinceOpeningGainEur)} — переоцінки за ці дні по всіх
          рахунках, не результат з першої покупки.{' '}
          <a href={buildTableHref({ type: 'valuation', from: breakdown.openingFrom })}>Записи переоцінок →</a>
        </p>
      )}
    </details>
  );
};

const PERIOD_LABELS: Readonly<Record<ReturnPeriod, string>> = {
  ytd: 'З початку року',
  '12m': '12 міс.',
  all: 'З першого поповнення',
};

const ReturnCell = ({ value, estimated, why }: { value: number | null; estimated: boolean; why: string }) =>
  value === null ? <Nothing why={why} /> : <>{`${estimated ? '≈\u00a0' : ''}${formatSignedPercentPrecise(value)}`}</>;

const describeMissing = (entry: PeriodReturn, firstDeposit: string | null) => {
  switch (entry.missing) {
    case 'short-history':
      return `поповнення почались ${firstDeposit === null ? 'пізніше' : formatDay(firstDeposit)}`;
    case 'no-prices':
      return 'цін VWCE за цей період немає';
    case null:
      return null;
  }
};

/**
 * Returns over fixed spans for the portfolio and for the same deposits in VWCE, plus the yearly
 * money-weighted rate; the spans are not annualised, so a year to date reads as it is.
 */
export const PeriodReturns = ({ data, names }: { data: Investments; names: Names }) => {
  const { periodReturns, benchmark, returns, history } = data;
  if (periodReturns.length === 0) return null;
  const firstDeposit = data.breakdown.brokerFrom;
  const start = firstDeposit === null ? null : formatDay(firstDeposit);
  const modelled = history.modelled.map((entry) => names.get(entry.accountId) ?? entry.accountId);
  const included = history.accountIds.map((id) => names.get(id) ?? id).join(' + ');

  return (
    <div className="inv-returns">
      <div className="small muted inv-returns-head">
        Дохідність {included} у €, проти тих самих внесків у {benchmark?.symbol ?? 'VWCE'}
        <InfoTip label="дохідність за періодами">
          <p>
            За період: прибуток ÷ гроші в роботі, кожне поповнення зважене часткою періоду, яку воно пропрацювало (метод Модифікованого
            Дітца). Не річна: «з початку року» — це саме з 1 січня.
          </p>
          <p>
            VWCE — фонд Vanguard FTSE All-World на Xetra, у євро. Кожне поповнення ніби купує його за ціною закриття того дня, кожен вивід —
            продає. Тож різниця — лише від вибору, у що вкладати.
          </p>
          {modelled.length > 0 && (
            <p>
              ≈ — вартість {modelled.join(', ')} на початок періоду оцінена: брокер дає її лише на дату звіту, раніше вона наростає за річною
              дохідністю рахунку.
            </p>
          )}
        </InfoTip>
      </div>
      <div className="tbl inv-returns-table">
        <table>
          <thead>
            <tr>
              <th>Період</th>
              <th className="r">Портфель</th>
              <th className="r">{benchmark?.symbol ?? 'VWCE'}</th>
            </tr>
          </thead>
          <tbody>
            {periodReturns.map((entry) => {
              const missing = describeMissing(entry, firstDeposit);
              return (
                <tr key={entry.period}>
                  <td>
                    {PERIOD_LABELS[entry.period]}
                    <span className="small muted block">
                      {entry.period === 'all' && start !== null ? `з ${start}` : `з ${formatDay(findNextDay(entry.from))}`}
                      {missing !== null && ` · ${missing}`}
                    </span>
                  </td>
                  <td className="r num">
                    <ReturnCell value={entry.portfolio} estimated={entry.estimated} why={missing ?? 'немає вартості на початок періоду'} />
                  </td>
                  <td className="r num">
                    <ReturnCell value={entry.benchmark} estimated={false} why={missing ?? 'немає цін фонду за цей період'} />
                  </td>
                </tr>
              );
            })}
            <tr>
              <td>
                Річна, XIRR
                <span className="small muted block">грошово-зважена, з {start ?? '—'}</span>
              </td>
              <td className="r num">
                <ReturnCell value={returns.eur} estimated={false} why="поповнення й вартість не дають ставки" />
              </td>
              <td className="r num">
                <ReturnCell value={benchmark?.xirr ?? null} estimated={false} why="немає цін фонду" />
              </td>
            </tr>
          </tbody>
        </table>
      </div>
    </div>
  );
};
