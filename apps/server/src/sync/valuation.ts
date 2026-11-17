import { computeBalances, roundAmount } from '@hroshi/domain';
import type { IsoDate, SyncSource } from '@hroshi/schema';

import type { Db } from '../db.ts';
import { loadLedger } from '../ledger.ts';
import { fromIsoDate, toNumber } from '../mappers.ts';
import { prefixExternalId } from './ingest.ts';

/**
 * Books the gap between the provider's reported value and the computed balance as one
 * valuation per day (market moves, Earn interest, fees nobody itemised). Re-running the
 * same day replaces that day's valuation instead of stacking another.
 */
export const recordValuation = async ({
  db,
  source,
  accountId,
  value,
  date,
  note,
}: {
  db: Db;
  source: SyncSource;
  accountId: string;
  value: number;
  date: IsoDate;
  note: string;
}): Promise<{ created: number; updated: number }> => {
  const externalId = prefixExternalId(source, `valuation:${accountId}:${date}`);
  const [ledger, existing] = await Promise.all([
    loadLedger(db),
    db.transaction.findUnique({ where: { externalId } }),
  ]);
  const balance = computeBalances({ accounts: ledger.accounts, transactions: ledger.transactions }).get(accountId) ?? 0;
  const before = balance - (existing === null ? 0 : toNumber(existing.amount));
  const delta = roundAmount(value - before);

  if (existing !== null) {
    if (Math.abs(delta) < 0.005) await db.transaction.delete({ where: { id: existing.id } });
    else await db.transaction.update({ where: { id: existing.id }, data: { amount: delta, note } });
    return { created: 0, updated: 1 };
  }
  if (Math.abs(delta) < 0.005) return { created: 0, updated: 0 };

  const account = ledger.accounts.find((candidate) => candidate.id === accountId);
  if (account === undefined) throw new Error(`Unknown account "${accountId}"`);
  await db.transaction.create({
    data: {
      type: 'valuation',
      date: fromIsoDate(date),
      accountId,
      amount: delta,
      currency: account.currency,
      note,
      source,
      externalId,
    },
  });
  return { created: 1, updated: 0 };
};
