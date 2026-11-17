import { shiftDate } from '@hroshi/domain';
import type { IsoDate } from '@hroshi/schema';

import type { Db } from '../../db.ts';
import { saveIbkrStatement } from '../../brokers/import.ts';
import { findToday } from '../../clock.ts';
import { env } from '../../env.ts';
import { fromIsoDate, toIsoDate, toNullableNumber, toNumber } from '../../mappers.ts';
import { prefixExternalId } from '../ingest.ts';
import { roundMoney } from '../statement.ts';
import type { SyncCounts, SyncProvider } from '../types.ts';
import { recordValuation } from '../valuation.ts';
import { fetchFlexStatement, parseFlexDate, readFlexRows } from './flex.ts';

const IBKR_ACCOUNT_ID = 'ibkr';
/** Money leaves Mono EUR, passes through the Zen card and lands at IBKR days later. */
const DEPOSIT_LAG_DAYS = 10;
/** Card top-ups through Zen/Genome lose a small fee on the way. */
const DEPOSIT_FEE_RATIO = 0.02;
const VALUATION_NOTE = 'Переоцінка за звітом IBKR (ринок, дивіденди, податки)';

type Deposit = { id: string; date: IsoDate; amount: number; currency: string; baseAmount: number };

/** NAV in the base currency on the latest report date the statement covers. */
const readNetAssetValue = (xml: string): { value: number; date: IsoDate } | undefined => {
  const byDate = readFlexRows(xml, 'EquitySummaryByReportDateInBase')
    .map((row) => ({ date: parseFlexDate(row['reportDate']), value: Number(row['total']) }))
    .filter((row): row is { date: IsoDate; value: number } => row.date !== undefined && Number.isFinite(row.value))
    .toSorted((left, right) => left.date.localeCompare(right.date));
  const latest = byDate.at(-1);
  if (latest !== undefined) return latest;

  const [change] = readFlexRows(xml, 'ChangeInNAV');
  const date = parseFlexDate(change?.['toDate']);
  const value = Number(change?.['endingValue']);
  return date === undefined || !Number.isFinite(value) ? undefined : { date, value };
};

const readDeposits = (xml: string): Deposit[] =>
  readFlexRows(xml, 'CashTransaction').flatMap((row) => {
    const amount = Number(row['amount']);
    const date = parseFlexDate(row['dateTime'] ?? row['settleDate'] ?? row['reportDate']);
    const id = row['transactionID'] ?? row['tradeID'];
    if (!/deposit/i.test(row['type'] ?? '') || !(amount > 0) || date === undefined || id === undefined) return [];
    const rate = Number(row['fxRateToBase'] ?? '1');
    return [{ id, date, amount, currency: row['currency'] ?? '', baseAmount: roundMoney(amount * (Number.isFinite(rate) ? rate : 1)) }];
  });

/** Gives the transfer that funded IBKR its dollar amount; a deposit with no such transfer goes to review. */
const ingestDeposits = async ({ db, deposits }: { db: Db; deposits: readonly Deposit[] }) => {
  const counts = { created: 0, updated: 0 };
  const ibkr = await db.account.findUniqueOrThrow({ where: { id: IBKR_ACCOUNT_ID } });

  for (const deposit of deposits) {
    const toExternalId = prefixExternalId('ibkr', `cash:${deposit.id}`);
    if ((await db.transaction.findUnique({ where: { toExternalId } })) !== null) continue;

    const candidates = await db.transaction.findMany({
      where: {
        type: 'transfer',
        toAccountId: ibkr.id,
        toExternalId: null,
        date: { gte: fromIsoDate(shiftDate(deposit.date, -DEPOSIT_LAG_DAYS)), lte: fromIsoDate(shiftDate(deposit.date, 1)) },
      },
      orderBy: { date: 'desc' },
    });
    // A transfer qualifies when its dollar figure is this deposit, or when the dollars are unknown
    // but the euros it sent are what arrived; "any transfer nearby" pairs the wrong money.
    const transfer =
      candidates.find((row) => Math.abs((toNullableNumber(row.toAmount) ?? 0) - deposit.baseAmount) < 0.01) ??
      candidates.find(
        (row) =>
          (toNullableNumber(row.toAmount) ?? 0) === 0 &&
          row.currency === deposit.currency &&
          Math.abs(toNumber(row.amount) - deposit.amount) <= Math.max(1, deposit.amount * DEPOSIT_FEE_RATIO),
      );
    if (transfer !== undefined) {
      await db.transaction.update({ where: { id: transfer.id }, data: { toAmount: deposit.baseAmount, toExternalId } });
      counts.updated += 1;
      continue;
    }
    if (deposit.date < toIsoDate(ibkr.openingDate)) continue;

    await db.transaction.create({
      data: {
        type: 'transfer',
        date: fromIsoDate(deposit.date),
        accountId: deposit.currency === 'EUR' ? 'mono-eur' : 'mono-usd',
        amount: deposit.amount,
        currency: deposit.currency === 'EUR' ? 'EUR' : 'USD',
        toAccountId: ibkr.id,
        toAmount: deposit.baseAmount,
        toCurrency: ibkr.currency,
        note: `Поповнення IBKR ${deposit.amount} ${deposit.currency}`,
        source: 'ibkr',
        toExternalId,
        needsReview: true,
        reviewReason: 'Поповнення IBKR без переказу в трекері: перевір, з якого рахунку',
      },
    });
    counts.created += 1;
  }
  return counts;
};

export const ibkrProvider: SyncProvider = {
  source: 'ibkr',
  isConfigured: () => env.IBKR_FLEX_TOKEN !== undefined && env.IBKR_FLEX_QUERY_ID !== undefined,
  run: async ({ db, log }): Promise<SyncCounts> => {
    if (env.IBKR_FLEX_TOKEN === undefined || env.IBKR_FLEX_QUERY_ID === undefined) {
      throw new Error('IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID are not set');
    }
    const xml = await fetchFlexStatement({ token: env.IBKR_FLEX_TOKEN, queryId: env.IBKR_FLEX_QUERY_ID });
    await saveIbkrStatement({ xml, date: findToday() });
    const deposits = readDeposits(xml);
    const nav = readNetAssetValue(xml);
    const depositCounts = await ingestDeposits({ db, deposits });
    if (nav === undefined) {
      log('no NAV section in the Flex statement; add "Net Asset Value (NAV) in Base" to the query');
      return { fetched: deposits.length, ...depositCounts, warnings: ['У Flex-звіті немає NAV: додай розділ NAV у запит'] };
    }
    const valuation = await recordValuation({
      db,
      source: 'ibkr',
      accountId: IBKR_ACCOUNT_ID,
      value: nav.value,
      date: nav.date,
      note: VALUATION_NOTE,
    });
    return {
      fetched: deposits.length + 1,
      created: depositCounts.created + valuation.created,
      updated: depositCounts.updated + valuation.updated,
    };
  },
};
