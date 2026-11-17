import type { Db } from '../../db.ts';
import { mapAccount } from '../../mappers.ts';
import { ingestStatement } from '../ingest.ts';
import type { StatementItem } from '../statement.ts';
import type { SyncCounts } from '../types.ts';
import { BankTransactionSchema } from './client.ts';
import { mapTransaction, pairPocketExchanges } from './lines.ts';

const PREFIX = 'revolut:';

/**
 * Re-runs ingestion over the rows Revolut sync created, from the bank lines stored on them, so
 * pipeline fixes reach history the bank no longer serves. Rows Revolut linked to hand entries
 * stay as they are.
 */
export const reingestRevolut = async (db: Db): Promise<SyncCounts> => {
  const [accounts, rows] = await Promise.all([
    db.account.findMany({ where: { syncSource: 'revolut' } }),
    db.transaction.findMany({ where: { source: 'revolut' } }),
  ]);
  const revolutAccounts = new Set(accounts.map((account) => account.id));

  const items: StatementItem[] = rows.flatMap((row) => {
    const [accountId = ''] = (row.externalId ?? row.toExternalId ?? '').slice(PREFIX.length).split(':');
    const transaction = BankTransactionSchema.safeParse(row.raw);
    if (!revolutAccounts.has(accountId) || !transaction.success) return [];
    const item = mapTransaction({ transaction: transaction.data, accountId });
    return item === undefined ? [] : [item];
  });

  await db.transaction.deleteMany({ where: { id: { in: rows.map((row) => row.id) } } });
  return ingestStatement({ db, source: 'revolut', items: pairPocketExchanges({ items, accounts: accounts.map(mapAccount) }) });
};
