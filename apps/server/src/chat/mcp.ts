import {
  AccountBalanceSchema,
  AccountListSchema,
  BudgetQuerySchema,
  BudgetSchema,
  CategoryDetailQuerySchema,
  CategoryDetailSchema,
  CategoryListSchema,
  CategorySchema,
  ComparisonQuerySchema,
  CreateTransactionsSchema,
  CurrentNetWorthSchema,
  HistoryQuerySchema,
  IdParamsSchema,
  InvestmentsSchema,
  IsoDateSchema,
  MergeTransactionSchema,
  MonthComparisonSchema,
  MonthOverviewSchema,
  MonthQuerySchema,
  MonthSchema,
  NetWorthHistorySchema,
  PeriodQuerySchema,
  PositionSchema,
  RecurringPaymentSchema,
  RecurringSchema,
  ReviewGroupSchema,
  SavingsGoalSchema,
  ReviewInboxSchema,
  SyncRunSchema,
  SyncSourceStatusSchema,
  SyncStatusListSchema,
  TransactionPageSchema,
  TransactionQuerySchema,
  TransactionRowSchema,
  TransactionSchema,
  TrendsQuerySchema,
  TrendsSchema,
  TripReportSchema,
  UpdateTransactionSchema,
} from '@hroshi/schema';
import { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { StreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/streamableHttp.js';
import type { FastifyInstance } from 'fastify';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { readSavingsGoal, saveSavingsGoal } from '../budget/store.ts';
import { findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { DigestKindSchema, findWeekEnd } from '../digest/period.ts';
import { sendDigest } from '../digest/send.ts';
import { splitwiseProvider } from '../sync/splitwise/provider.ts';
import { requireTelegramOwner, sendTelegramPhoto } from '../telegram.ts';
import { createTransactions, deleteTransaction, mergeTransaction, updateTransaction } from '../transactions/service.ts';
import { trackChatWrite } from './changes.ts';
import { ChartSchema, renderChart } from './chart.ts';
import { registerSplitwiseTools } from './splitwise-tools.ts';
import { reply, requireBatch } from './tool-helpers.ts';

/** What the model needs of each shape; the rest of the API response only costs tokens. */
const ModelRowSchema = TransactionSchema.pick({
  id: true,
  date: true,
  type: true,
  accountId: true,
  toAccountId: true,
  amount: true,
  currency: true,
  toAmount: true,
  category: true,
  note: true,
  tags: true,
  payee: true,
  bankText: true,
  needsReview: true,
});
const ModelSearchRowSchema = z.object({ ...ModelRowSchema.shape, eur: TransactionRowSchema.shape.eur });
const ModelAccountSchema = AccountBalanceSchema.pick({ id: true, name: true, kind: true, currency: true, balance: true, lastRowDate: true });
const ModelCategorySchema = CategorySchema.pick({ name: true, parent: true, forExpense: true, forIncome: true });
const ModelReviewGroupSchema = ReviewGroupSchema.pick({ name: true, kind: true, suggestion: true, candidates: true });
const ModelPositionSchema = PositionSchema.pick({ symbol: true, name: true, assetClass: true, accountId: true, eur: true, gainEur: true, weight: true });
const ModelInvestmentsSchema = InvestmentsSchema.pick({
  valueEur: true,
  contributedEur: true,
  gainEur: true,
  sinceOpeningGainEur: true,
  brokerXirr: true,
  periodReturns: true,
  assetClasses: true,
});
const ModelRecurringSchema = RecurringPaymentSchema.pick({
  name: true,
  category: true,
  accountId: true,
  amount: true,
  currency: true,
  eur: true,
  cadenceDays: true,
  lastDate: true,
  nextDate: true,
  late: true,
  status: true,
  overdueDays: true,
});
const ModelSyncSchema = SyncSourceStatusSchema.pick({ source: true, configured: true, lastSuccessAt: true, consentValidUntil: true, checks: true });
const ModelSyncRunSchema = SyncRunSchema.pick({ status: true, finishedAt: true, error: true, created: true, updated: true, warnings: true });

/** The review inbox can hold hundreds of groups; the model works through it a screen at a time. */
const REVIEW_GROUPS_SHOWN = 15;
/** A category's long tail of one-off merchants says little and costs tokens. */
const MERCHANTS_SHOWN = 15;

const ReportInputSchema = z.object({
  kind: DigestKindSchema,
  day: IsoDateSchema.optional().describe('Для kind=day: останній день, який рахувати; без нього вчора'),
  month: MonthSchema.optional().describe('Для kind=month; без нього минулий місяць'),
  weekOf: IsoDateSchema.optional().describe('Для kind=week: будь-який день того тижня; без нього минулий тиждень'),
});

/** Search with JSON-friendly types: the HTTP query takes strings, the model sends booleans and numbers. */
const SearchSchema = z.object({
  ...TransactionQuerySchema.pick({ q: true, type: true, category: true, accountId: true, from: true, to: true, tag: true, source: true }).shape,
  needsReview: z.boolean().optional(),
  minEur: z.number().nonnegative().optional(),
  maxEur: z.number().nonnegative().optional(),
  limit: z.number().int().min(1).max(100).default(30),
  offset: z.number().int().min(0).default(0),
});

const UpdateInputSchema = z.object({ ...IdParamsSchema.shape, patch: UpdateTransactionSchema });
const MergeInputSchema = z.object({ ...IdParamsSchema.shape, ...MergeTransactionSchema.shape });

/** The digest takes any day of its period: it finds the month, or the Monday–Sunday week, around it. */
const findReportEnd = ({ kind, day, month, weekOf }: z.infer<typeof ReportInputSchema>) => {
  if (kind === 'day') return day;
  if (kind === 'month') return month === undefined ? undefined : `${month}-01`;
  return weekOf === undefined ? undefined : findWeekEnd(weekOf);
};


/** Reads go through the same routes as the web app, so the model sees exactly what the owner sees. */
const readApi = async <Schema extends z.ZodType>({ app, url, schema }: { app: Pick<FastifyInstance, 'inject'>; url: string; schema: Schema }) => {
  const response = await app.inject({ method: 'GET', url });
  if (response.statusCode !== 200) throw new Error(`${url} answered ${response.statusCode}: ${response.body}`);
  return schema.parse(response.json());
};

const buildQueryString = (values: Record<string, string | number | boolean | undefined>) => {
  const params = new URLSearchParams();
  for (const [key, value] of Object.entries(values)) if (value !== undefined) params.set(key, String(value));
  return params.toString();
};


const buildChatServer = ({ app, batchId }: { app: Pick<FastifyInstance, 'inject'>; batchId: string | undefined }) => {
  const server = new McpServer({ name: 'hroshi', version: '1.0.0' });
  const read = { readOnlyHint: true };

  server.registerTool(
    'list_accounts',
    { description: 'Рахунки з поточними балансами; архівні пропущено. id звідси йде в accountId.', annotations: read },
    async () => {
      const accounts = await readApi({ app, url: '/api/accounts', schema: AccountListSchema });
      return reply(accounts.filter((account) => !account.archived).map((account) => ModelAccountSchema.parse(account)));
    },
  );

  server.registerTool(
    'list_categories',
    { description: 'Категорії (назва — це і є id). parent: батьківська категорія.', annotations: read },
    async () => {
      const categories = await readApi({ app, url: '/api/categories', schema: CategoryListSchema });
      return reply(categories.filter((category) => !category.archived).map((category) => ModelCategorySchema.parse(category)));
    },
  );

  server.registerTool(
    'search_transactions',
    {
      description:
        'Пошук записів. q шукає в нотатці й тексті банку; from/to — місяці YYYY-MM; minEur/maxEur — розмір у євро. Найновіші першими.',
      inputSchema: SearchSchema,
      annotations: read,
    },
    async (args) => {
      const page = await readApi({ app, url: `/api/transactions?${buildQueryString(args)}`, schema: TransactionPageSchema });
      return reply({
        total: page.total,
        expenseEur: page.expenseEur,
        netEur: page.netEur,
        items: page.items.map((row) => ModelSearchRowSchema.parse(row)),
      });
    },
  );

  server.registerTool(
    'budget',
    {
      description:
        'Бюджет місяця: ціль заощаджень, бюджет (звичний дохід за 3 міс мінус ціль), витрачено й прогноз загалом, по категоріях з орієнтиром і по решті. Суми в євро; залишок = limitEur − spentEur. asOf — останній день, який рахувати (без нього сьогодні). budget = null, поки ціль не задана.',
      inputSchema: BudgetQuerySchema,
      annotations: read,
    },
    async ({ asOf }) => reply(await readApi({ app, url: `/api/budget?${buildQueryString({ asOf })}`, schema: BudgetSchema })),
  );

  server.registerTool(
    'set_savings_goal',
    {
      description: 'Змінює ціль заощаджень на місяць (сума й валюта, як каже власник: «3000 доларів» → 3000 USD). Бюджет місяця перераховується від неї.',
      inputSchema: SavingsGoalSchema,
    },
    async (goal) => {
      const previous = await readSavingsGoal(prisma);
      await saveSavingsGoal({ db: prisma, goal });
      return reply({ previous, goal });
    },
  );

  server.registerTool(
    'month_overview',
    { description: 'Витрати й доходи місяця в оригінальних валютах по категоріях, плюс ліміти категорій.', inputSchema: MonthQuerySchema, annotations: read },
    async ({ month }) => {
      const { byCurrency, limits } = await readApi({ app, url: `/api/overview?month=${month}`, schema: MonthOverviewSchema });
      return reply({ month, byCurrency, limits });
    },
  );

  server.registerTool(
    'review_queue',
    { description: 'Записи, що чекають на перевірку, згруповані за отримувачем, з підказкою категорії.', annotations: read },
    async () => {
      const inbox = await readApi({ app, url: '/api/review', schema: ReviewInboxSchema });
      return reply({
        total: inbox.total,
        snoozed: inbox.snoozed,
        groups: inbox.groups.slice(0, REVIEW_GROUPS_SHOWN).map((group) => ({
          ...ModelReviewGroupSchema.parse(group),
          rows: group.rows.map((row) => ModelSearchRowSchema.parse(row)),
        })),
      });
    },
  );

  server.registerTool(
    'net_worth',
    {
      description: 'Чисті активи зараз (з курсами, за якими перераховано в євро) і на кінець кожного з останніх months місяців.',
      inputSchema: HistoryQuerySchema,
      annotations: read,
    },
    async ({ months }) => {
      const [current, { points }] = await Promise.all([
        readApi({ app, url: '/api/net-worth', schema: CurrentNetWorthSchema }),
        readApi({ app, url: `/api/net-worth/history?months=${months}`, schema: NetWorthHistorySchema }),
      ]);
      return reply({ current, history: points });
    },
  );

  server.registerTool(
    'month_trends',
    {
      description:
        'Дохід, витрати й категорії в євро за кожен із range місяців до month включно, плюс середні. partial: місяць ще йде; sparse: даних замало, щоб йому вірити.',
      inputSchema: TrendsQuerySchema.pick({ month: true, range: true }),
      annotations: read,
    },
    async (args) => reply(await readApi({ app, url: `/api/trends?${buildQueryString(args)}`, schema: TrendsSchema })),
  );

  server.registerTool(
    'compare_month',
    {
      description: 'Місяць проти середнього за попередні повні місяці й проти того самого місяця торік; для поточного місяця ще й прогноз.',
      inputSchema: ComparisonQuerySchema.pick({ month: true }),
      annotations: read,
    },
    async ({ month }) => reply(await readApi({ app, url: `/api/compare?month=${month}`, schema: MonthComparisonSchema })),
  );

  server.registerTool(
    'category_detail',
    {
      description: 'Одна категорія: євро за кожен із range місяців до month і на кого найбільше пішло.',
      inputSchema: CategoryDetailQuerySchema.pick({ month: true, range: true, category: true }),
      annotations: read,
    },
    async (args) => {
      const detail = await readApi({ app, url: `/api/category-detail?${buildQueryString(args)}`, schema: CategoryDetailSchema });
      return reply({ ...detail, merchants: detail.merchants.slice(0, MERCHANTS_SHOWN) });
    },
  );

  server.registerTool(
    'investments',
    { description: 'Портфель: вартість, внески, дохідність за періоди, класи активів, рахунки й позиції в євро.', annotations: read },
    async () => {
      const investments = await readApi({ app, url: '/api/investments', schema: InvestmentsSchema });
      return reply({
        ...ModelInvestmentsSchema.parse(investments),
        accounts: investments.accounts.map(({ account, eur, share }) => ({ id: account.id, name: account.name, eur, share })),
        positions: investments.positions.map((position) => ModelPositionSchema.parse(position)),
      });
    },
  );

  server.registerTool(
    'trips',
    {
      description: 'Поїздки (теги) за період from…to (місяці YYYY-MM): скільки днів, скільки в євро, на що пішло.',
      inputSchema: PeriodQuerySchema,
      annotations: read,
    },
    async (args) => reply(await readApi({ app, url: `/api/trips?${buildQueryString(args)}`, schema: TripReportSchema })),
  );

  server.registerTool(
    'recurring_payments',
    { description: 'Регулярні платежі й підписки: сума, частота, коли наступний, які прострочені. monthlyEur — разом на місяць.', annotations: read },
    async () => {
      const { payments, monthlyEur } = await readApi({ app, url: '/api/recurring', schema: RecurringSchema });
      return reply({ monthlyEur, payments: payments.map((payment) => ModelRecurringSchema.parse(payment)) });
    },
  );

  server.registerTool(
    'sync_status',
    { description: 'Синхронізація з банками й біржами: останній запуск, помилки, звірка балансів, до коли діє згода банку.', annotations: read },
    async () => {
      const sources = await readApi({ app, url: '/api/sync', schema: SyncStatusListSchema });
      return reply(
        sources.map((source) => ({
          ...ModelSyncSchema.parse(source),
          lastRun: source.lastRun === null ? null : ModelSyncRunSchema.parse(source.lastRun),
        })),
      );
    },
  );

  server.registerTool(
    'send_report',
    {
      description:
        'Надсилає власнику в Telegram інфографіку. day: бюджет місяця на ранок — витрачено й залишилось загалом і по орієнтирах, прогноз, ціль заощаджень. week/month: як щотижневий дайджест — витрати проти звичайного, категорії, найбільші покупки, ліміти.',
      inputSchema: ReportInputSchema,
    },
    async (report) => {
      const { period, caption } = await sendDigest({ db: prisma, kind: report.kind, to: findReportEnd(report), today: findToday(), send: true });
      return reply({ sent: true, period, caption });
    },
  );

  server.registerTool(
    'send_chart',
    {
      description:
        'Малює графік і надсилає власнику в Telegram. Числа бери з інших інструментів, нічого не вигадуй. bar: категорії чи отримувачі; column: значення по місяцях; line: динаміка, як-от net worth. До трьох рядів, у кожному по значенню на мітку. Мітки місяців короткі: «січ», «лют 26».',
      inputSchema: ChartSchema,
    },
    async (chart) => {
      await sendTelegramPhoto({ ...requireTelegramOwner(), png: await renderChart(chart), caption: chart.title });
      return reply({ sent: true });
    },
  );

  server.registerTool(
    'add_transactions',
    {
      description:
        'Додає записи. Сума завжди додатна, знак дає type: expense і income потребують category; transfer — toAccountId (і toAmount, коли валюти різні); valuation — переоцінка зі знаком.',
      inputSchema: CreateTransactionsSchema,
    },
    async ({ items }) => {
      const { transactions, notices } = await trackChatWrite({
        db: prisma,
        batchId: requireBatch(batchId),
        ids: [],
        write: () => createTransactions({ db: prisma, items, source: 'claude' }),
        listCreated: (result) => result.transactions.map((transaction) => transaction.id),
      });
      return reply({ created: transactions.map((row) => ModelRowSchema.parse(row)), notices });
    },
  );

  server.registerTool(
    'update_transaction',
    {
      description:
        'Змінює запис: patch містить лише поля, що міняються. Зміна категорії, типу чи toAccountId знімає запис із перевірки.',
      inputSchema: UpdateInputSchema,
    },
    async ({ id, patch }) => {
      const updated = await trackChatWrite({
        db: prisma,
        batchId: requireBatch(batchId),
        ids: [id],
        write: () => updateTransaction({ db: prisma, id, patch }),
      });
      return reply(ModelRowSchema.parse(updated));
    },
  );

  server.registerTool(
    'delete_transaction',
    {
      description: 'Видаляє запис. Банківський рядок синк після цього не поверне. Для дублів краще merge_transactions.',
      inputSchema: IdParamsSchema,
      annotations: { destructiveHint: true },
    },
    async ({ id }) => {
      await trackChatWrite({ db: prisma, batchId: requireBatch(batchId), ids: [id], write: () => deleteTransaction({ db: prisma, id }) });
      return reply({ deleted: id });
    },
  );

  server.registerTool(
    'merge_transactions',
    {
      description:
        'Зливає дубль: рядок id зникає, його банківський звʼязок переходить до intoId (зазвичай запис, внесений вручну). Суми intoId лишаються як є.',
      inputSchema: MergeInputSchema,
      annotations: { destructiveHint: true },
    },
    async ({ id, intoId }) => {
      const kept = await trackChatWrite({
        db: prisma,
        batchId: requireBatch(batchId),
        ids: [id, intoId],
        write: () => mergeTransaction({ db: prisma, id, intoId }),
      });
      return reply(ModelRowSchema.parse(kept));
    },
  );

  if (splitwiseProvider.isConfigured()) registerSplitwiseTools({ server, batchId });
  return server;
};

/**
 * Stateless Streamable HTTP: one server per request, so nothing outlives a call. The chat bot is
 * the only client; it sends `x-chat-batch` to tie the writes of one message together.
 */
export const chatMcpRoutes: FastifyPluginAsyncZod = async (app) => {
  app.route({
    method: ['GET', 'POST', 'DELETE'],
    url: '/mcp',
    handler: async (request, response) => {
      const batchId = z.uuid().safeParse(request.headers['x-chat-batch']).data;
      const server = buildChatServer({ app, batchId });
      const transport = new StreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
      response.hijack();
      response.raw.on('close', () => {
        void transport.close();
        void server.close();
      });
      await server.connect(transport);
      await transport.handleRequest(request.raw, response.raw, request.body);
    },
  });
};
