import type { AssetClass, BrokerCashFlow, ExposureCurrency, InvestmentAccount } from '@hroshi/schema';

import { formatDay, formatDecimal, formatNumber, formatPercent, formatSignedPercentPrecise } from '../format.ts';

/** Fixed slot order; an account keeps its colour whatever its size. */
export const SLOTS = ['var(--s1)', 'var(--s2)', 'var(--s3)', 'var(--s4)', 'var(--s5)'] as const;

/** Every asset class has its own slot, so the donut and the table chips agree. */
export const CLASS_COLORS: Readonly<Record<AssetClass, string>> = {
  stockEtf: 'var(--s1)',
  stock: 'var(--s2)',
  bondEtf: 'var(--s3)',
  cash: 'var(--s4)',
  crypto: 'var(--s5)',
};

export const CLASS_LABELS: Readonly<Record<AssetClass, string>> = {
  stockEtf: 'Фонди акцій',
  stock: 'Окремі акції',
  bondEtf: 'Фонди облігацій',
  cash: 'Гроші',
  crypto: 'Крипта',
};

export const EXPOSURE_COLORS: Readonly<Record<ExposureCurrency, string>> = {
  USD: 'var(--s1)',
  EUR: 'var(--s3)',
  other: 'var(--s4)',
};

export const EXPOSURE_LABELS: Readonly<Record<ExposureCurrency, string>> = {
  USD: 'Долар',
  EUR: 'Євро',
  other: 'Інші валюти',
};

export const BROKER_NAMES: Readonly<Record<string, string>> = {
  ibkr: 'Flex-звіт IBKR',
  freedom24: 'звіт Freedom24',
  binance: 'баланси Binance',
};

export const SOURCE_LABELS: Readonly<Record<string, string>> = {
  ibkr: 'звіт IBKR',
  binance: 'дані Binance',
  claude: 'вручну через Claude',
  page: 'вручну',
  mono: 'Monobank',
  revolut: 'Revolut',
  zenmoney: 'ZenMoney',
};

export const FLOW_LABELS: Readonly<Record<BrokerCashFlow['kind'], string>> = {
  deposit: 'Поповнення',
  withdrawal: 'Вивід',
  dividend: 'Дивіденди',
  tax: 'Податок',
  fee: 'Комісія',
  interest: 'Відсотки',
  other: 'Інше',
};

export const formatXirr = (xirr: number | null): string => (xirr === null ? '—' : `${formatSignedPercentPrecise(xirr)} річних`);

/** Small shares keep a decimal, so 0,4% does not read as 0%. */
export const formatWeight = (share: number): string =>
  share > 0 && share < 0.1 ? `${formatDecimal(share * 100)}%` : formatPercent(share);

/** Share quantities are whole; fractions (crypto, cash) keep up to four digits, with a comma. */
export const formatQuantity = (quantity: number): string => formatNumber(quantity, { digits: 4, minDigits: 0 });

/** «1–11 лист. 2026» within one month, «28 жовт. – 3 лист. 2026» across two. */
export const formatDayRange = (from: string, to: string): string => {
  if (from === to) return formatDay(from);
  return from.slice(0, 7) === to.slice(0, 7) ? `${Number(from.slice(8, 10))}–${formatDay(to)}` : `${formatDay(from)} – ${formatDay(to)}`;
};

/** Colours follow the accounts' own order, not their size, so they stay put as values move. */
export const assignAccountColors = (accounts: readonly InvestmentAccount[]): ReadonlyMap<string, string> =>
  new Map(
    accounts
      .toSorted((left, right) => left.account.order - right.account.order)
      .map((holding, index) => [holding.account.id, SLOTS[index % SLOTS.length] ?? 'var(--s1)']),
  );
