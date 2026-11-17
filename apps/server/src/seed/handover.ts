import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { join } from 'node:path';

import {
  CurrencySchema,
  IsoDateSchema,
  type AccountKind,
  type Currency,
  type IsoDate,
  TransactionTypeSchema,
} from '@hroshi/schema';
import { z } from 'zod';

import type { Db } from '../db.ts';
import type { Prisma } from '../generated/prisma/client.ts';
import { fromIsoDate } from '../mappers.ts';
import { CATEGORY_SEEDS } from './categories.ts';
import { RULE_SEEDS } from './rules.ts';

const HandoverAccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  currency: CurrencySchema,
  opening: z.number(),
  openingDate: IsoDateSchema,
  order: z.number().int(),
  kind: z.enum(['investment', 'receivable']).optional(),
  bank: z.string().optional(),
  creditLimit: z.number().optional(),
  credit: z.boolean().optional(),
  note: z.string().optional(),
});

const HandoverTransactionSchema = z.object({
  id: z.string().min(1),
  type: TransactionTypeSchema,
  date: IsoDateSchema,
  accountId: z.string().min(1),
  amount: z.number(),
  currency: CurrencySchema,
  toAccountId: z.string().optional(),
  toAmount: z.number().optional(),
  category: z.string().optional(),
  note: z.string().optional(),
  createdAt: z.iso.datetime(),
});

export const HistoryRowSchema = z.object({
  d: IsoDateSchema,
  t: z.enum(['e', 'i', 'x']),
  a: z.string().min(1),
  am: z.number().positive(),
  c: CurrencySchema,
  cat: z.string().optional(),
  n: z.string().optional(),
  ta: z.string().optional(),
  tam: z.number().optional(),
  tc: CurrencySchema.optional(),
});
type HistoryRow = z.infer<typeof HistoryRowSchema>;

const SettingsSchema = z.object({
  limits: z.record(z.string(), z.number().positive()),
  rates: z.partialRecord(CurrencySchema, z.number().positive()),
  ratesByYear: z.record(z.string().regex(/^\d{4}$/), z.partialRecord(CurrencySchema, z.number().positive())),
});

/** The date the handover's "current" rates were taken. */
const HANDOVER_RATES_DATE: IsoDate = '2026-11-11';
/** Opening date for accounts that only exist in history or were added at handover. */
const HANDOVER_OPENING_DATE: IsoDate = '2026-11-01';

type ExtraAccount = {
  id: string;
  name: string;
  currency: Currency;
  kind: AccountKind;
  order: number;
  bank?: string;
  archived?: boolean;
  passThrough?: boolean;
  note?: string;
};

/** ФОП UAH is tracked so synced ФОП USD → UAH → card legs stay exact; it is hidden while empty. */
const EXTRA_ACCOUNTS: readonly ExtraAccount[] = [
  { id: 'fop-uah', name: 'ФОП UAH', currency: 'UAH', kind: 'everyday', order: 2, bank: 'Monobank', passThrough: true },
  { id: 'cash-uah', name: 'Готівка UAH', currency: 'UAH', kind: 'cash', order: 90, archived: true },
  { id: 'cash-usd', name: 'Готівка USD', currency: 'USD', kind: 'cash', order: 91, archived: true },
  { id: 'mono-jar', name: 'Mono банка', currency: 'UAH', kind: 'everyday', order: 92, archived: true },
  { id: 'debts', name: 'Борги', currency: 'EUR', kind: 'receivable', order: 93, archived: true },
  { id: 'dukascopy-usd', name: 'Dukascopy USD', currency: 'USD', kind: 'investment', order: 94, archived: true },
  { id: 'dukascopy-eur', name: 'Dukascopy EUR', currency: 'EUR', kind: 'investment', order: 95, archived: true },
  { id: 'crypto', name: 'Crypto', currency: 'USD', kind: 'investment', order: 96, archived: true },
];

/** ZenMoney account names → account ids. */
const HISTORY_ACCOUNT_IDS: Readonly<Record<string, string>> = {
  'Mono кредитка': 'mono-credit',
  'Mono біла': 'mono-uah',
  'Mono EUR': 'mono-eur',
  'Mono USD': 'mono-usd',
  'ФОП USD': 'fop-usd',
  'ФОП EUR': 'fop-eur',
  'ФОП UAH': 'fop-uah',
  'Revolut EUR': 'revolut-eur',
  'Santander EUR': 'santander-eur',
  'Готівка EUR': 'cash-eur',
  'Готівка UAH': 'cash-uah',
  'Готівка USD': 'cash-usd',
  'Mono банка': 'mono-jar',
  Борги: 'debts',
  'Dukascopy USD': 'dukascopy-usd',
  'Dukascopy EUR': 'dukascopy-eur',
  Crypto: 'crypto',
  Freedom24: 'freedom24',
  Binance: 'binance',
  'Брокер': 'ibkr',
};

const HISTORY_TYPES = { e: 'expense', i: 'income', x: 'transfer' } as const;

/** Seeds are matched by what they match on, so re-seeding adds new rules without duplicating edited ones. */
const createRuleKey = (rule: { pattern?: string | null; mcc?: number | null }) => `${rule.pattern ?? ''}|${rule.mcc ?? ''}`;

const readJson = async <TSchema extends z.ZodType>(path: string, schema: TSchema): Promise<z.infer<TSchema>> =>
  schema.parse(JSON.parse(await readFile(path, 'utf8')));

const resolveAccountKind = (account: z.infer<typeof HandoverAccountSchema>): AccountKind => {
  if (account.kind !== undefined) return account.kind;
  if (account.creditLimit !== undefined || account.credit === true) return 'credit';
  if (account.bank === 'Cash') return 'cash';
  return 'everyday';
};

const resolveHistoryAccountId = (name: string): string => {
  const id = HISTORY_ACCOUNT_IDS[name];
  if (id === undefined) throw new Error(`History account "${name}" has no mapping`);
  return id;
};

/** History rows have no ids; a content hash plus the repeat count keeps re-seeding idempotent. */
export const createHistoryIds = (rows: readonly HistoryRow[]): string[] => {
  const seen = new Map<string, number>();
  return rows.map((row) => {
    const key = JSON.stringify(row);
    const occurrence = seen.get(key) ?? 0;
    seen.set(key, occurrence + 1);
    return `zen-${createHash('sha1').update(`${key}#${occurrence}`).digest('hex').slice(0, 20)}`;
  });
};

const mapHistoryRow = (row: HistoryRow, id: string): Prisma.TransactionCreateManyInput => ({
  id,
  type: HISTORY_TYPES[row.t],
  date: fromIsoDate(row.d),
  accountId: resolveHistoryAccountId(row.a),
  amount: row.am,
  currency: row.c,
  toAccountId: row.ta === undefined ? null : resolveHistoryAccountId(row.ta),
  toAmount: row.t === 'x' ? (row.tam ?? 0) : null,
  toCurrency: row.tc ?? null,
  category: row.cat ?? null,
  note: row.n ?? null,
  source: 'zenmoney',
});

export const seedFromHandover = async ({ db, dataDir }: { db: Db; dataDir: string }) => {
  const [accounts, transactions, history, settings] = await Promise.all([
    readJson(join(dataDir, 'accounts.json'), z.array(HandoverAccountSchema)),
    readJson(join(dataDir, 'transactions_2026-11.json'), z.array(HandoverTransactionSchema)),
    readJson(join(dataDir, 'history_2021-12_to_2026-10.json'), z.array(HistoryRowSchema)),
    readJson(join(dataDir, 'settings.json'), SettingsSchema),
  ]);

  for (const [order, seed] of CATEGORY_SEEDS.entries()) {
    await db.category.upsert({
      where: { name: seed.name },
      create: { ...seed, order, monthlyLimitEur: settings.limits[seed.name] ?? null },
      update: {},
    });
  }

  for (const account of accounts) {
    const fields = {
      name: account.name,
      currency: account.currency,
      kind: resolveAccountKind(account),
      bank: account.bank ?? null,
      openingBalance: account.opening,
      openingDate: fromIsoDate(account.openingDate),
      creditLimit: account.creditLimit ?? null,
      order: account.order,
      note: account.note ?? null,
    };
    await db.account.upsert({ where: { id: account.id }, create: { id: account.id, ...fields }, update: fields });
  }

  for (const { id, ...account } of EXTRA_ACCOUNTS) {
    await db.account.upsert({
      where: { id },
      create: { id, ...account, openingBalance: 0, openingDate: fromIsoDate(HANDOVER_OPENING_DATE) },
      update: {},
    });
  }

  const knownRules = new Set((await db.rule.findMany()).map(createRuleKey));
  await db.rule.createMany({
    data: RULE_SEEDS.filter((rule) => !knownRules.has(createRuleKey(rule))).map((rule) => ({
      pattern: rule.pattern ?? null,
      mcc: rule.mcc ?? null,
      accountId: rule.accountId ?? null,
      category: rule.category ?? null,
      transferToAccountId: rule.transferToAccountId ?? null,
      priority: rule.priority ?? 100,
      note: rule.note ?? null,
    })),
  });

  await db.yearlyRate.createMany({
    data: Object.entries(settings.ratesByYear).flatMap(([year, rates]) =>
      Object.entries(rates).map(([currency, perEur]) => ({
        year: Number(year),
        currency: CurrencySchema.parse(currency),
        perEur,
      })),
    ),
    skipDuplicates: true,
  });
  await db.fxRate.createMany({
    data: Object.entries(settings.rates)
      .filter(([currency]) => currency !== 'EUR')
      .map(([currency, perEur]) => ({
        date: fromIsoDate(HANDOVER_RATES_DATE),
        currency: CurrencySchema.parse(currency),
        perEur,
        source: 'handover',
      })),
    skipDuplicates: true,
  });

  const created = await db.transaction.createMany({
    data: transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      date: fromIsoDate(transaction.date),
      accountId: transaction.accountId,
      amount: transaction.amount,
      currency: transaction.currency,
      toAccountId: transaction.toAccountId ?? null,
      toAmount: transaction.toAmount ?? null,
      toCurrency:
        transaction.toAccountId === undefined
          ? null
          : (accounts.find((account) => account.id === transaction.toAccountId)?.currency ?? null),
      category: transaction.category ?? null,
      note: transaction.note ?? null,
      source: 'claude',
      createdAt: new Date(transaction.createdAt),
    })),
    skipDuplicates: true,
  });

  const historyIds = createHistoryIds(history);
  const importedHistory = await db.transaction.createMany({
    data: history.map((row, index) => mapHistoryRow(row, historyIds[index] ?? '')),
    skipDuplicates: true,
  });

  return { accounts: accounts.length, transactions: created.count, history: importedHistory.count };
};
