import { z } from 'zod';

import type { Db } from '../../db.ts';
import { env } from '../../env.ts';
import { previewStatement } from '../preview.ts';
import { ingestStatement } from '../ingest.ts';
import type { StatementItem } from '../statement.ts';
import type { ImportPlan, SyncCounts, SyncProvider } from '../types.ts';
import { linkMonoAccounts, reconcileMonoBalances, resolveMonoAccountId } from './accounts.ts';
import { createMonoClient, MAX_STATEMENT_WINDOW_S, MonoAccountSchema, MonoStatementItemSchema } from './client.ts';
import { pairOwnCardTransfers, routeFopSalesThroughUah } from './own-cards.ts';
import { mapMonoItem } from './statement.ts';

/** Overlapping a week catches late-settling holds and a missed day; linked lines are skipped. */
const LOOKBACK_S = 7 * 24 * 3600;

/** Statement lines as ingestion takes them: own-card legs paired, ФОП sales routed through ФОП UAH. */
const buildMonoItems = ({
  monoAccounts,
  statements,
  linked,
}: {
  monoAccounts: readonly z.infer<typeof MonoAccountSchema>[];
  statements: ReadonlyMap<string, z.infer<typeof MonoStatementItemSchema>[]>;
  linked: ReadonlyMap<string, string>;
}): StatementItem[] => {
  const paired = pairOwnCardTransfers({ monoAccounts, statements: routeFopSalesThroughUah({ monoAccounts, statements }) });
  return [...paired].flatMap(([monoAccountId, lines]) => {
    const accountId = linked.get(monoAccountId);
    return accountId === undefined ? [] : lines.map((item) => mapMonoItem({ item, accountId }));
  });
};

const ingestMonoLines = async ({
  db,
  monoAccounts,
  statements,
  log,
}: {
  db: Db;
  monoAccounts: z.infer<typeof MonoAccountSchema>[];
  statements: ReadonlyMap<string, z.infer<typeof MonoStatementItemSchema>[]>;
  log: (message: string) => void;
}): Promise<SyncCounts> => {
  const linked = await linkMonoAccounts({ db, monoAccounts, log });
  const items = buildMonoItems({ monoAccounts, statements, linked });
  const counts = await ingestStatement({ db, source: 'mono', items });
  const warnings = await reconcileMonoBalances({ db, monoAccounts });
  for (const warning of warnings) log(warning);
  return { ...counts, warnings };
};

export const monoProvider: SyncProvider = {
  source: 'mono',
  isConfigured: () => env.MONO_TOKEN !== undefined,
  run: async ({ db, log }) => {
    if (env.MONO_TOKEN === undefined) throw new Error('MONO_TOKEN is not set');
    const client = createMonoClient({ token: env.MONO_TOKEN });
    const { accounts } = await client.fetchClientInfo();
    const to = Math.floor(Date.now() / 1000);
    const from = to - Math.min(LOOKBACK_S, MAX_STATEMENT_WINDOW_S);

    const statements = new Map<string, z.infer<typeof MonoStatementItemSchema>[]>();
    for (const account of accounts) {
      log(`fetching ${account.type}/${account.currencyCode}`);
      statements.set(account.id, await client.fetchStatement({ accountId: account.id, from, to }));
    }
    return ingestMonoLines({ db, monoAccounts: accounts, statements, log });
  },
};

const MonoExportSchema = z.object({
  accounts: z.array(MonoAccountSchema),
  statements: z.record(z.string(), z.array(MonoStatementItemSchema)),
});

/** Back-fills from the file written by docs/mono_export.py (same lines the API returns). */
export const planMonoImport = async ({
  db,
  content,
  log,
}: {
  db: Db;
  content: unknown;
  log: (message: string) => void;
}): Promise<ImportPlan> => {
  const file = MonoExportSchema.parse(content);
  const statements = new Map(Object.entries(file.statements));
  const known = new Set((await db.account.findMany({ select: { id: true } })).map((account) => account.id));
  // Read-only twin of linkMonoAccounts: an account the tracker lacks is only created by the import itself.
  const linked = new Map(
    file.accounts.flatMap((account) => {
      const id = resolveMonoAccountId(account);
      return id === undefined || !known.has(id) ? [] : [[account.id, id] as const];
    }),
  );
  const lines = [...statements.values()].reduce((sum, list) => sum + list.length, 0);
  const preview = await previewStatement({ db, source: 'mono', items: buildMonoItems({ monoAccounts: file.accounts, statements, linked }) });
  const notes = file.accounts.flatMap((account) => {
    const count = statements.get(account.id)?.length ?? 0;
    if (linked.has(account.id) || count === 0) return [];
    const label = `Mono ${account.type}/${account.currencyCode}`;
    return resolveMonoAccountId(account) === undefined
      ? [`${label}: трекер такого рахунку не веде, його рядки пропускаються (${count})`]
      : [`${label}: рахунку ще немає, імпорт створить його; його рядки тут не пораховано (${count})`];
  });
  return {
    preview: { lines, ...preview, skipped: lines - preview.added - preview.known - preview.dismissed, notes },
    source: 'mono',
    apply: () => ingestMonoLines({ db, monoAccounts: file.accounts, statements, log }),
  };
};
