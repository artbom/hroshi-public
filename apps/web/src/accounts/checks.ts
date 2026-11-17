import type { AccountBalance, BalanceCheck, SyncSourceStatus } from '@hroshi/schema';

import { formatDateTime, formatDay, formatMoney, formatTime } from '../format.ts';
import { findToday } from '../months.ts';

export const SOURCE_NAMES: Readonly<Record<BalanceCheck['source'], string>> = {
  mono: 'Mono',
  revolut: 'Revolut',
  binance: 'Binance',
  ibkr: 'IBKR',
  freedom24: 'Freedom24',
  splitwise: 'Splitwise',
};

/** A time today reads as «04:52», an older one with its date. */
export const formatMoment = (iso: string): string =>
  new Date(iso).toLocaleDateString('en-CA') === findToday() ? formatTime(iso) : formatDateTime(iso);

/** «як у банку» for banks; a broker or an exchange is named, since its figure is a statement, not a bank balance. */
export const describeCheckTarget = (check: Pick<BalanceCheck, 'source'>): string =>
  check.source === 'mono' || check.source === 'revolut' ? 'як у банку' : `як у ${SOURCE_NAMES[check.source]}`;

/** Broker files describe a day, bank lines and sync runs a moment. */
export const describeCheckMoment = (check: Pick<BalanceCheck, 'basis' | 'checkedAt'>): string =>
  check.basis === 'broker' || check.basis === 'wallet' ? `на\u00a0${formatDay(check.checkedAt.slice(0, 10))}` : formatMoment(check.checkedAt);

/** Where the other side's figure comes from, in one phrase. */
export const describeCheckBasis = (check: Pick<BalanceCheck, 'basis' | 'source'>): string => {
  switch (check.basis) {
    case 'statement':
      return 'баланс, який Mono надрукував після свого останнього рядка';
    case 'sync':
      return check.source === 'binance'
        ? 'сума гаманців, яку Binance повідомив під час синхронізації'
        : 'баланс, який банк повідомив під час синхронізації';
    case 'broker':
      return 'чисті активи у звіті брокера на цей день';
    case 'wallet':
      return 'сума гаманців у вивантаженні Binance';
  }
};

export const describeCheckResult = ({ check, currency }: { check: BalanceCheck; currency: string }): string =>
  check.matches
    ? `✓ ${describeCheckTarget(check)}`
    : `Δ ${formatMoney(check.difference, currency)} проти ${SOURCE_NAMES[check.source]}`;

/** Why a small gap still counts as agreement: a market-priced wallet moves between the reading and the day's end. */
export const describeTolerance = ({ check, currency }: { check: BalanceCheck; currency: string }): string | null =>
  check.matches && Math.abs(check.difference) >= 0.01
    ? `Різниця ${formatMoney(Math.abs(check.difference), currency)} — у межах ${formatMoney(check.tolerance, currency)}: ціни в гаманці рухаються щохвилини.`
    : null;

/**
 * «оновлено» is when a sync last fetched the account; «оцінка на» is the date of its latest
 * valuation row; «вручну» is the date of its latest row. «звірено» belongs to the check, not here.
 */
export const describeFreshness = ({
  account,
  statuses,
}: {
  account: AccountBalance;
  statuses: readonly SyncSourceStatus[];
}): string => {
  const status = statuses.find((entry) => entry.source === account.syncSource);
  const synced = status?.lastSuccessAt == null ? null : `оновлено ${formatMoment(status.lastSuccessAt)} · ${SOURCE_NAMES[status.source]}`;
  if (account.kind === 'investment') {
    const valued =
      account.valuedAt === null ? `оцінок ще не було, баланс на ${formatDay(account.openingDate)}` : `оцінка на ${formatDay(account.valuedAt)}`;
    return synced === null ? valued : `${valued} · ${synced}`;
  }
  if (synced !== null) return synced;
  return account.lastRowDate === null ? 'вручну, записів ще немає' : `вручну, останній запис ${formatDay(account.lastRowDate)}`;
};

/** «оновлено» and «звірено» sit side by side on a card and mean different moments; their tooltips say which. */
export const SYNCED_HINT = 'Оновлено — коли синхронізація востаннє забрала рядки з банку.';
export const CHECKED_HINT =
  'Звірено — коли банк надрукував баланс після рядка, з яким ми звірились. Без нових рухів на рахунку ця дата давня, і це нормально.';

/** A synced account the sync never reported a balance for: there is nothing to compare yet. */
export const isAwaitingCheck = (account: AccountBalance) =>
  account.check === null && (account.syncSource === 'mono' || account.syncSource === 'revolut' || account.syncSource === 'binance');
