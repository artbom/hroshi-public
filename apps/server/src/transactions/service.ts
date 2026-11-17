import { aggregateMonths, indexCategoryLimits, toMonth } from '@hroshi/domain';
import type { CreateTransaction, Source, SplitTransaction, Transaction, TransactionSplit, UpdateTransaction } from '@hroshi/schema';

import type { Db } from '../db.ts';
import type { Account as AccountRow, Prisma, Transaction as TransactionRow } from '../generated/prisma/client.ts';
import { badRequest, conflict, notFound } from '../http-errors.ts';
import { loadLedger } from '../ledger.ts';
import { fromIsoDate, mapTransaction, toIsoDate, toNullableNumber, toNumber } from '../mappers.ts';

type Client = Db | Prisma.TransactionClient;

/** Soft limits stay quiet until a category reaches this share of its limit. */
const LIMIT_NOTICE_RATIO = 0.9;

const findAccount = async (db: Client, id: string): Promise<AccountRow> => {
  const account = await db.account.findUnique({ where: { id } });
  if (account === null) throw badRequest(`Unknown account "${id}"`);
  if (account.archived) throw badRequest(`Account "${account.name}" is archived`);
  return account;
};

const assertCategory = async ({ db, name, type }: { db: Client; name: string; type: 'expense' | 'income' }) => {
  const category = await db.category.findUnique({ where: { name } });
  if (category === null) throw badRequest(`Unknown category "${name}"`);
  // Income may use any category: a refund nets against the expense category it came from.
  if (type === 'expense' && !category.forExpense) throw badRequest(`"${name}" is an income category`);
};

type Shape = Pick<Transaction, 'type' | 'accountId' | 'amount' | 'toAccountId' | 'toAmount' | 'category'>;

/** Every write goes through here so manual, page and Claude entries obey the same invariants. */
const resolveTransactionFields = async (db: Client, shape: Shape) => {
  const account = await findAccount(db, shape.accountId);
  const base = { accountId: account.id, currency: account.currency };

  switch (shape.type) {
    case 'expense':
    case 'income': {
      if (shape.amount <= 0) throw badRequest('Amount must be positive; the type gives the sign');
      if (shape.category === null) throw badRequest(`An ${shape.type} needs a category`);
      await assertCategory({ db, name: shape.category, type: shape.type });
      return { ...base, toAccountId: null, toAmount: null, toCurrency: null, category: shape.category };
    }
    case 'transfer': {
      if (shape.amount <= 0) throw badRequest('Amount must be positive');
      if (shape.toAccountId === null) throw badRequest('A transfer needs a target account');
      const target = await findAccount(db, shape.toAccountId);
      if (target.id === account.id) throw badRequest('Choose two different accounts');
      if (target.currency !== account.currency && shape.toAmount === null) {
        throw badRequest(`Give the amount credited in ${target.currency} (0 if unknown)`);
      }
      return { ...base, toAccountId: target.id, toAmount: shape.toAmount, toCurrency: target.currency, category: null };
    }
    case 'valuation': {
      if (account.kind !== 'investment' && account.kind !== 'receivable') {
        throw badRequest('Valuations belong to investment and receivable accounts');
      }
      return { ...base, toAccountId: null, toAmount: null, toCurrency: null, category: null };
    }
  }
};

const toShape = (input: CreateTransaction): Shape => ({
  type: input.type,
  accountId: input.accountId,
  amount: input.amount,
  toAccountId: input.type === 'transfer' ? input.toAccountId : null,
  toAmount: input.type === 'transfer' ? (input.toAmount ?? null) : null,
  category: input.type === 'expense' || input.type === 'income' ? input.category : null,
});

const insertTransaction = async ({ db, input, source }: { db: Client; input: CreateTransaction; source: Source }) => {
  const fields = await resolveTransactionFields(db, toShape(input));
  const row = await db.transaction.create({
    data: {
      ...fields,
      type: input.type,
      date: fromIsoDate(input.date),
      amount: input.amount,
      note: input.note || null,
      tags: input.tags ?? [],
      source,
    },
  });
  return mapTransaction(row);
};

/** One line, only when an expense takes its category to the notice threshold or past its limit. */
const describeLimitNotices = async ({ db, created }: { db: Db; created: readonly Transaction[] }) => {
  const touched = created.filter((transaction) => transaction.type === 'expense' && transaction.category !== null);
  if (touched.length === 0) return [];
  const ledger = await loadLedger(db);
  const limits = indexCategoryLimits(ledger.categories);
  const keys = new Set(
    touched.flatMap((transaction) =>
      transaction.category !== null && limits.has(transaction.category)
        ? [`${toMonth(transaction.date)}|${transaction.category}`]
        : [],
    ),
  );

  return [...keys].flatMap((key) => {
    const [month = '', category = ''] = key.split('|');
    const limit = limits.get(category) ?? 0;
    const [stats] = aggregateMonths({
      months: [month],
      transactions: ledger.transactions,
      policies: ledger.policies,
      fx: ledger.fx,
      currentMonth: month,
    });
    const spent = Math.max(0, stats?.categories[category] ?? 0);
    if (spent < limit * LIMIT_NOTICE_RATIO) return [];
    const verdict = spent > limit ? 'понад орієнтир' : 'майже орієнтир';
    return [`${category}: ${Math.round(spent)} / ${limit} € за ${month}, ${verdict}.`];
  });
};

export const createTransaction = async ({ db, input, source }: { db: Db; input: CreateTransaction; source: Source }) => {
  const transaction = await insertTransaction({ db, input, source });
  const [notice = null] = await describeLimitNotices({ db, created: [transaction] });
  return { transaction, notice };
};

export const createTransactions = async ({
  db,
  items,
  source,
}: {
  db: Db;
  items: readonly CreateTransaction[];
  source: Source;
}) => {
  const transactions = await db.$transaction(async (client) => {
    const created: Transaction[] = [];
    for (const input of items) created.push(await insertTransaction({ db: client, input, source }));
    return created;
  });
  return { transactions, notices: await describeLimitNotices({ db, created: transactions }) };
};

/** Whether the patch moves money: a new type, date, account or amount, not just a re-sent current value. */
const changesShape = (existing: TransactionRow, patch: UpdateTransaction) =>
  (patch.type !== undefined && patch.type !== existing.type) ||
  (patch.date !== undefined && patch.date !== toIsoDate(existing.date)) ||
  (patch.accountId !== undefined && patch.accountId !== existing.accountId) ||
  (patch.amount !== undefined && patch.amount !== toNumber(existing.amount)) ||
  (patch.toAccountId !== undefined && patch.toAccountId !== existing.toAccountId) ||
  (patch.toAmount !== undefined && patch.toAmount !== toNullableNumber(existing.toAmount));

/** Parts must keep adding up to their bank line, so only the split itself moves money between them. */
const assertSplitKeepsShape = async ({ db, existing, patch }: { db: Db; existing: TransactionRow; patch: UpdateTransaction }) => {
  if (!changesShape(existing, patch)) return;
  if (existing.splitOfId !== null) throw conflict('Це частина розподіленого запису: суму й рахунок змінюй через «Розділити»');
  if ((await db.transaction.count({ where: { splitOfId: existing.id } })) > 0) {
    throw conflict('Запис розділено на частини: спершу скасуй розподіл');
  }
};

export const updateTransaction = async ({ db, id, patch }: { db: Db; id: string; patch: UpdateTransaction }) => {
  const existing = await db.transaction.findUnique({ where: { id } });
  if (existing === null) throw notFound(`Transaction "${id}" not found`);
  await assertSplitKeepsShape({ db, existing, patch });

  const shape: Shape = {
    type: patch.type ?? existing.type,
    accountId: patch.accountId ?? existing.accountId,
    amount: patch.amount ?? toNumber(existing.amount),
    toAccountId: patch.toAccountId === undefined ? existing.toAccountId : patch.toAccountId,
    toAmount: patch.toAmount === undefined ? toNullableNumber(existing.toAmount) : patch.toAmount,
    category: patch.category === undefined ? existing.category : patch.category,
  };
  const fields = await resolveTransactionFields(db, shape);
  const resolvesReview = patch.type !== undefined || patch.category !== undefined || patch.toAccountId !== undefined;
  const needsReview = patch.needsReview ?? (resolvesReview ? false : existing.needsReview);

  const row = await db.transaction.update({
    where: { id },
    data: {
      ...fields,
      type: shape.type,
      amount: shape.amount,
      ...(patch.date === undefined ? {} : { date: fromIsoDate(patch.date) }),
      ...(patch.note === undefined ? {} : { note: patch.note || null }),
      ...(patch.tags === undefined ? {} : { tags: patch.tags }),
      needsReview,
      reviewReason: needsReview ? existing.reviewReason : null,
    },
  });
  return mapTransaction(row);
};

const listLineIds = (row: Pick<TransactionRow, 'externalId' | 'toExternalId'>) =>
  [row.externalId, row.toExternalId].filter((lineId) => lineId !== null);

/** Deleting a synced row remembers its bank lines, or the next sync would bring it back. */
export const deleteTransaction = async ({ db, id }: { db: Db; id: string }) => {
  const row = await db.transaction.findUnique({ where: { id } });
  if (row === null) throw notFound(`Transaction "${id}" not found`);
  if (row.splitOfId !== null) throw conflict('Це частина розподіленого запису: скасуй розподіл або видали весь запис');
  await db.$transaction([
    db.dismissedLine.createMany({
      data: listLineIds(row).map((externalId) => ({ externalId })),
      skipDuplicates: true,
    }),
    db.transaction.delete({ where: { id } }),
    db.transaction.updateMany({ where: { duplicateOfId: id }, data: { duplicateOfId: null } }),
  ]);
};

/**
 * Resolves a suspected duplicate: the kept row takes over the bank links it lacks, the
 * rest are dismissed, and the duplicate disappears. The kept row's amounts stay as entered.
 */
export const mergeTransaction = async ({ db, id, intoId }: { db: Db; id: string; intoId: string }) => {
  if (id === intoId) throw badRequest('A row cannot be merged into itself');
  const [duplicate, kept] = await Promise.all([
    db.transaction.findUnique({ where: { id } }),
    db.transaction.findUnique({ where: { id: intoId } }),
  ]);
  if (duplicate === null) throw notFound(`Transaction "${id}" not found`);
  if (kept === null) throw notFound(`Transaction "${intoId}" not found`);
  const splitRows = await db.transaction.count({ where: { OR: [{ splitOfId: { in: [id, intoId] } }, { id: { in: [id, intoId] }, splitOfId: { not: null } }] } });
  if (splitRows > 0) throw conflict('Розділені записи не об’єднуються: спершу скасуй розподіл');

  const takeExternal = kept.externalId === null ? duplicate.externalId : null;
  const takeToExternal = kept.toExternalId === null ? duplicate.toExternalId : null;
  const dismissed = listLineIds(duplicate).filter((lineId) => lineId !== takeExternal && lineId !== takeToExternal);

  const [, , updated] = await db.$transaction([
    db.dismissedLine.createMany({ data: dismissed.map((externalId) => ({ externalId })), skipDuplicates: true }),
    db.transaction.delete({ where: { id } }),
    db.transaction.update({
      where: { id: intoId },
      data: {
        ...(takeExternal === null ? {} : { externalId: takeExternal }),
        ...(takeToExternal === null ? {} : { toExternalId: takeToExternal }),
      },
    }),
  ]);
  return mapTransaction(updated);
};

/** Amounts are compared in cents: parts typed by hand rarely carry float noise further than that. */
const toCents = (value: number) => Math.round(value * 100);

/** Messages reach the owner as they are, so amounts use the decimal comma: 52 141,76. */
const formatAmount = (value: number) => value.toLocaleString('uk-UA', { minimumFractionDigits: 2, maximumFractionDigits: 2 });

/** A part of a split always resolves to the row that holds the bank line. */
const findSplitParent = async ({ db, id }: { db: Db; id: string }) => {
  const row = await db.transaction.findUnique({ where: { id } });
  if (row === null) throw notFound(`Transaction "${id}" not found`);
  if (row.splitOfId === null) return row;
  const parent = await db.transaction.findUnique({ where: { id: row.splitOfId } });
  if (parent === null) throw notFound(`Transaction "${row.splitOfId}" not found`);
  return parent;
};

/**
 * Splits one expense or income into parts with their own categories. The parent keeps the bank
 * link, so sync still recognises the line, and leaves balances and analytics to its parts.
 */
export const splitTransaction = async ({
  db,
  id,
  input,
}: {
  db: Db;
  id: string;
  input: SplitTransaction;
}): Promise<TransactionSplit> => {
  const parent = await findSplitParent({ db, id });
  if (parent.type !== 'expense' && parent.type !== 'income') throw badRequest('Розділити можна лише витрату або дохід');
  const total = input.parts.reduce((sum, part) => sum + toCents(part.amount), 0);
  if (total !== toCents(toNumber(parent.amount))) {
    throw badRequest(
      `Частини мають разом давати ${formatAmount(toNumber(parent.amount))} ${parent.currency}, а дають ${formatAmount(total / 100)}`,
    );
  }
  for (const part of input.parts) await assertCategory({ db, name: part.category, type: parent.type });

  const [, , ...parts] = await db.$transaction([
    db.transaction.deleteMany({ where: { splitOfId: parent.id } }),
    db.transaction.update({ where: { id: parent.id }, data: { needsReview: false, reviewReason: null } }),
    ...input.parts.map((part) =>
      db.transaction.create({
        data: {
          type: parent.type,
          date: parent.date,
          accountId: parent.accountId,
          amount: part.amount,
          currency: parent.currency,
          category: part.category,
          note: part.note || parent.note,
          tags: parent.tags,
          source: parent.source,
          splitOfId: parent.id,
        },
      }),
    ),
  ]);
  const updated = await db.transaction.findUnique({ where: { id: parent.id } });
  return { parent: mapTransaction(updated ?? parent), parts: parts.map(mapTransaction) };
};

/** Undoes a split: the parts go, the parent counts again with its own category. */
export const unsplitTransaction = async ({ db, id }: { db: Db; id: string }) => {
  const parent = await findSplitParent({ db, id });
  await db.transaction.deleteMany({ where: { splitOfId: parent.id } });
  return mapTransaction(parent);
};
