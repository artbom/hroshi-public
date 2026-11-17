import { existsSync } from 'node:fs';
import { mkdir, readFile, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import type { IsoDate } from '@hroshi/schema';
import { z } from 'zod';

import type { Db } from '../../db.ts';
import { env } from '../../env.ts';
import { ingestStatement } from '../ingest.ts';
import { recordSyncRun } from '../runner.ts';
import type { StatementItem } from '../statement.ts';
import { linkMonoAccounts } from './accounts.ts';
import { createMonoClient, MAX_STATEMENT_WINDOW_S, type MonoStatementItem, MonoStatementItemSchema } from './client.ts';
import { pairOwnCardTransfers, routeFopSalesThroughUah } from './own-cards.ts';
import { mapMonoItem } from './statement.ts';

/** One file per window keeps progress across restarts and lets the lines be re-imported later. */
const WindowFileSchema = z.object({
  from: z.number(),
  to: z.number(),
  statements: z.record(z.string(), z.array(MonoStatementItemSchema)),
});

const toUnix = (date: IsoDate) => Math.floor(Date.parse(`${date}T00:00:00Z`) / 1000);

/** Newest first: the months the owner never tracked come in before the ones ZenMoney already has. */
const listWindows = ({ from, to }: { from: IsoDate; to: IsoDate }) => {
  const windows: { from: number; to: number }[] = [];
  for (let end = toUnix(to); end > toUnix(from); end -= MAX_STATEMENT_WINDOW_S) {
    windows.push({ from: Math.max(toUnix(from), end - MAX_STATEMENT_WINDOW_S), to: end - 1 });
  }
  return windows;
};

/**
 * Pulls Mono statements for a past period one 31-day window at a time (all accounts per window,
 * so own-card legs pair up), stores each window under `dir` and ingests it straight away.
 * Lines before an account's opening date are history, so balances never move.
 */
export const backfillMono = async ({
  db,
  from,
  to,
  dir,
  log,
}: {
  db: Db;
  from: IsoDate;
  to: IsoDate;
  dir: string;
  log: (message: string) => void;
}) => {
  if (env.MONO_TOKEN === undefined) throw new Error('MONO_TOKEN is not set');
  await mkdir(dir, { recursive: true });
  const client = createMonoClient({ token: env.MONO_TOKEN });
  const { accounts } = await client.fetchClientInfo();
  const linked = await linkMonoAccounts({ db, monoAccounts: accounts, log });

  for (const window of listWindows({ from, to })) {
    const label = `${new Date(window.from * 1000).toISOString().slice(0, 10)}…${new Date(window.to * 1000).toISOString().slice(0, 10)}`;
    const file = join(dir, `${window.from}.json`);
    const statements = new Map<string, MonoStatementItem[]>();

    if (existsSync(file)) {
      const saved = WindowFileSchema.parse(JSON.parse(await readFile(file, 'utf8')));
      for (const [accountId, items] of Object.entries(saved.statements)) statements.set(accountId, items);
    } else {
      for (const account of accounts.filter((candidate) => linked.has(candidate.id))) {
        try {
          statements.set(account.id, await client.fetchStatement({ accountId: account.id, from: window.from, to: window.to }));
        } catch (error) {
          log(`${label} ${account.type}/${account.currencyCode}: ${error instanceof Error ? error.message : String(error)}`);
          statements.set(account.id, []);
        }
      }
      await writeFile(file, JSON.stringify({ ...window, statements: Object.fromEntries(statements) }));
    }

    const paired = pairOwnCardTransfers({ monoAccounts: accounts, statements: routeFopSalesThroughUah({ monoAccounts: accounts, statements }) });
    const items: StatementItem[] = [...paired].flatMap(([monoAccountId, lines]) => {
      const accountId = linked.get(monoAccountId);
      return accountId === undefined ? [] : lines.map((item) => mapMonoItem({ item, accountId }));
    });
    const counts = await recordSyncRun({
      db,
      source: 'mono',
      task: () => ingestStatement({ db, source: 'mono', items }),
    });
    log(`${label}: ${items.length} lines, ${counts.created} new, ${counts.updated} linked`);
  }
};
