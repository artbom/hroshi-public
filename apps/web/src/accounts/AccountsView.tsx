import type { AccountHistory } from '@hroshi/schema';
import { useEffect, useRef, useState } from 'react';


import { describeError } from '../api.ts';
import { ChartFigure } from '../components/ChartFigure.tsx';
import { InfoTip, SectionHead } from '../components/InfoTip.tsx';
import { AccountMark } from '../components/SourceMark.tsx';
import { describeDayValue, TimeChart } from '../components/TimeChart.tsx';
import { formatAccountName, formatCurrencySign, formatDay, formatEur, formatMoney, formatMonthLong, pluralize } from '../format.ts';
import { useAccountHistory, useAccounts, useInvestments, useSyncStatus } from '../queries.ts';
import { buildHref, useRoute } from '../route.ts';
import { AccountRecords } from './AccountRecords.tsx';
import { CheckedWord, formatBreakableMoney } from './AccountCard.tsx';
import { AccountGroups } from './AccountGroups.tsx';
import {
  describeCheckBasis,
  describeCheckMoment,
  describeCheckTarget,
  describeFreshness,
  describeTolerance,
  isAwaitingCheck,
  SOURCE_NAMES,
  SYNCED_HINT,
} from './checks.ts';
import { LoanCard } from './LoanCard.tsx';
import { LoanTerms } from './LoanTerms.tsx';

const KIND_LABELS = {
  everyday: 'щоденний',
  credit: 'кредитна картка',
  cash: 'готівка',
  investment: 'інвестиції',
  receivable: 'позика',
} as const;

const describeKind = (account: Pick<AccountHistory['account'], 'kind' | 'balance'>) =>
  account.kind === 'receivable' && account.balance < 0 ? 'борг' : KIND_LABELS[account.kind];

const HISTORY_RANGES = [12, 24, 60] as const;

/** The chart starts where the account has anything to show: its opening, or its first older row. */
const findChartStart = (history: AccountHistory) => {
  const { openingDate } = history.account;
  const first = history.firstRowDate;
  return (first !== null && first < openingDate ? first : openingDate).slice(0, 7);
};

const BalanceCheckBlock = ({ history }: { history: AccountHistory }) => {
  const { check, account } = history;
  if (check === null) {
    if (isAwaitingCheck(account)) {
      return (
        <p className="note">
          Звірки ще не було: синхронізація ще не повідомила баланс цього рахунку. Він з’явиться після наступного запуску.
        </p>
      );
    }
    if (account.kind === 'investment') {
      return (
        <p className="note">
          Звіряти нема з чим: брокер або гаманець не дає звіту, тож баланс — це{' '}
          {account.valuedAt === null
            ? `початковий баланс на ${formatDay(account.openingDate)}; оцінок ще не було`
            : `остання оцінка на ${formatDay(account.valuedAt)}`}
          .
        </p>
      );
    }
    return (
      <p className="note">
        Рахунок ведеться вручну: банк не з’єднаний, тож звіряти нема з чим. Останній запис:{' '}
        {account.lastRowDate === null ? 'ще немає' : formatDay(account.lastRowDate)}.
      </p>
    );
  }
  const tolerance = describeTolerance({ check, currency: account.currency });
  const reportDay = check.basis === 'broker' || check.basis === 'wallet' ? check.checkedAt.slice(0, 10) : null;
  return (
    <>
      <dl className="facts">
        <dt>{SOURCE_NAMES[check.source]}</dt>
        <dd className="num">{formatMoney(check.bankBalance, account.currency)}</dd>
        <dt>Трекер</dt>
        <dd className="num">{formatMoney(check.trackerBalance, account.currency)}</dd>
        <dt>Різниця</dt>
        <dd className={check.matches ? 'check-ok' : 'check-bad'}>
          {check.matches ? `✓ ${describeCheckTarget(check)}` : `Δ ${formatMoney(check.difference, account.currency)}`}
          {tolerance !== null && <span className="note"> {tolerance}</span>}
        </dd>
        <dt>
          <CheckedWord capital />
        </dt>
        <dd>
          {describeCheckMoment(check)} · {describeCheckBasis(check)}
        </dd>
      </dl>
      {reportDay !== null && account.valuedAt !== null && account.valuedAt !== reportDay && (
        <p className="note">
          Остання переоцінка записана {formatDay(account.valuedAt)}, а звіт — на {formatDay(reportDay)}.{' '}
          {check.matches
            ? 'На день звіту трекер уже показує ту саму вартість, тож окрема переоцінка не потрібна.'
            : 'Різницю на день звіту запише наступна переоцінка.'}
        </p>
      )}
    </>
  );
};

/** One sentence for a screen reader: where the balance started, where it is, its low and high. */
const describeHistory = ({ points, currency }: { points: AccountHistory['points']; currency: string }) => {
  const [first] = points;
  const last = points.at(-1);
  if (first === undefined || last === undefined) return 'Історії балансу ще немає.';
  const values = points.map((point) => point.balance);
  return `Баланс на кінець місяця з ${formatMonthLong(first.month)} по ${formatMonthLong(last.month)}: від ${formatMoney(first.balance, currency)} до ${formatMoney(last.balance, currency)}; найменший ${formatMoney(Math.min(...values), currency)}, найбільший ${formatMoney(Math.max(...values), currency)}.`;
};

const AccountPage = ({ id }: { id: string }) => {
  const [months, setMonths] = useState<number>(24);
  const history = useAccountHistory({ id, months });
  const accounts = useAccounts();
  const status = useSyncStatus();

  if (history.isError) return <p className="note err">{describeError(history.error)}</p>;
  if (history.data === undefined) return <p className="note loading">Завантажую рахунок…</p>;
  const { account } = history.data;
  const start = findChartStart(history.data);
  const points = history.data.points.filter((point) => point.month >= start);
  const names = new Map((accounts.data ?? []).map((entry) => [entry.id, formatAccountName(entry.name)]));
  const eur = points.at(-1)?.eur ?? null;
  const unit = formatCurrencySign(account.currency);

  return (
    <div className="view">
      <p className="note">
        <a className="link" href={buildHref({ view: 'accounts' })}>
          ← Усі рахунки
        </a>
      </p>
      <section>
        <h2 className="with-mark">
          <AccountMark account={account} size="lg" />
          <span>
            {formatAccountName(account.name)} · {describeKind(account)}
            {account.bank !== null && ` · ${account.bank}`}
          </span>
        </h2>
        <div className={account.balance < 0 && account.kind !== 'credit' ? 'big num neg' : 'big num'}>
          {formatBreakableMoney(account.balance, account.currency)}
        </div>
        <p className="note" title={account.syncSource === null ? undefined : SYNCED_HINT}>
          {eur !== null && account.currency !== 'EUR' && `≈\u00a0${formatEur(eur)} · `}
          {describeFreshness({ account, statuses: status.data ?? [] })}
          {account.kind === 'credit' &&
            account.creditLimit !== null &&
            ` · використано ${formatMoney(Math.max(0, -account.balance), account.currency)} з ${formatMoney(account.creditLimit, account.currency)}`}
        </p>
      </section>

      <div className="grid2">
        {account.kind === 'receivable' ? (
          <LoanTerms account={account} />
        ) : (
        <section>
          <SectionHead
            title={account.kind === 'investment' ? 'Звірка зі звітом' : 'Звірка з банком'}
            info={
              <>
                <p>
                  Mono — баланс, який банк надрукував після свого останнього рядка, проти трекера на кінець того дня. Revolut і
                  Binance — що повідомила остання синхронізація. IBKR і Freedom24 — чисті активи у звіті брокера.
                </p>
                <p>
                  «Звірено» — момент, на який банк чи брокер назвав баланс. Якщо рухів давно не було, дата давня, і це нормально.
                  «Оновлено» — коли синхронізація востаннє забирала рядки.
                </p>
              </>
            }
          />
          <BalanceCheckBlock history={history.data} />
        </section>
        )}
        <section>
          <SectionHead
            title="Початковий баланс"
            info={
              <p>
                Баланс = початковий баланс + усі записи з дати початку. Старіші записи — історія: вони не змінюють поточний
                баланс, але відновлюють минулі.
              </p>
            }
          />
          <dl className="facts">
            <dt>На {formatDay(account.openingDate)}</dt>
            <dd className="num">{formatMoney(account.openingBalance, account.currency)}</dd>
            <dt>Історія до того</dt>
            <dd>
              {history.data.historyRows === 0 || history.data.firstRowDate === null
                ? 'немає'
                : `${pluralize(history.data.historyRows, ['запис', 'записи', 'записів'])}, з ${formatDay(history.data.firstRowDate)}`}
            </dd>
            {history.data.unknownInflows > 0 && (
              <>
                <dt>Без суми</dt>
                <dd className="check-bad">
                  {pluralize(history.data.unknownInflows, ['переказ', 'перекази', 'переказів'])} сюди без відомої суми
                  зарахування: історія їх не бачить
                </dd>
              </>
            )}
          </dl>
        </section>
      </div>

      <section>
        <SectionHead
          title="Баланс на кінець місяця"
          info={
            <p>
              Від дати початку — початковий баланс плюс записи; раніше — початковий баланс мінус записи між датою і початком.
              Пунктир — місяці з неповними даними, там баланс лише оцінка.
            </p>
          }
        >
          {points.length >= 2 && (
            <div className="seg" role="group" aria-label="Період">
              {HISTORY_RANGES.map((option) => (
                <button key={option} type="button" aria-pressed={option === months} onClick={() => setMonths(option)}>
                  {option === 60 ? '5 р' : `${option} міс`}
                </button>
              ))}
            </div>
          )}
        </SectionHead>
        {points.length < 2 ? (
          <p className="note">
            Рахунок в обліку з {formatDay(account.openingDate)}: місячної історії балансу ще немає.
          </p>
        ) : (
        <ChartFigure
          summary={describeHistory({ points, currency: account.currency })}
          table={{
            columns: ['Місяць', `Баланс, ${unit}`, 'Записів'],
            rows: points.map((point) => ({
              key: point.month,
              cells: [
                <>
                  {formatMonthLong(point.month)}
                  {point.sparse && <span className="muted"> · дані неповні</span>}
                </>,
                formatMoney(point.balance, account.currency),
                point.rows,
              ],
            })),
          }}
        >
          <TimeChart
            unit={unit}
            series={[
              {
                key: 'balance',
                label: `Баланс, ${unit}`,
                color: 'var(--s1)',
                kind: 'line',
                points: points.map((point) => ({ date: point.date, value: point.balance, faded: point.sparse })),
              },
            ]}
            describePoint={(_series, point) => describeDayValue({ label: 'Баланс', point, unit })}
          />
        </ChartFigure>
        )}
      </section>

      <AccountRecords account={account} names={names} />
    </div>
  );
};

/** `#accounts?focus=owed` (from Інвестиції and Огляд): the receivables, scrolled into view once they load. */
const FOCUS_OWED = 'owed';

const useFocusOwed = (ready: boolean) => {
  const { query } = useRoute();
  const focus = query.get('focus');
  const section = useRef<HTMLElement>(null);
  useEffect(() => {
    if (ready && focus === FOCUS_OWED) section.current?.scrollIntoView({ block: 'start' });
  }, [ready, focus]);
  return section;
};

export const AccountsView = ({ accountId }: { accountId: string | null }) => {
  const accounts = useAccounts();
  const investments = useInvestments();
  const owed = useFocusOwed(accountId === null && investments.data !== undefined && accounts.data !== undefined);
  if (accountId !== null) return <AccountPage key={accountId} id={accountId} />;
  if (accounts.isError) return <p className="note err">{describeError(accounts.error)}</p>;
  if (accounts.data === undefined) return <p className="note loading">Завантажую…</p>;
  const names = new Map(accounts.data.map((account) => [account.id, formatAccountName(account.name)]));
  const loans = investments.data?.loans ?? [];
  const debts = investments.data?.debts ?? [];
  return (
    <div className="view">
      <p className="note">
        Натисни на рахунок, щоб побачити історію балансу, звірку з банком і його записи.
        <InfoTip label="позначки">
          <p>«✓ як у банку» (чи «як у IBKR», «як у Binance») — баланс трекера збігся з банком, брокером чи гаманцем; «Δ» — різниця.</p>
          <p>
            «звірено …» — момент, на який банк назвав баланс: для Mono це час останнього рядка виписки, тож у рахунку без рухів
            він давній. «оновлено …» — коли синхронізація востаннє забирала рядки.
          </p>
          <p>«оцінка на …» — дата останньої переоцінки інвестиції; «вручну» — дата останнього запису.</p>
        </InfoTip>
      </p>
      <AccountGroups accounts={accounts.data} only={['Рахунки зараз', 'Інвестиції']} />
      {loans.length > 0 && (
        <section ref={owed} className="scroll-target">
          <SectionHead
            title="Мені винні"
            info={<p>Позики: гроші, які винні тобі. Повернення — переказ з позики на твій рахунок.</p>}
          />
          <div className="grid2">
            {loans.map((loan) => (
              <LoanCard key={loan.account.id} loan={loan} names={names} />
            ))}
          </div>
        </section>
      )}
      {debts.length > 0 && (
        <section>
          <SectionHead
            title="Я винен"
            info={<p>Мінус — твій борг. Спільний рахунок, записаний на Splitwise, збільшує борг; переказ на Splitwise його гасить.</p>}
          />
          <div className="grid2">
            {debts.map((loan) => (
              <LoanCard key={loan.account.id} loan={loan} names={names} />
            ))}
          </div>
        </section>
      )}
    </div>
  );
};
