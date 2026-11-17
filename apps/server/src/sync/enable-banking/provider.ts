import { computeBalances, shiftDate } from '@hroshi/domain';

import type { IsoDate } from '@hroshi/schema';

import { findToday } from '../../clock.ts';
import type { Db } from '../../db.ts';
import { env } from '../../env.ts';
import { loadLedger } from '../../ledger.ts';
import { ingestStatement } from '../ingest.ts';
import { describeBalanceMismatch } from '../reconciliation.ts';
import type { StatementItem } from '../statement.ts';
import type { SyncCounts, SyncProvider } from '../types.ts';
import { createEnableBankingClient } from './client.ts';
import { ConsentExpiredError, ConsentLostError } from './errors.ts';
import { mapTransaction, pairPocketExchanges } from './lines.ts';

/** Banks behind PSD2 allow about four background fetches a day; one overlapping daily pull is enough. */
const LOOKBACK_DAYS = 10;
/** Earliest month worth asking for: the ledger's history starts at the end of 2021. */
const HISTORY_FROM: IsoDate = '2021-12-01';
/** Closing booked first: it matches what the ledger computes from booked lines. */
const BALANCE_PREFERENCE = ['CLBD', 'ITBD', 'XPCD', 'CLAV', 'ITAV'];

/** A consent the bank closed early is as good as expired: the reminder and the sync screen should say so now. */
const markConsentLost = async ({ db, error }: { db: Db; error: unknown }): Promise<never> => {
  if (error instanceof ConsentLostError) {
    await db.connection.update({ where: { source: 'revolut' }, data: { validUntil: new Date() } });
    throw new ConsentLostError(`Revolut consent ended early: ${error.message}`);
  }
  throw error;
};

const syncRevolut = async ({
  db,
  dateFrom,
  strategy,
}: {
  db: Db;
  dateFrom: IsoDate;
  strategy: 'default' | 'longest';
}): Promise<SyncCounts> => {
  const connection = await db.connection.findUnique({ where: { source: 'revolut' } });
  if (connection?.sessionId == null) throw new Error('Revolut is not connected yet: use «Підключити Revolut»');
  if (connection.validUntil !== null && connection.validUntil < new Date()) {
    throw new ConsentExpiredError('Revolut consent expired: renew it with «Поновити згоду»');
  }

  const client = await createEnableBankingClient();
  const accounts = await db.account.findMany({ where: { syncSource: 'revolut', syncAccountId: { not: null } } });
  const items: StatementItem[] = [];
  const bankBalances = new Map<string, number>();

  try {
    for (const account of accounts) {
      const accountUid = account.syncAccountId ?? '';
      const transactions = await client.fetchTransactions({ accountUid, dateFrom, strategy });
      // Pending lines can come back booked under a different reference; only booked ones are final.
      for (const transaction of transactions.filter((candidate) => candidate.status === 'BOOK')) {
        const item = mapTransaction({ transaction, accountId: account.id });
        if (item !== undefined) items.push(item);
      }
      const { balances } = await client.fetchBalances(accountUid);
      const balance = BALANCE_PREFERENCE.map((type) => balances.find((entry) => entry.balance_type === type)).find(Boolean);
      if (balance !== undefined) bankBalances.set(account.id, balance.balance_amount.amount);
    }
  } catch (error) {
    await markConsentLost({ db, error });
  }

  const counts = await ingestStatement({ db, source: 'revolut', items: pairPocketExchanges({ items, accounts }) });
  const ledger = await loadLedger(db);
  const computed = computeBalances({ accounts: ledger.accounts, transactions: ledger.transactions });
  const warnings = accounts.flatMap((account) => {
    const bank = bankBalances.get(account.id);
    const ours = computed.get(account.id);
    // Matching balances are recorded too, so the accounts page can show «✓ як у банку» for Revolut.
    if (bank === undefined || ours === undefined) return [];
    return [describeBalanceMismatch({ name: account.name, tracker: ours, bank })];
  });
  return { ...counts, warnings };
};

/** Right after consent the bank still hands out its whole history; afterwards only about 90 days. */
export const pullRevolutHistory = (db: Db) => syncRevolut({ db, dateFrom: HISTORY_FROM, strategy: 'longest' });

export const revolutProvider: SyncProvider = {
  source: 'revolut',
  isConfigured: () => env.ENABLE_BANKING_APP_ID !== undefined && env.ENABLE_BANKING_KEY_PATH !== undefined,
  run: async ({ db }) => syncRevolut({ db, dateFrom: shiftDate(findToday(), -LOOKBACK_DAYS), strategy: 'default' }),
};
