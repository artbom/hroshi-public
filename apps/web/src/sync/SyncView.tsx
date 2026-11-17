import { CONSENT_WARNING_DAYS, type SyncSource, type SyncSourceStatus } from '@hroshi/schema';
import { useState } from 'react';

import { describeError } from '../api.ts';
import { CheckedWord } from '../accounts/AccountCard.tsx';
import { describeCheckBasis, describeCheckMoment, describeCheckResult, describeTolerance, SOURCE_NAMES, SYNCED_HINT } from '../accounts/checks.ts';
import { SectionHead } from '../components/InfoTip.tsx';
import { AccountMark, SourceMark } from '../components/SourceMark.tsx';
import { formatAccountName, formatDate, formatDateTime, formatDay, formatMoney, formatWarning } from '../format.ts';
import { useAccounts, useStartRevolutConsent, useStartSync, useSyncStatus } from '../queries.ts';
import { buildHref } from '../route.ts';
import { FileImport } from './FileImport.tsx';
import { TrustPanel } from './TrustPanel.tsx';

const SOURCES: Readonly<Record<SyncSource, { title: string; description: string }>> = {
  mono: { title: 'Monobank', description: 'Виписки всіх карток і рахунків ФОП, щодня.' },
  revolut: { title: 'Revolut', description: 'Через Enable Banking (PSD2). Згоду банк просить поновлювати.' },
  binance: { title: 'Binance', description: 'P2P-ордери, депозити й баланс для переоцінки.' },
  ibkr: { title: 'Interactive Brokers', description: 'Flex-звіт: депозити й вартість портфеля.' },
  splitwise: { title: 'Splitwise', description: 'Спільні витрати: твоя частка в категоріях, борги на рахунку Splitwise.' },
};

const DAY_MS = 86_400_000;

const StatusChip = ({ status }: { status: SyncSourceStatus }) => {
  if (!status.configured) return <span className="chip warn">не налаштовано</span>;
  switch (status.lastRun?.status) {
    case undefined:
      return <span className="chip warn">ще не запускалась</span>;
    case 'running':
      return <span className="chip">триває…</span>;
    case 'ok':
      return <span className="chip">гаразд</span>;
    case 'error':
      return <span className="chip bad">помилка</span>;
  }
};

const ConsentLine = ({ validUntil }: { validUntil: string | null }) => {
  // The page is not left open for days, so the moment of mounting is "now" enough.
  const [mountedAt] = useState(() => Date.now());
  if (validUntil === null) return <dd>немає, підключи Revolut</dd>;
  const daysLeft = (Date.parse(validUntil) - mountedAt) / DAY_MS;
  return (
    <dd>
      до {formatDate(validUntil)}{' '}
      {daysLeft < 0 && <span className="chip bad">закінчилась</span>}
      {daysLeft >= 0 && daysLeft < CONSENT_WARNING_DAYS && <span className="chip warn">скоро закінчиться</span>}
    </dd>
  );
};

const ChecksTable = ({ status, currencies }: { status: SyncSourceStatus; currencies: ReadonlyMap<string, string> }) => {
  if (status.checks.length === 0) {
    return status.source === 'revolut' && status.configured ? (
      <p className="note warn-text">
        Без звірки: {status.lastSuccessAt === null ? 'синхронізація ще не проходила' : 'остання синхронізація не повідомила балансів рахунків'},
        тож порівняти трекер нема з чим. Звірка з’явиться після синхронізації, яка їх отримає.
      </p>
    ) : null;
  }
  const bases = [...new Set(status.checks.map((check) => describeCheckBasis(check)))];
  return (
    <div>
      <p className="note">Звірка: {bases.join('; ')}.</p>
      <div className="list">
        {status.checks.map((check) => {
          const currency = currencies.get(check.accountId) ?? '';
          const tolerance = describeTolerance({ check, currency });
          return (
            <a key={check.accountId} className="row" href={buildHref({ view: 'accounts', param: check.accountId })}>
              <span>{formatAccountName(check.accountName)}</span>
              <span className={check.matches ? 'r check-ok' : 'r check-bad'}>{describeCheckResult({ check, currency })}</span>
              <span className="s">
                {SOURCE_NAMES[check.source]} {formatMoney(check.bankBalance, currency)} · трекер {formatMoney(check.trackerBalance, currency)} ·{' '}
                <CheckedWord />{'\u00a0'}{describeCheckMoment(check)}
                {tolerance !== null && `. ${tolerance}`}
              </span>
            </a>
          );
        })}
      </div>
    </div>
  );
};

const RunHistory = ({ status }: { status: SyncSourceStatus }) => {
  if (status.recentRuns.length <= 1) return null;
  const failed = status.recentRuns.filter((run) => run.status === 'error').length;
  return (
    <details className="fold">
      <summary>
        Останні запуски ({status.recentRuns.length}
        {failed > 0 ? `, з помилкою ${failed}` : ''})
      </summary>
      <div className="list">
        {status.recentRuns.map((run) => (
          <div key={run.startedAt} className="row">
            <span>
              {formatDateTime(run.startedAt)}{' '}
              {run.status === 'error' ? (
                <span className="chip bad">помилка</span>
              ) : run.status === 'running' ? (
                <span className="chip">триває</span>
              ) : null}
            </span>
            <span className="r num small">
              {run.fetched} / +{run.created} / ~{run.updated}
            </span>
            {(run.error !== null || run.warnings.length > 0) && (
              <span className="s">
                {[run.error, ...run.warnings]
                  .flatMap((text) => (text === null ? [] : [formatWarning(text)]))
                  .join(' · ')}
              </span>
            )}
          </div>
        ))}
      </div>
    </details>
  );
};

const SyncCard = ({ status, currencies }: { status: SyncSourceStatus; currencies: ReadonlyMap<string, string> }) => {
  const start = useStartSync();
  const consent = useStartRevolutConsent();
  const { title, description } = SOURCES[status.source];
  const run = status.lastRun;
  const running = run?.status === 'running';

  return (
    <div className="card">
      <div className="head">
        <div className="with-mark">
          <SourceMark source={status.source} size="lg" />
          <div>
            <div className="t">{title}</div>
            <div className="s">{description}</div>
          </div>
        </div>
        <StatusChip status={status} />
      </div>
      <dl className="kv">
        {!status.configured && (
          <>
            <dt>Ключі</dt>
            <dd>немає в .env на сервері</dd>
          </>
        )}
        {run !== null && (
          <>
            <dt>Останній запуск</dt>
            <dd>
              {formatDateTime(run.startedAt)}
              {run.finishedAt !== null && ` → ${formatDateTime(run.finishedAt)}`}
            </dd>
            <dt>Записи</dt>
            <dd className="num">
              отримано{'\u00a0'}{run.fetched} · нових{'\u00a0'}{run.created} · змінено{'\u00a0'}{run.updated}
            </dd>
          </>
        )}
        {run?.error != null && (
          <>
            <dt>Помилка</dt>
            <dd className="neg">{formatWarning(run.error)}</dd>
          </>
        )}
        {run !== null && run.warnings.length > 0 && (
          <>
            <dt>Попередження</dt>
            <dd>
              {run.warnings.map((warning) => (
                <div key={warning} className="neg">
                  {formatWarning(warning)}
                </div>
              ))}
            </dd>
          </>
        )}
        <dt className="term" title={SYNCED_HINT}>
          Остання успішна
        </dt>
        <dd>{status.lastSuccessAt === null ? '—' : formatDateTime(status.lastSuccessAt)}</dd>
        {status.source === 'revolut' && (
          <>
            <dt>Згода банку</dt>
            <ConsentLine validUntil={status.consentValidUntil} />
          </>
        )}
      </dl>
      <ChecksTable status={status} currencies={currencies} />
      <RunHistory status={status} />
      <div className="inline-form">
        <button
          type="button"
          className="btn small primary"
          disabled={!status.configured || running || start.isPending}
          onClick={() => start.mutate(status.source)}
        >
          {running ? 'Синхронізується…' : 'Синхронізувати'}
        </button>
        {status.source === 'revolut' && (
          <button
            type="button"
            className="btn small"
            disabled={!status.configured || consent.isPending}
            onClick={() => consent.mutate()}
          >
            {status.consentValidUntil === null ? 'Підключити Revolut' : 'Поновити згоду'}
          </button>
        )}
      </div>
      {start.isError && <p className="note err">{describeError(start.error)}</p>}
      {consent.isError && <p className="note err">{describeError(consent.error)}</p>}
    </div>
  );
};

export const SyncView = () => {
  const status = useSyncStatus();
  const accounts = useAccounts();
  if (status.isError) return <p className="note err">Не вдалося отримати стан: {describeError(status.error)}</p>;
  if (status.data === undefined) return <p className="note loading">Завантажую…</p>;
  const currencies = new Map((accounts.data ?? []).map((account) => [account.id, account.currency]));
  const manual = (accounts.data ?? []).filter((account) => !account.archived && account.syncSource === null);

  return (
    <div className="view">
      <TrustPanel expanded />
      <section>
        <SectionHead
          title="Банки й біржі"
          info={
            <>
              <p>Сервер синхронізує джерела щодня зранку; курси НБУ оновлюються о 05:45. Тут можна запустити вручну й побачити помилки.</p>
              <p>
                «✓ як у банку» — баланс трекера збігся з банком: для Mono — з балансом після останнього рядка виписки, для Revolut — з
                тим, що банк назвав під час синхронізації. Binance і брокерів звіряють з їхніми звітами.
              </p>
              <p>«Оновлено» — коли синхронізація востаннє забирала рядки; «звірено» — момент, на який банк назвав баланс.</p>
            </>
          }
        />
        <div className="card-list">
          {status.data.map((entry) => (
            <SyncCard key={entry.source} status={entry} currencies={currencies} />
          ))}
        </div>
      </section>
      <section>
        <SectionHead
          title="Вручну та з файлів"
          info={<p>Ці рахунки не мають API: їх оновлюють записи вручну, Claude або імпорт файлів. Дата — останній запис чи оцінка.</p>}
        />
        <div className="card">
          <div className="list">
            {manual.map((account) => (
              <a key={account.id} className="row" href={buildHref({ view: 'accounts', param: account.id })}>
                <span className="with-mark tight">
                  <AccountMark account={account} size="sm" />
                  {formatAccountName(account.name)}
                </span>
                <span className="r num">{formatMoney(account.balance, account.currency)}</span>
                <span className="s">
                  {account.kind === 'investment'
                    ? account.valuedAt === null
                      ? `оцінок ще не було, баланс на ${formatDay(account.openingDate)}`
                      : `оцінка на ${formatDay(account.valuedAt)}`
                    : account.lastRowDate === null
                      ? 'записів ще немає'
                      : `останній запис ${formatDay(account.lastRowDate)}`}
                  {account.check !== null && (
                    <>
                      {` · ${describeCheckResult({ check: account.check, currency: account.currency })}, `}
                      <CheckedWord />{'\u00a0'}{describeCheckMoment(account.check)}
                    </>
                  )}
                </span>
              </a>
            ))}
          </div>
        </div>
      </section>
      <section>
        <SectionHead
          title="Імпорт з файлу"
          info={
            <p>
              Для історії, якої немає в API: виписка Mono за роки, вивантаження Binance, звіт Freedom24. Спершу перевірка — що нового й
              що вже є; записує лише «Імпортувати».
            </p>
          }
        />
        <FileImport />
      </section>
    </div>
  );
};
