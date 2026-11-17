import {
  computeBalanceHistory,
  computeBalances,
  listBalanceEffects,
  listMonthEnds,
  roundAmount,
  SPARSE_MONTH_ROWS,
  toMonth,
} from '@hroshi/domain';
import {
  type AccountBalance,
  type AccountRecord,
  type BalanceCheck,
  AccountHistorySchema,
  AccountListSchema,
  AccountRecordPageSchema,
  AccountRecordQuerySchema,
  AccountSchema,
  HistoryQuerySchema,
  IdParamsSchema,
  type Transaction,
  UpdateLoanSchema,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { findCurrentMonth, findToday } from '../clock.ts';
import { type Db, prisma } from '../db.ts';
import { badRequest, notFound } from '../http-errors.ts';
import { type Ledger, loadLedger, toTransactionRow } from '../ledger.ts';
import { fromIsoDate, mapAccount } from '../mappers.ts';
import { listBalanceChecks } from '../sync/reconciliation.ts';
import { readBankLine } from '../transactions/bank-line.ts';
import { findBankSince } from '../transactions/query.ts';

export const describeAccounts = (ledger: Ledger, checks: readonly BalanceCheck[] = []): AccountBalance[] => {
  const checkByAccount = new Map(checks.map((check) => [check.accountId, check]));
  const balances = computeBalances({ accounts: ledger.accounts, transactions: ledger.transactions });
  const lastValuation = new Map<string, string>();
  const lastRow = new Map<string, string>();
  for (const transaction of ledger.transactions) {
    if (transaction.type === 'valuation') lastValuation.set(transaction.accountId, transaction.date);
    for (const accountId of [transaction.accountId, transaction.toAccountId]) {
      if (accountId !== null && transaction.date > (lastRow.get(accountId) ?? '')) lastRow.set(accountId, transaction.date);
    }
  }

  return ledger.accounts.map((account) => ({
    ...account,
    balance: balances.get(account.id) ?? account.openingBalance,
    valuedAt: lastValuation.get(account.id) ?? null,
    lastRowDate: lastRow.get(account.id) ?? null,
    check: checkByAccount.get(account.id) ?? null,
  }));
};

/** Rows per month across the whole ledger: a month too thin to trust makes a back-cast balance a guess. */
export const countRowsByMonth = (ledger: Pick<Ledger, 'transactions'>): Map<string, number> => {
  const counts = new Map<string, number>();
  for (const transaction of ledger.transactions) {
    const month = toMonth(transaction.date);
    counts.set(month, (counts.get(month) ?? 0) + 1);
  }
  return counts;
};

const sumDelta = (transaction: Transaction, accountId: string) =>
  listBalanceEffects(transaction)
    .filter((effect) => effect.accountId === accountId)
    .reduce((sum, effect) => sum + effect.delta, 0);

/**
 * The account's statement, oldest first, with the balance after every row: the opening balance
 * carried forward from the opening date, and back-cast through the history rows before it. Where
 * the bank printed its own balance on the line it comes along; a line booked as two rows (cash and
 * its ATM fee) gives it to the later one, because the bank's figure already includes both.
 */
const listAccountRecords = async ({ db, ledger, accountId }: { db: Db; ledger: Ledger; accountId: string }) => {
  const account = ledger.accounts.find((candidate) => candidate.id === accountId);
  if (account === undefined) throw notFound(`Account "${accountId}" not found`);
  const touching = ledger.transactions.filter(
    (transaction) => transaction.accountId === accountId || transaction.toAccountId === accountId,
  );
  const stored = await db.transaction.findMany({ where: { id: { in: touching.map((transaction) => transaction.id) } }, select: { id: true, raw: true } });
  const raws = new Map(stored.map((row) => [row.id, row.raw]));
  const accounts = new Map(ledger.accounts.map((candidate) => [candidate.id, candidate]));

  const lines = touching.map((transaction) => {
    const line = readBankLine({ raw: raws.get(transaction.id), transaction, accounts });
    const own = line !== null && line.accountId === accountId;
    const bookedAt = own && line.bookedAt !== null && line.bookedAt.length > 10 ? line.bookedAt : transaction.createdAt;
    return { transaction, line: own ? line : null, order: `${transaction.date}|${bookedAt}`, delta: sumDelta(transaction, accountId) };
  });
  lines.sort((left, right) => left.order.localeCompare(right.order));

  const lastOfLine = new Map<string, string>();
  for (const { transaction, line } of lines) {
    if (line?.bookedAt != null) lastOfLine.set(`${line.bookedAt}|${line.amount ?? ''}`, transaction.id);
  }
  const history = lines.filter(({ transaction }) => transaction.date < account.openingDate);
  let backCast = account.openingBalance;
  const historyBalances = history
    .toReversed()
    .map((entry) => {
      const after = backCast;
      backCast -= entry.delta;
      return after;
    })
    .toReversed();
  let running = account.openingBalance;
  const records: AccountRecord[] = lines.map((entry, index) => {
    const isHistory = index < history.length;
    if (!isHistory) running += entry.delta;
    const { line, transaction } = entry;
    const ownsBalance = line !== null && lastOfLine.get(`${line.bookedAt ?? ''}|${line.amount ?? ''}`) === transaction.id;
    return {
      row: toTransactionRow(ledger, transaction),
      delta: roundAmount(entry.delta),
      computedBalance: roundAmount(isHistory ? (historyBalances[index] ?? account.openingBalance) : running),
      bankBalance: ownsBalance && line.balanceAfter !== null ? roundAmount(line.balanceAfter) : null,
      history: isHistory,
    };
  });
  return { records: records.toReversed(), bankSince: findBankSince(ledger).get(accountId) ?? null };
};

export const accountRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/accounts/:id/records',
    { schema: { params: IdParamsSchema, querystring: AccountRecordQuerySchema, response: { 200: AccountRecordPageSchema } } },
    async (request) => {
      const { records, bankSince } = await listAccountRecords({ db: prisma, ledger: await loadLedger(prisma), accountId: request.params.id });
      const { offset, limit } = request.query;
      return { items: records.slice(offset, offset + limit), total: records.length, bankSince };
    },
  );

  app.patch(
    '/accounts/:id/loan',
    { schema: { params: IdParamsSchema, body: UpdateLoanSchema, response: { 200: AccountSchema } } },
    async (request) => {
      const account = await prisma.account.findUnique({ where: { id: request.params.id } });
      if (account === null) throw notFound(`Account "${request.params.id}" not found`);
      if (account.kind !== 'receivable') throw badRequest('Who and when apply to loan accounts only');
      const { counterparty, dueDate } = request.body;
      const updated = await prisma.account.update({
        where: { id: account.id },
        data: { counterparty, dueDate: dueDate === null ? null : fromIsoDate(dueDate) },
      });
      return mapAccount(updated);
    },
  );

  app.get('/accounts', { schema: { response: { 200: AccountListSchema } } }, async () => {
    const ledger = await loadLedger(prisma);
    return describeAccounts(ledger, await listBalanceChecks({ db: prisma, ledger }));
  });

  app.get(
    '/accounts/:id/history',
    { schema: { params: IdParamsSchema, querystring: HistoryQuerySchema, response: { 200: AccountHistorySchema } } },
    async (request) => {
      const ledger = await loadLedger(prisma);
      const checks = await listBalanceChecks({ db: prisma, ledger });
      const account = describeAccounts(ledger, checks).find((candidate) => candidate.id === request.params.id);
      if (account === undefined) throw notFound(`Account "${request.params.id}" not found`);

      const ends = listMonthEnds({ until: findCurrentMonth(), count: request.query.months, today: findToday() });
      const balances =
        computeBalanceHistory({ accounts: [account], transactions: ledger.transactions, dates: ends.map((end) => end.date) }).get(
          account.id,
        ) ?? [];
      const touching = ledger.transactions.filter(
        (transaction) => transaction.accountId === account.id || transaction.toAccountId === account.id,
      );
      const rowsByMonth = Map.groupBy(touching, (transaction) => toMonth(transaction.date));
      const ledgerRows = countRowsByMonth(ledger);

      return {
        account,
        points: ends.map(({ month, date }, index) => {
          const balance = balances[index] ?? account.openingBalance;
          return {
            month,
            date,
            balance,
            eur: ledger.fx.toEur(balance, account.currency, date),
            rows: rowsByMonth.get(month)?.length ?? 0,
            sparse: (ledgerRows.get(month) ?? 0) < SPARSE_MONTH_ROWS,
          };
        }),
        historyRows: touching.filter((transaction) => transaction.date < account.openingDate).length,
        firstRowDate: touching[0]?.date ?? null,
        unknownInflows: touching.filter(
          (transaction) => transaction.toAccountId === account.id && transaction.toAmount === 0,
        ).length,
        check: checks.find((check) => check.accountId === account.id) ?? null,
      };
    },
  );
};
