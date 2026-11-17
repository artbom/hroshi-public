import {
  aggregateMonths,
  computeBalances,
  indexCategoryLimits,
  listMonthsBack,
  rankMerchants,
  summarizeLimits,
  summarizeMonthByCurrency,
  summarizeNetWorth,
  summarizeSpendTrend,
  summarizeTrends,
} from '@hroshi/domain';
import {
  CategoryDetailQuerySchema,
  CategoryDetailSchema,
  CurrentNetWorthSchema,
  MonthOverviewSchema,
  MonthQuerySchema,
  TrendsQuerySchema,
  TrendsSchema,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { findCurrentMonth, findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { loadLedger } from '../ledger.ts';

export const analyticsRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/overview',
    { schema: { querystring: MonthQuerySchema, response: { 200: MonthOverviewSchema } } },
    async (request) => {
      const { month } = request.query;
      const { transactions, policies, fx, categories } = await loadLedger(prisma);
      const [stats] = aggregateMonths({ months: [month], transactions, policies, fx, currentMonth: findCurrentMonth() });
      return {
        month,
        byCurrency: summarizeMonthByCurrency({ month, transactions, policies }),
        limits: stats === undefined ? [] : summarizeLimits({ stats, limits: indexCategoryLimits(categories) }),
        spendTrend: summarizeSpendTrend({ until: month, transactions, policies }),
      };
    },
  );

  app.get('/net-worth', { schema: { response: { 200: CurrentNetWorthSchema } } }, async () => {
    const { accounts, transactions, fx } = await loadLedger(prisma);
    const balances = computeBalances({ accounts, transactions });
    const date = findToday();
    const held = new Set(accounts.filter((account) => (balances.get(account.id) ?? 0) !== 0).map((account) => account.currency));
    const rates = [...held].filter((currency) => currency !== 'EUR').flatMap((currency) => fx.describeRate(currency, date) ?? []);
    return { ...summarizeNetWorth({ accounts, balances, fx, date }), rates };
  });

  app.get(
    '/trends',
    { schema: { querystring: TrendsQuerySchema, response: { 200: TrendsSchema } } },
    async (request) => {
      const { month, range, spreadTax } = request.query;
      const { transactions, policies, fx } = await loadLedger(prisma);
      const months = listMonthsBack({ until: month, count: range });
      return summarizeTrends(
        aggregateMonths({ months, transactions, policies, fx, currentMonth: findCurrentMonth(), spreadQuarterlyTax: spreadTax }),
      );
    },
  );

  app.get(
    '/category-detail',
    { schema: { querystring: CategoryDetailQuerySchema, response: { 200: CategoryDetailSchema } } },
    async (request) => {
      const { category, month, range, spreadTax } = request.query;
      const { transactions, policies, fx } = await loadLedger(prisma);
      const months = listMonthsBack({ until: month, count: range });
      const stats = aggregateMonths({
        months,
        transactions,
        policies,
        fx,
        currentMonth: findCurrentMonth(),
        spreadQuarterlyTax: spreadTax,
      });

      return {
        category,
        months: stats.map((entry) => ({
          month: entry.month,
          eur: Math.max(0, entry.categories[category] ?? 0),
          sparse: entry.sparse,
        })),
        merchants: rankMerchants({ category, months, transactions, policies, fx }),
      };
    },
  );
};
