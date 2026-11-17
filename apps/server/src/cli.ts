import { readFile, stat } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { IsoDateSchema, SyncSourceSchema } from '@hroshi/schema';

import { findToday } from './clock.ts';
import { prisma } from './db.ts';
import { sendDigest } from './digest/send.ts';
import { listTelegramChats } from './telegram.ts';
import { env } from './env.ts';
import { importNbuRates } from './fx/nbu.ts';
import { fetchIbkrStatement, importBrokerFile } from './brokers/import.ts';
import { seedFromHandover } from './seed/handover.ts';
import { createEnableBankingClient } from './sync/enable-banking/client.ts';
import { completeRevolutConsent } from './sync/enable-banking/consent.ts';
import { pullRevolutHistory } from './sync/enable-banking/provider.ts';
import { parseConsentRedirect } from './sync/enable-banking/redirect.ts';
import { reingestRevolut } from './sync/enable-banking/reingest.ts';
import { linkStrayInflows } from './sync/ingest.ts';
import { backfillMono } from './sync/mono/backfill.ts';
import { importFiles } from './sync/files.ts';
import { recordSyncRun, runSync } from './sync/runner.ts';
import type { ImportFile } from './sync/types.ts';

const DEFAULT_DATA_DIR = resolve(import.meta.dirname, '../../../data');

const USAGE = `Usage: pnpm cli <command>
  seed [dataDir]          import the handover data (accounts, November, history, settings)
  import:mono <file> [--dry-run]    back-fill from a mono_export.py file
  backfill:mono <from> [to]  pull Mono history window by window (one call a minute; resumable)
  import:binance <dir> [--dry-run]  P2P orders and wallet value from a Binance export folder
  import:freedom24 <file> [--dry-run]  keep a Freedom24 report (*_all.json) for the investments page
  sync <source>           run one sync now (mono, revolut, binance, ibkr)
  eb:aspsps <country>     banks Enable Banking offers in a country (to find Revolut's exact name)
  digest:day [YYYY-MM-DD] [--send]  render the budget report (the month up to yesterday, or up to the given day)
  digest:week [to] [--send]  render the weekly infographic (last full week, or the week ending on <to>)
  digest:month [YYYY-MM] [--send]  render the monthly infographic (last month by default)
  telegram:chats          chats that wrote to the bot, to find TELEGRAM_CHAT_ID
  fx:nbu <from> [to]      daily NBU rates (UAH, USD, USDT, GBP per EUR) for the period; existing days are kept
  broker:import <freedom24|binance> <file>  keep a broker statement (Freedom24 *_all.json, Binance balances.json)
  broker:ibkr             fetch today's IBKR Flex statement (positions, cash records, daily NAV) into data/brokers
  eb:complete <url>       finish Revolut consent from the address the bank redirected to
  reingest:revolut        rebuild Revolut-created rows from their stored bank lines
  link:inflows            pair transfers with the top-up line the receiving bank booked`;

const requireArgument = (value: string | undefined, name: string): string => {
  if (value === undefined) throw new Error(`Missing <${name}>\n${USAGE}`);
  return resolve(value);
};

const readImportFile = async (path: string): Promise<ImportFile> => {
  const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  return { name: basename(path), modified: stats.mtime, content: JSON.parse(content) };
};

/** The import screen's path, so a file behaves the same from the terminal: `--dry-run` only reports. */
const importFromDisk = async ({ kind, paths, args }: { kind: 'mono' | 'binance' | 'freedom24'; paths: string[]; args: string[] }) =>
  importFiles({
    db: prisma,
    kind,
    files: await Promise.all(paths.map(readImportFile)),
    dryRun: args.includes('--dry-run'),
    log: console.log,
  });

const runCommand = async ([command, ...args]: string[]) => {
  switch (command) {
    case 'seed':
      return seedFromHandover({ db: prisma, dataDir: args[0] ?? DEFAULT_DATA_DIR });
    case 'import:mono':
      return importFromDisk({ kind: 'mono', paths: [requireArgument(args[0], 'file')], args });
    case 'import:binance': {
      const dir = requireArgument(args[0], 'dir');
      return importFromDisk({ kind: 'binance', paths: [join(dir, 'p2p_completed.json'), join(dir, 'balances.json')], args });
    }
    case 'import:freedom24':
      return importFromDisk({ kind: 'freedom24', paths: [requireArgument(args[0], 'file')], args });
    case 'backfill:mono':
      return backfillMono({
        db: prisma,
        from: IsoDateSchema.parse(args[0]),
        to: IsoDateSchema.parse(args[1] ?? '2026-08-01'),
        dir: resolve(DEFAULT_DATA_DIR, 'mono/backfill'),
        log: (message) => console.log(`${new Date().toISOString()} ${message}`),
      });
    case 'sync':
      return runSync({ db: prisma, source: SyncSourceSchema.parse(args[0]), log: console.log });
    case 'eb:complete': {
      const redirect = parseConsentRedirect(args[0] ?? '');
      if (redirect === undefined) throw new Error('Pass the address the bank redirected to; it carries code= and state=');
      await completeRevolutConsent({ db: prisma, ...redirect });
      return recordSyncRun({ db: prisma, source: 'revolut', task: () => pullRevolutHistory(prisma) });
    }
    case 'reingest:revolut':
      return recordSyncRun({ db: prisma, source: 'revolut', task: () => reingestRevolut(prisma) });
    case 'link:inflows':
      return { linked: await linkStrayInflows(prisma) };
    case 'digest:day':
      return sendDigest({
        db: prisma,
        kind: 'day',
        today: findToday(),
        to: args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg)),
        send: args.includes('--send'),
        outDir: resolve(DEFAULT_DATA_DIR, 'digests'),
      });
    case 'digest:week': {
      const to = args.find((arg) => /^\d{4}-\d{2}-\d{2}$/.test(arg));
      return sendDigest({
        db: prisma,
        kind: 'week',
        today: to === undefined ? findToday() : undefined,
        to,
        send: args.includes('--send'),
        outDir: resolve(DEFAULT_DATA_DIR, 'digests'),
      });
    }
    case 'digest:month': {
      const month = args.find((arg) => /^\d{4}-\d{2}$/.test(arg));
      return sendDigest({
        db: prisma,
        kind: 'month',
        today: findToday(),
        to: month === undefined ? undefined : `${month}-28`,
        send: args.includes('--send'),
        outDir: resolve(DEFAULT_DATA_DIR, 'digests'),
      });
    }
    case 'broker:import': {
      const broker = args[0];
      if (broker !== 'freedom24' && broker !== 'binance') throw new Error(`Unknown broker "${broker ?? ''}"\n${USAGE}`);
      return importBrokerFile({ broker, path: requireArgument(args[1], 'file') });
    }
    case 'broker:ibkr':
      return fetchIbkrStatement({ date: findToday() });
    case 'fx:nbu':
      return importNbuRates({
        db: prisma,
        from: IsoDateSchema.parse(args[0]),
        to: IsoDateSchema.parse(args[1] ?? findToday()),
      });
    case 'telegram:chats':
      if (env.TELEGRAM_BOT_TOKEN === undefined) throw new Error('TELEGRAM_BOT_TOKEN is not set');
      return listTelegramChats(env.TELEGRAM_BOT_TOKEN);
    case 'eb:aspsps': {
      const client = await createEnableBankingClient();
      const { aspsps } = await client.listAspsps(args[0] ?? 'ES');
      return aspsps.map((aspsp) => `${aspsp.name} (${aspsp.country})`);
    }
    default:
      console.error(USAGE);
      process.exitCode = 1;
      return undefined;
  }
};

try {
  const result = await runCommand(process.argv.slice(2));
  if (result !== undefined) console.log(result);
} finally {
  await prisma.$disconnect();
}
