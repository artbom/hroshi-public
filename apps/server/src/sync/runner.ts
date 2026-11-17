import type { SyncSource, SyncSourceStatus } from '@hroshi/schema';

import type { Db } from '../db.ts';
import type { SyncRun as SyncRunRow } from '../generated/prisma/client.ts';
import { conflict } from '../http-errors.ts';
import { loadLedger } from '../ledger.ts';
import { SYNC_PROVIDERS } from './providers.ts';
import { groupChecksBySource, listBalanceChecks, listOpenWarnings } from './reconciliation.ts';
import type { SyncCounts } from './types.ts';

/** A run still marked running after this long died with its process. */
const STALE_RUN_MS = 60 * 60 * 1000;

export const runSync = async ({
  db,
  source,
  log,
}: {
  db: Db;
  source: SyncSource;
  log: (message: string) => void;
}): Promise<SyncCounts> => {
  const running = await db.syncRun.findFirst({
    where: { source, status: 'running', startedAt: { gt: new Date(Date.now() - STALE_RUN_MS) } },
  });
  if (running !== null) throw conflict(`${source} sync is already running`);

  return recordSyncRun({ db, source, task: () => SYNC_PROVIDERS[source].run({ db, log: (message) => log(`[${source}] ${message}`) }) });
};

/** Wraps a sync or an import so the status screen shows its outcome. */
export const recordSyncRun = async ({
  db,
  source,
  task,
}: {
  db: Db;
  source: SyncSource;
  task: () => Promise<SyncCounts>;
}): Promise<SyncCounts> => {
  const run = await db.syncRun.create({ data: { source } });
  try {
    const counts = await task();
    await db.syncRun.update({ where: { id: run.id }, data: { ...counts, status: 'ok', finishedAt: new Date() } });
    return counts;
  } catch (error) {
    const message = error instanceof Error ? error.message : String(error);
    await db.syncRun.update({ where: { id: run.id }, data: { status: 'error', error: message, finishedAt: new Date() } });
    throw error;
  }
};

const RECENT_RUNS = 14;

const mapRun = (run: SyncRunRow) => ({
  startedAt: run.startedAt.toISOString(),
  finishedAt: run.finishedAt?.toISOString() ?? null,
  status: run.status,
  error: run.error,
  fetched: run.fetched,
  created: run.created,
  updated: run.updated,
  warnings: listOpenWarnings(run.warnings),
});

export const describeSyncStatus = async (db: Db): Promise<SyncSourceStatus[]> => {
  const ledger = await loadLedger(db);
  const checks = groupChecksBySource(await listBalanceChecks({ db, ledger }));
  return Promise.all(
    Object.values(SYNC_PROVIDERS).map(async (provider) => {
      const [recentRuns, lastSuccess, connection] = await Promise.all([
        db.syncRun.findMany({ where: { source: provider.source }, orderBy: { startedAt: 'desc' }, take: RECENT_RUNS }),
        db.syncRun.findFirst({ where: { source: provider.source, status: 'ok' }, orderBy: { startedAt: 'desc' } }),
        db.connection.findUnique({ where: { source: provider.source } }),
      ]);
      const [lastRun] = recentRuns;
      return {
        source: provider.source,
        configured: provider.isConfigured(),
        lastRun: lastRun === undefined ? null : mapRun(lastRun),
        lastSuccessAt: lastSuccess?.finishedAt?.toISOString() ?? null,
        consentValidUntil: connection?.validUntil?.toISOString() ?? null,
        recentRuns: recentRuns.map(mapRun),
        checks: checks.get(provider.source) ?? [],
      };
    }),
  );
};
