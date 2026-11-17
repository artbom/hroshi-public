import type { AccountBalance, AccountKind, SyncSourceStatus } from '@hroshi/schema';

import { AccountMark } from '../components/SourceMark.tsx';
import { formatAccountName, formatMoney, formatMoneyWhole } from '../format.ts';
import { buildHref } from '../route.ts';
import {
  CHECKED_HINT,
  describeCheckMoment,
  describeCheckResult,
  describeFreshness,
  describeTolerance,
  isAwaitingCheck,
  SOURCE_NAMES,
  SYNCED_HINT,
} from './checks.ts';

/** The word «звірено» with what it means on hover, wherever a check's moment is printed. */
export const CheckedWord = ({ capital = false }: { capital?: boolean }) => (
  <span className="term" title={CHECKED_HINT}>
    {capital ? 'Звірено' : 'звірено'}
  </span>
);

export const ACCOUNT_GROUPS: readonly { title: string; test: (account: AccountBalance) => boolean }[] = [
  { title: 'Рахунки зараз', test: (account) => (['everyday', 'credit', 'cash'] satisfies AccountKind[]).some((kind) => kind === account.kind) },
  { title: 'Інвестиції', test: (account) => account.kind === 'investment' },
  { title: 'Мені винні', test: (account) => account.kind === 'receivable' && account.balance >= 0 },
  { title: 'Я винен', test: (account) => account.kind === 'receivable' && account.balance < 0 },
];

/** Pass-through accounts (ФОП UAH) only matter while money sits on them. */
export const isShown = (account: AccountBalance) => !account.archived && !(account.passThrough && account.balance === 0);

export const sumByCurrency = (accounts: readonly AccountBalance[]) => {
  const totals = new Map<string, number>();
  for (const account of accounts) totals.set(account.currency, (totals.get(account.currency) ?? 0) + account.balance);
  return [...totals];
};

/** Intl glues the currency on with a no-break space; let a narrow card wrap the currency instead of splitting digits. */
export const formatBreakableMoney = (value: number, currency: string) =>
  formatMoney(value, currency).replace(/ (?=\D+$)/u, ' ');

/** The card's second line: whether the balance agrees with the bank, broker or wallet, and as of when. */
export const CheckMark = ({ account }: { account: AccountBalance }) => {
  const { check } = account;
  if (check === null) {
    return isAwaitingCheck(account) ? <span className="fresh check-wait">звірки ще не було</span> : null;
  }
  const tolerance = describeTolerance({ check, currency: account.currency });
  return (
    <span
      className={check.matches ? 'fresh check-ok' : 'fresh check-bad'}
      title={[`${SOURCE_NAMES[check.source]}: ${formatMoney(check.bankBalance, account.currency)}, трекер: ${formatMoney(check.trackerBalance, account.currency)}.`, tolerance]
        .filter(Boolean)
        .join(' ')}
    >
      {describeCheckResult({ check, currency: account.currency })}
      <span className="when">
        {' · '}
        <CheckedWord />{'\u00a0'}{describeCheckMoment(check)}
      </span>
    </span>
  );
};

export const AccountCard = ({ account, statuses }: { account: AccountBalance; statuses: readonly SyncSourceStatus[] }) => {
  // Credit-card debt is deliberate (owing hryvnia while it depreciates): shown neutral, never as an alarm.
  const negativeTone = account.balance < 0 && account.kind !== 'credit' ? 'neg' : '';
  return (
    <a className="acc link" href={buildHref({ view: 'accounts', param: account.id })}>
      <span className="name with-mark">
        <AccountMark account={account} />
        {formatAccountName(account.name)}
      </span>
      <span className={`bal num ${negativeTone}`.trim()}>{formatBreakableMoney(account.balance, account.currency)}</span>
      {account.kind === 'credit' && account.creditLimit !== null && (
        <span className="used num">
          використано {formatMoneyWhole(Math.max(0, -account.balance), account.currency)} з{' '}
          {formatMoneyWhole(account.creditLimit, account.currency)}
        </span>
      )}
      <span className="fresh" title={account.syncSource === null ? undefined : SYNCED_HINT}>
        {describeFreshness({ account, statuses })}
      </span>
      <CheckMark account={account} />
    </a>
  );
};
