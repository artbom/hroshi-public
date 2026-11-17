import {
  aggregateMonths,
  bridgeNetWorth,
  findMonthEnd,
  SPARSE_MONTH_ROWS,
  assessDataQuality,
  compareMonth,
  listMonthEnds,
  listMonthsBack,
  listMonthsBetween,
  rankIncomeSources,
  rankPayees,
  shiftMonth,
  summarizeTags,
  summarizeTrips,
  traceHryvniaExposure,
  traceNetWorth,
} from '@hroshi/domain';
import {
  BridgeQuerySchema,
  ComparisonQuerySchema,
  DataQualityQuerySchema,
  DataQualitySchema,
  HistoryQuerySchema,
  HryvniaExposureSchema,
  MonthComparisonSchema,
  NetWorthBridgeSchema,
  NetWorthHistorySchema,
  PayeesSchema,
  PeriodQuerySchema,
  RecurringSchema,
  TagListSchema,
  TripReportSchema,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { countRowsByMonth } from '../accounts/routes.ts';
import { findCurrentMonth, findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { badRequest } from '../http-errors.ts';
import { loadLedger } from '../ledger.ts';
import { findPlannedPayments } from '../planned/store.ts';
import { listBrokerSeries } from './broker-values.ts';

/** Comparing a month with its usual level and the same month a year earlier needs this many months. */
const COMPARISON_SPAN = 13;
const DEFAULT_PERIOD_MONTHS = 12;

export const insightRoutes: FastifyPluginAsyncZod = async (app) => {
  /**
   * Archived accounts are included: their history rows are real money, and leaving them out
   * would turn every old transfer into a cash or crypto wallet into a loss.
   */
  app.get(
    '/net-worth/history',
    { schema: { querystring: HistoryQuerySchema, response: { 200: NetWorthHistorySchema } } },
    async (request) => {
      const ledger = await loadLedger(prisma);
      const ends = listMonthEnds({ until: findCurrentMonth(), count: request.query.months, today: findToday() });
      const worth = traceNetWorth({
        accounts: ledger.accounts,
        transactions: ledger.transactions,
        fx: ledger.fx,
        dates: ends.map((end) => end.date),
        brokers: await listBrokerSeries(ledger),
      });
      const rows = countRowsByMonth(ledger);
      const touched = new Set(ledger.transactions.flatMap((transaction) => [transaction.accountId, transaction.toAccountId]));
      return {
        points: ends.map(({ month, date }, index) => ({
          ...(worth[index] ?? { totalEur: 0, cashEur: 0, investmentsEur: 0, owedToMeEur: 0, creditDebtEur: 0, iOweEur: 0 }),
          month,
          date,
          sparse: (rows.get(month) ?? 0) < SPARSE_MONTH_ROWS,
        })),
        accounts: ledger.accounts.filter((account) => account.openingBalance !== 0 || touched.has(account.id)).length,
      };
    },
  );

  app.get(
    '/fx/hryvnia',
    { schema: { querystring: HistoryQuerySchema, response: { 200: HryvniaExposureSchema } } },
    async (request) => {
      const { accounts, transactions, fx } = await loadLedger(prisma);
      const ends = listMonthEnds({ until: findCurrentMonth(), count: request.query.months, today: findToday() });
      return traceHryvniaExposure({ accounts, transactions, fx, ends });
    },
  );

  app.get(
    '/net-worth/bridge',
    { schema: { querystring: BridgeQuerySchema, response: { 200: NetWorthBridgeSchema } } },
    async (request) => {
      const { month, from: fromMonth = month } = request.query;
      if (fromMonth > month) throw badRequest('"from" must not be after "month"');
      const ledger = await loadLedger(prisma);
      const { accounts, transactions, fx, policies } = ledger;
      const today = findToday();
      const from = findMonthEnd({ month: shiftMonth(fromMonth, -1), today });
      const to = findMonthEnd({ month, today });
      const brokers = await listBrokerSeries(ledger);
      return { month, fromMonth, from, to, ...bridgeNetWorth({ accounts, transactions, fx, policies, from, to, brokers }) };
    },
  );

  app.get('/payees', { schema: { querystring: PeriodQuerySchema, response: { 200: PayeesSchema } } }, async (request) => {
    const to = request.query.to ?? findCurrentMonth();
    const from = request.query.from ?? shiftMonth(to, 1 - DEFAULT_PERIOD_MONTHS);
    if (from > to) throw badRequest('"from" must not be after "to"');
    const { transactions, policies, fx } = await loadLedger(prisma);
    const months = listMonthsBetween({ from, to });
    return {
      from,
      to,
      payees: rankPayees({ months, transactions, policies, fx }),
      incomeSources: rankIncomeSources({ months, transactions, policies, fx }),
    };
  });

  app.get('/recurring', { schema: { response: { 200: RecurringSchema } } }, async () =>
    findPlannedPayments({ db: prisma, ledger: await loadLedger(prisma), today: findToday() }),
  );

  app.get(
    '/data-quality',
    { schema: { querystring: DataQualityQuerySchema, response: { 200: DataQualitySchema } } },
    async (request) => {
      const { transactions, policies, fx } = await loadLedger(prisma);
      const currentMonth = findCurrentMonth();
      const months = listMonthsBack({ until: currentMonth, count: request.query.months });
      return { months: assessDataQuality({ months, transactions, policies, fx, currentMonth }) };
    },
  );

  app.get('/tags', { schema: { response: { 200: TagListSchema } } }, async () => {
    const { transactions, policies, fx } = await loadLedger(prisma);
    return summarizeTags({ transactions, policies, fx });
  });

  app.get('/trips', { schema: { querystring: PeriodQuerySchema, response: { 200: TripReportSchema } } }, async (request) => {
    const to = request.query.to ?? findCurrentMonth();
    const from = request.query.from ?? shiftMonth(to, 1 - DEFAULT_PERIOD_MONTHS);
    if (from > to) throw badRequest('"from" must not be after "to"');
    const { transactions, policies, fx } = await loadLedger(prisma);
    return summarizeTrips({ transactions, policies, fx, from, to });
  });

  app.get(
    '/compare',
    { schema: { querystring: ComparisonQuerySchema, response: { 200: MonthComparisonSchema } } },
    async (request) => {
      const { month, spreadTax } = request.query;
      const ledger = await loadLedger(prisma);
      const { transactions, policies, fx } = ledger;
      const months = listMonthsBack({ until: month, count: COMPARISON_SPAN });
      const today = findToday();
      const stats = aggregateMonths({
        months,
        transactions,
        policies,
        fx,
        currentMonth: findCurrentMonth(),
        spreadQuarterlyTax: spreadTax,
      });
      const recurring = month === findCurrentMonth() ? await findPlannedPayments({ db: prisma, ledger, today }) : null;
      return compareMonth({ month, stats, today, recurring });
    },
  );
};
