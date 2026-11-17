import { computeBalances, convertToEur } from '@hroshi/domain';
import type { Transaction } from '@hroshi/schema';
import ExcelJS from 'exceljs';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { loadLedger } from '../ledger.ts';

const TYPE_LABELS: Readonly<Record<Transaction['type'], string>> = {
  expense: 'Витрата',
  income: 'Дохід',
  transfer: 'Переказ',
  valuation: 'Переоцінка',
};

export const exportRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/export.xlsx', async (_request, reply) => {
    const ledger = await loadLedger(prisma);
    const names = new Map(ledger.accounts.map((account) => [account.id, account.name]));
    const balances = computeBalances({ accounts: ledger.accounts, transactions: ledger.transactions });
    const workbook = new ExcelJS.Workbook();

    const entries = workbook.addWorksheet('Записи');
    entries.columns = [
      { header: 'Дата', key: 'date', width: 12 },
      { header: 'Тип', key: 'type', width: 11 },
      { header: 'Рахунок', key: 'account', width: 22 },
      { header: 'На рахунок', key: 'toAccount', width: 22 },
      { header: 'Сума', key: 'amount', width: 12 },
      { header: 'Валюта', key: 'currency', width: 8 },
      { header: 'Сума зарахування', key: 'toAmount', width: 12 },
      { header: 'Категорія', key: 'category', width: 20 },
      { header: 'Коментар', key: 'note', width: 40 },
      { header: '≈ €', key: 'eur', width: 10 },
      { header: 'Джерело', key: 'source', width: 10 },
    ];
    entries.addRows(
      ledger.transactions.map((transaction) => ({
        date: transaction.date,
        type: TYPE_LABELS[transaction.type],
        account: names.get(transaction.accountId) ?? transaction.accountId,
        toAccount: transaction.toAccountId === null ? '' : (names.get(transaction.toAccountId) ?? transaction.toAccountId),
        amount: transaction.amount,
        currency: transaction.currency,
        toAmount: transaction.toAmount ?? '',
        category: transaction.category ?? '',
        note: transaction.note ?? '',
        eur: convertToEur({ transaction, fx: ledger.fx }) ?? '',
        source: transaction.source,
      })),
    );

    const accounts = workbook.addWorksheet('Рахунки');
    accounts.columns = [
      { header: 'Рахунок', key: 'name', width: 26 },
      { header: 'Валюта', key: 'currency', width: 8 },
      { header: 'Початковий баланс', key: 'opening', width: 16 },
      { header: 'Дата початку', key: 'openingDate', width: 13 },
      { header: 'Поточний баланс', key: 'balance', width: 16 },
    ];
    accounts.addRows(
      ledger.accounts.map((account) => ({
        name: account.name,
        currency: account.currency,
        opening: account.openingBalance,
        openingDate: account.openingDate,
        balance: balances.get(account.id) ?? account.openingBalance,
      })),
    );

    reply
      .header('content-type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet')
      .header('content-disposition', `attachment; filename="hroshi-${findToday()}.xlsx"`);
    return Buffer.from(await workbook.xlsx.writeBuffer());
  });
};
