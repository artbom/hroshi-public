import type { BrokerCashFlow, BrokerFlowKind, BrokerReport, BrokerTrade, NavChange, RealizedTrade } from '@hroshi/schema';

import { parseFlexDate, readFlexRows } from '../sync/ibkr/flex.ts';

const toNumber = (value: string | undefined): number | null => {
  const parsed = Number(value);
  return value === undefined || value === '' || !Number.isFinite(parsed) ? null : parsed;
};

/** CashTransaction types as IBKR spells them. */
const findKind = (type: string, amount: number): BrokerFlowKind => {
  if (/deposit|withdraw/i.test(type)) return amount >= 0 ? 'deposit' : 'withdrawal';
  if (/withholding|tax/i.test(type)) return 'tax';
  if (/dividend|payment in lieu/i.test(type)) return 'dividend';
  if (/interest/i.test(type)) return 'interest';
  if (/fee|commission/i.test(type)) return 'fee';
  return 'other';
};

/** A Flex query without the section emits no element at all; with it, at least an empty one. */
const hasSection = (xml: string, tag: string) => new RegExp(`<${tag}[\\s/>]`).test(xml);

/**
 * Trades come at several levels of detail; executions are the real fills, orders their sums.
 * Closed lots and summaries would count the same fill twice.
 */
const pickTradeRows = (xml: string): Record<string, string>[] => {
  const rows = readFlexRows(xml, 'Trade');
  for (const level of ['EXECUTION', 'ORDER']) {
    const picked = rows.filter((row) => row['levelOfDetail'] === level);
    if (picked.length > 0) return picked;
  }
  return rows.filter((row) => row['levelOfDetail'] === undefined);
};

/** IBKR spells a currency pair «EUR.USD»; the app writes it as Freedom24 does, «EUR/USD». */
const readTrade = (row: Record<string, string>): BrokerTrade | null => {
  const date = parseFlexDate(row['tradeDate'] ?? row['dateTime']);
  const quantity = toNumber(row['quantity']);
  const price = toNumber(row['tradePrice']);
  if (date === undefined || quantity === null || price === null || quantity === 0) return null;
  const currencyPair = row['assetCategory'] === 'CASH';
  const commission = toNumber(row['ibCommission']);
  const realized = toNumber(row['fifoPnlRealized']);
  const side = (row['buySell'] ?? '').toUpperCase().startsWith('SELL') || quantity < 0 ? 'sell' : 'buy';
  return {
    date,
    symbol: currencyPair ? (row['symbol'] ?? '?').replace('.', '/') : (row['symbol'] ?? row['description'] ?? '?'),
    kind: currencyPair ? 'currency' : 'security',
    side,
    quantity: Math.abs(quantity),
    price,
    amount: Math.abs(toNumber(row['tradeMoney']) ?? quantity * price),
    currency: row['currency'] ?? 'USD',
    fee: commission === null ? null : Math.abs(commission),
    feeCurrency: row['ibCommissionCurrency'] ?? row['currency'] ?? null,
    realized: side === 'sell' && realized !== null && realized !== 0 ? realized : null,
  };
};

const NAV_CHANGE_FIELDS = [
  'startingValue',
  'endingValue',
  'depositsWithdrawals',
  'mtm',
  'realized',
  'dividends',
  'withholdingTax',
  'interest',
  'commissions',
  'forexCommissions',
  'otherFees',
  'fxTranslation',
  'netFxTrading',
  'other',
] as const;

/** The «Change in NAV» section: one row for the whole statement period, zero where IBKR leaves a field out. */
const readNavChange = (xml: string): NavChange | null => {
  const [row] = readFlexRows(xml, 'ChangeInNAV');
  const from = parseFlexDate(row?.['fromDate']);
  const to = parseFlexDate(row?.['toDate']);
  if (row === undefined || from === undefined || to === undefined) return null;
  const read = (field: (typeof NAV_CHANGE_FIELDS)[number]) => toNumber(row[field]) ?? 0;
  return {
    from,
    to,
    startingValue: read('startingValue'),
    endingValue: read('endingValue'),
    depositsWithdrawals: read('depositsWithdrawals'),
    mtm: read('mtm'),
    realized: read('realized'),
    dividends: read('dividends'),
    withholdingTax: read('withholdingTax'),
    interest: read('interest'),
    commissions: read('commissions'),
    forexCommissions: read('forexCommissions'),
    otherFees: read('otherFees'),
    fxTranslation: read('fxTranslation'),
    netFxTrading: read('netFxTrading'),
    other: read('other'),
  };
};

export const parseFlexReport = ({ xml, file }: { xml: string; file: string }): BrokerReport => {
  const nav = readFlexRows(xml, 'EquitySummaryByReportDateInBase')
    .flatMap((row) => {
      const date = parseFlexDate(row['reportDate']);
      const value = toNumber(row['total']);
      return date === undefined || value === null ? [] : [{ date, value }];
    })
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const base = readFlexRows(xml, 'AccountInformation')[0]?.['currency'] ?? 'USD';
  // IBKR converts every cash record at its own rate; using it keeps deposits exactly as the broker counts them.
  const cashFlows: BrokerCashFlow[] = readFlexRows(xml, 'CashTransaction').flatMap((row) => {
    const date = parseFlexDate(row['dateTime'] ?? row['settleDate'] ?? row['reportDate']);
    const amount = toNumber(row['amount']);
    const rate = toNumber(row['fxRateToBase']) ?? 1;
    if (date === undefined || amount === null) return [];
    return [
      {
        date,
        kind: findKind(row['type'] ?? '', amount),
        amount: Math.round(amount * rate * 100) / 100,
        currency: base,
        note: row['description'] || null,
        symbol: row['symbol'] || null,
        original: row['currency'] !== undefined && row['currency'] !== base ? { amount, currency: row['currency'] } : null,
      },
    ];
  });
  const positions = readFlexRows(xml, 'OpenPosition').filter((row) => (row['levelOfDetail'] ?? 'SUMMARY') === 'SUMMARY');
  const latest = nav.at(-1);
  const trades = hasSection(xml, 'Trades') ? pickTradeRows(xml).flatMap((row) => readTrade(row) ?? []) : null;
  const realized =
    trades === null
      ? null
      : trades.flatMap((trade): RealizedTrade[] =>
          trade.realized === null ? [] : [{ date: trade.date, symbol: trade.symbol, amount: trade.realized, currency: trade.currency }],
        );

  return {
    broker: 'ibkr',
    asOf: latest?.date ?? new Date().toISOString().slice(0, 10),
    file,
    currency: base,
    netAssets: latest?.value ?? null,
    holdings: positions.map((row) => ({
      symbol: row['symbol'] ?? row['description'] ?? '?',
      name: row['description'] ?? null,
      quantity: toNumber(row['position']) ?? 0,
      currency: row['currency'] ?? 'USD',
      price: toNumber(row['markPrice']),
      value: toNumber(row['positionValue']),
      cost: toNumber(row['costBasisMoney']),
    })),
    cashFlows,
    navHistory: nav,
    // Without a Trades section in the Flex query, sales and their profit are not in the file.
    realized,
    trades,
    navChange: readNavChange(xml),
  };
};
