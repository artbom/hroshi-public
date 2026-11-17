import type { Investments } from '@hroshi/schema';
import type { ReactNode } from 'react';

import { describeError } from '../api.ts';
import { InfoTip, SectionHead } from '../components/InfoTip.tsx';
import {
  formatAccountName,
  formatCurrencySign,
  formatDay,
  formatDecimal,
  formatEur,
  formatSignedEur,
  formatSignedPercentPrecise,
  pluralize,
} from '../format.ts';
import { useAccounts, useInvestments } from '../queries.ts';
import { buildHref, buildTableHref, useRoute } from '../route.ts';
import { BrokerCard } from './BrokerCard.tsx';
import { AllocationSection, IncomeSection, PortfolioChart, PositionsSection } from './PortfolioSections.tsx';
import { PositionDrawer } from './PositionDrawer.tsx';
import { PeriodReturns, ResultBreakdown, scrollToSection } from './ResultSections.tsx';
import { assignAccountColors, formatDayRange, formatXirr } from './shared.ts';

/**
 * A tile's title with its ⓘ: the last word and the ⓘ never part, so a narrow tile wraps the title
 * before it strands the ⓘ on a line of its own.
 */
const TileKey = ({ label, info }: { label: string; info: ReactNode }) => {
  const words = label.split(' ');
  const last = words.pop() ?? '';
  return (
    <span className="k">
      {words.length > 0 && `${words.join(' ')} `}
      <span className="nowrap">
        {last}
        <InfoTip label={label.toLowerCase()}>{info}</InfoTip>
      </span>
    </span>
  );
};

/** One side of the return formula: (1 + 4,7%). */
const formatFactor = (share: number) => `(1 ${share < 0 ? '−' : '+'} ${formatDecimal(Math.abs(share) * 100)}%)`;

/**
 * The combined return in euros, taken apart into what the market did in dollars and what the
 * dollar did against the euro, and why it is not the brokers' own figures averaged.
 */
const ReturnTile = ({ data, names }: { data: Investments; names: ReadonlyMap<string, string> }) => {
  const { eur, local, localCurrency, fx } = data.returns;
  const brokers = data.accounts.filter((holding) => holding.broker !== null);
  const currencySign = localCurrency === null ? '' : formatCurrencySign(localCurrency);
  return (
    <div className="tile">
      <TileKey
        label="Річна дохідність, XIRR"
        info={
          <>
            <p>
              Грошово-зважена річна дохідність {brokers.map((holding) => names.get(holding.account.id) ?? holding.account.id).join(' і ')}{' '}
              разом: кожне поповнення враховано в день, коли гроші зайшли, вартість — сьогоднішня.
            </p>
            {local !== null && fx !== null && eur !== null && (
              <>
                <p>
                  У {currencySign}, як рахують брокери: {formatSignedPercentPrecise(local)} — це сам ринок. У євро:{' '}
                  {formatSignedPercentPrecise(eur)}, бо внески перераховано за курсом дня внеску, а вартість — за сьогоднішнім, і{' '}
                  {fx >= 0 ? 'долар відтоді подорожчав' : 'долар відтоді подешевшав'} щодо євро ({formatSignedPercentPrecise(fx)} на рік).
                </p>
                <p className="num">
                  {formatFactor(local)} × {formatFactor(fx)} − 1 = {formatSignedPercentPrecise(eur)}
                </p>
              </>
            )}
            <p>
              Окремо по брокерах, у валюті рахунку:{' '}
              {brokers.map((holding) => `${names.get(holding.account.id) ?? holding.account.id} ${formatXirr(holding.broker?.xirr ?? null)}`).join(', ')}.
              Разом — не середнє: рахунок, що довше тримає більше грошей, важить більше, а рахунок молодший за рік дуже чутливий до
              останніх тижнів.
            </p>
          </>
        }
      />
      <span className={eur !== null && eur < 0 ? 'v num neg' : 'v num pos'}>{eur === null ? '—' : `${formatSignedPercentPrecise(eur)} у €`}</span>
      {local !== null && fx !== null && (
        <span className="small muted">
          ринок {formatSignedPercentPrecise(local)} у {currencySign} · курс {currencySign}→€ {formatSignedPercentPrecise(fx)}
        </span>
      )}
      {data.benchmark !== null && data.benchmark.xirr !== null && (
        <span className="small muted">
          {data.benchmark.symbol} з тими ж внесками: {formatSignedPercentPrecise(data.benchmark.xirr)}
        </span>
      )}
    </div>
  );
};

export const InvestmentsView = () => {
  const investments = useInvestments();
  const accounts = useAccounts();
  const { param } = useRoute();
  if (investments.isError) return <p className="note err">{describeError(investments.error)}</p>;
  if (investments.data === undefined) return <p className="note">Рахую інвестиції…</p>;
  const data = investments.data;
  const names = new Map((accounts.data ?? []).map((account) => [account.id, formatAccountName(account.name)]));
  const colors = assignAccountColors(data.accounts);
  const withoutBroker = data.accounts.filter((holding) => holding.broker === null);
  const brokerHoldings = data.accounts.filter((holding) => holding.broker !== null);
  const brokerNames = brokerHoldings.map((holding) => names.get(holding.account.id) ?? formatAccountName(holding.account.name));
  const { breakdown } = data;
  const opening =
    breakdown.openingFrom === null || breakdown.openingTo === null ? null : formatDayRange(breakdown.openingFrom, breakdown.openingTo);

  return (
    <div className="view">
      <section>
        <SectionHead
          title="Інвестиції зараз"
          info={
            <>
              <p>Вартість — баланс рахунків: початковий баланс, поповнення й переоцінки за звітами брокерів.</p>
              <p>Результат рахується лише там, де внески відомі повністю: з грошових записів брокера (IBKR Flex, звіт Freedom24).</p>
            </>
          }
        />
        <div className="tiles inv-kpis">
          <div className="tile main">
            <span className="k">Вартість</span>
            <button type="button" className="inv-jump v num" onClick={() => scrollToSection('inv-positions')}>
              {formatEur(data.valueEur)}
            </button>
            <span className="small muted">{pluralize(data.positions.length, ['позиція', 'позиції', 'позицій'])}</span>
          </div>
          <div className="tile">
            <TileKey
              label="Результат брокерів"
              info={
                <p>
                  Вартість мінус чисті внески за грошовими записами брокера, для: {brokerNames.join(', ') || '—'}. Усе в євро за сьогоднішнім
                  курсом, тож курс долара сюди не входить. Розклад — під плитками.
                </p>
              }
            />
            <span className={data.brokerGainEur < 0 ? 'v num neg' : 'v num pos'}>{formatSignedEur(data.brokerGainEur)}</span>
            <span className="small muted">
              {breakdown.brokerFrom !== null && `з ${formatDay(breakdown.brokerFrom)} · `}
              {brokerHoldings.map((holding, index) => (
                <span key={holding.account.id}>
                  {index > 0 && ' + '}
                  <a href={buildHref({ view: 'accounts', param: holding.account.id })}>{brokerNames[index]}</a>
                </span>
              ))}
            </span>
          </div>
          <ReturnTile data={data} names={names} />
          <div className="tile">
            <TileKey
              label="За час у трекері"
              info={
                <p>
                  Сума по всіх рахунках: вартість − початковий баланс − внески після дати, з якої рахунок ведеться в трекері
                  {opening !== null && ` (${opening})`}. Це не результат з першої покупки — той у «Результаті брокерів».
                </p>
              }
            />
            {breakdown.openingFrom === null ? (
              <span className={data.sinceOpeningGainEur < 0 ? 'v num neg' : 'v num pos'}>{formatSignedEur(data.sinceOpeningGainEur)}</span>
            ) : (
              <a
                className={`plain v num ${data.sinceOpeningGainEur < 0 ? 'neg' : 'pos'}`}
                href={buildTableHref({ type: 'valuation', from: breakdown.openingFrom })}
              >
                {formatSignedEur(data.sinceOpeningGainEur)}
              </a>
            )}
            <span className="small muted">
              {opening !== null && `з ${opening} · `}усі {pluralize(data.accounts.length, ['рахунок', 'рахунки', 'рахунків'])}
            </span>
          </div>
        </div>
        <div className="inv-results">
          <ResultBreakdown data={data} names={names} />
          <PeriodReturns data={data} names={names} />
        </div>
        {withoutBroker.length > 0 && (
          <p className="note" style={{ marginTop: 8 }}>
            Без звіту брокера: {withoutBroker.map((holding) => names.get(holding.account.id) ?? holding.account.id).join(', ')} — для них
            показано лише результат за час у трекері, бо їхньої вартості до відкриття в трекері немає.
          </p>
        )}
      </section>

      <PortfolioChart data={data} names={names} />
      <AllocationSection data={data} colors={colors} names={names} />
      <PositionsSection data={data} names={names} />
      <IncomeSection data={data} names={names} />
      <p className="note inv-loans-link">
        <a href={buildHref({ view: 'accounts', query: { focus: 'owed' } })}>Позики й борги — на «Рахунках» → «Мені винні»</a>
      </p>

      <section>
        <SectionHead title="Рахунки" />
        <div className="grid2">
          {data.accounts.map((holding) => (
            <BrokerCard key={holding.account.id} holding={holding} color={colors.get(holding.account.id) ?? 'var(--s1)'} names={names} />
          ))}
        </div>
      </section>
      <PositionDrawer positionKey={param} names={names} />
    </div>
  );
};
