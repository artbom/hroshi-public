import { computeBalanceHistory, roundAmount } from '@hroshi/domain';
import { type Account, type BalanceCheck, type IsoDate, SyncSourceSchema } from '@hroshi/schema';
import { z } from 'zod';

import { ACCOUNT_BY_BROKER, loadBrokerReports } from '../brokers/reports.ts';
import { readLatestBrokerFile } from '../brokers/store.ts';
import type { Db } from '../db.ts';
import type { Ledger } from '../ledger.ts';
import { toLocalDate } from './statement.ts';

/** Below a cent the balances agree. */
export const BALANCE_TOLERANCE = 0.01;
/**
 * A wallet priced at market (crypto, a broker's positions) moves between the moment it was read
 * and the end of that day; a gap this small is the price, not a missing row.
 */
const MARKET_TOLERANCE_SHARE = 0.001;

const MISMATCH = /^(?<name>.+): у трекері (?<tracker>\S+), у банку (?<bank>\S+) \(різниця (?<difference>\S+)\)$/u;

/** The one line a sync run stores for a balance it compared; read back by `parseBalanceMismatch`. */
export const describeBalanceMismatch = ({ name, tracker, bank }: { name: string; tracker: number; bank: number }) =>
  `${name}: у трекері ${tracker}, у банку ${bank} (різниця ${roundAmount(tracker - bank)})`;

export const parseBalanceMismatch = (warning: string) => {
  const groups = MISMATCH.exec(warning)?.groups;
  if (groups === undefined) return undefined;
  const [tracker, bank, difference] = [groups['tracker'], groups['bank'], groups['difference']].map(Number);
  const name = groups['name'];
  if (name === undefined || tracker === undefined || bank === undefined || difference === undefined) return undefined;
  if (![tracker, bank, difference].every(Number.isFinite)) return undefined;
  return { name, tracker, bank, difference };
};

const formatAmount = (value: number) => value.toLocaleString('uk-UA', { maximumFractionDigits: 2 });

/** A stored mismatch line as the owner reads it: decimal commas, no float noise. */
const humanizeWarning = (warning: string): string => {
  const mismatch = parseBalanceMismatch(warning);
  if (mismatch === undefined) return warning;
  return `${mismatch.name}: у трекері ${formatAmount(mismatch.tracker)}, у банку ${formatAmount(mismatch.bank)} (різниця ${formatAmount(mismatch.difference)})`;
};

/** Run warnings worth reading: a balance that matched is a check («✓»), not a warning. */
export const listOpenWarnings = (warnings: readonly string[]): string[] =>
  warnings
    .filter((warning) => {
      const mismatch = parseBalanceMismatch(warning);
      return mismatch === undefined || Math.abs(mismatch.difference) >= BALANCE_TOLERANCE;
    })
    .map(humanizeWarning);

type CheckInput = Pick<BalanceCheck, 'source' | 'basis' | 'checkedAt'> & { account: Account; bank: number; tracker: number };

const buildCheck = ({ account, bank, tracker, ...rest }: CheckInput): BalanceCheck => {
  const difference = roundAmount(tracker - bank);
  const tolerance =
    account.kind === 'investment' ? Math.max(BALANCE_TOLERANCE, roundAmount(Math.abs(bank) * MARKET_TOLERANCE_SHARE)) : BALANCE_TOLERANCE;
  return {
    ...rest,
    accountId: account.id,
    accountName: account.name,
    bankBalance: bank,
    trackerBalance: tracker,
    difference,
    tolerance,
    matches: Math.abs(difference) < tolerance,
  };
};

/** The tracker's balance at the end of a day, from the ledger as it is now. */
const computeTrackerBalance = ({ ledger, account, date }: { ledger: Ledger; account: Account; date: IsoDate }): number => {
  const [balance] = computeBalanceHistory({ accounts: [account], transactions: ledger.transactions, dates: [date] }).get(account.id) ?? [];
  return balance ?? account.openingBalance;
};

/** Broker statements describe a day, not a moment; noon keeps that day in every time zone. */
const describeDay = (date: IsoDate) => new Date(`${date}T12:00:00Z`).toISOString();

const StatementLineSchema = z.object({
  accountId: z.string(),
  time: z.coerce.number(),
  balance: z.coerce.number(),
});

/**
 * Monobank prints the balance after every line, so the newest stored line tells what the bank
 * held at that moment; the tracker is compared at the end of that day.
 */
const checkStatementBalances = async ({ db, ledger }: { db: Db; ledger: Ledger }): Promise<BalanceCheck[]> => {
  const lines = z.array(StatementLineSchema).parse(
    await db.$queryRaw`
      select distinct on ("accountId") "accountId", time, balance from (
        select case when type = 'transfer' and (raw->>'amount')::numeric > 0 then "toAccountId" else "accountId" end as "accountId",
               (raw->>'time')::bigint as time,
               (raw->>'balance')::bigint as balance
        from "Transaction"
        where raw->>'time' is not null and raw->>'balance' is not null
      ) lines
      order by "accountId", time desc`,
  );
  const accounts = new Map(ledger.accounts.map((account) => [account.id, account]));

  return lines.flatMap((line): BalanceCheck[] => {
    const account = accounts.get(line.accountId);
    if (account === undefined || account.syncSource !== 'mono') return [];
    const moment = new Date(line.time * 1000);
    return [
      buildCheck({
        account,
        source: 'mono',
        basis: 'statement',
        checkedAt: moment.toISOString(),
        bank: roundAmount(line.balance / 100 - (account.creditLimit ?? 0)),
        tracker: computeTrackerBalance({ ledger, account, date: toLocalDate(moment) }),
      }),
    ];
  });
};

/**
 * What the newest run of each source reported the bank held (Revolut balances, the Binance wallet
 * total). The tracker side is recomputed for that day, so a row added later still shows up.
 */
const checkSyncReports = async ({ db, ledger }: { db: Db; ledger: Ledger }): Promise<BalanceCheck[]> => {
  const accountsByName = new Map(ledger.accounts.map((account) => [account.name, account]));
  const runs = await Promise.all(
    SyncSourceSchema.options.map(async (source) => ({
      source,
      run: await db.syncRun.findFirst({ where: { source, status: 'ok' }, orderBy: { startedAt: 'desc' } }),
    })),
  );
  return runs.flatMap(({ source, run }) => {
    if (run === null) return [];
    const moment = run.finishedAt ?? run.startedAt;
    return run.warnings.flatMap((warning): BalanceCheck[] => {
      const mismatch = parseBalanceMismatch(warning);
      const account = mismatch === undefined ? undefined : accountsByName.get(mismatch.name);
      if (mismatch === undefined || account === undefined) return [];
      return [
        buildCheck({
          account,
          source,
          basis: 'sync',
          checkedAt: moment.toISOString(),
          bank: mismatch.bank,
          tracker: computeTrackerBalance({ ledger, account, date: toLocalDate(moment) }),
        }),
      ];
    });
  });
};

/** A broker's statement states its net assets on a day; the tracker should hold the same then. */
const checkBrokerStatements = async ({ ledger }: { ledger: Ledger }): Promise<BalanceCheck[]> => {
  const reports = await loadBrokerReports();
  return ledger.accounts.flatMap((account): BalanceCheck[] => {
    const report = reports.get(account.id);
    if (report === undefined || report.netAssets === null) return [];
    return [
      buildCheck({
        account,
        source: report.broker,
        basis: 'broker',
        checkedAt: describeDay(report.asOf),
        bank: roundAmount(report.netAssets),
        tracker: computeTrackerBalance({ ledger, account, date: report.asOf }),
      }),
    ];
  });
};

const WalletExportSchema = z.object({
  wallets_usdt: z.array(z.object({ balance: z.coerce.number() })),
});

/** The Binance export names each wallet's total in USDT; their sum is what the account holds. */
const checkBinanceWallets = async ({ ledger }: { ledger: Ledger }): Promise<BalanceCheck[]> => {
  const account = ledger.accounts.find((candidate) => candidate.id === ACCOUNT_BY_BROKER.binance);
  const file = await readLatestBrokerFile('binance');
  // The export carries no date of its own; the import names the file after the day it was true.
  const asOf = file?.name.match(/\d{4}-\d{2}-\d{2}/u)?.[0];
  if (account === undefined || file === undefined || asOf === undefined) return [];
  let content: unknown;
  try {
    content = JSON.parse(file.content);
  } catch {
    return [];
  }
  const parsed = WalletExportSchema.safeParse(content);
  if (!parsed.success) return [];
  return [
    buildCheck({
      account,
      source: 'binance',
      basis: 'wallet',
      checkedAt: describeDay(asOf),
      bank: roundAmount(parsed.data.wallets_usdt.reduce((sum, wallet) => sum + wallet.balance, 0)),
      tracker: computeTrackerBalance({ ledger, account, date: asOf }),
    }),
  ];
};

/**
 * One check per account: the Mono statement where it exists (it is exact to the line), else the
 * newest of the broker's file, the wallet export and the last sync report.
 */
export const listBalanceChecks = async ({ db, ledger }: { db: Db; ledger: Ledger }): Promise<BalanceCheck[]> => {
  const [statement, ...others] = await Promise.all([
    checkStatementBalances({ db, ledger }),
    checkBrokerStatements({ ledger }),
    checkBinanceWallets({ ledger }),
    checkSyncReports({ db, ledger }),
  ]);
  const covered = new Set(statement.map((check) => check.accountId));
  const newest = new Map<string, BalanceCheck>();
  for (const check of others.flat()) {
    if (covered.has(check.accountId)) continue;
    const kept = newest.get(check.accountId);
    if (kept === undefined || check.checkedAt > kept.checkedAt) newest.set(check.accountId, check);
  }
  return [...statement, ...newest.values()];
};

export const groupChecksBySource = (checks: readonly BalanceCheck[]): ReadonlyMap<BalanceCheck['source'], BalanceCheck[]> =>
  Map.groupBy(checks, (check) => check.source);
