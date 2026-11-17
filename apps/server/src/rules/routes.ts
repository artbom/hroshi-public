import { auditRules, createRuleMatcher } from '@hroshi/domain';
import {
  IdParamsSchema,
  RuleInputSchema,
  RuleListSchema,
  RulePreviewInputSchema,
  RulePreviewSchema,
  RuleSchema,
  RuleStatsSchema,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { prisma } from '../db.ts';
import { notFound } from '../http-errors.ts';
import { loadLedger, toTransactionRow } from '../ledger.ts';
import { mapRule } from '../mappers.ts';
import { listRuleSubjects } from './subjects.ts';

const PREVIEW_SAMPLE = 6;

export const ruleRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/rules', { schema: { response: { 200: RuleListSchema } } }, async () =>
    (await prisma.rule.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] })).map(mapRule),
  );

  app.get('/rules/stats', { schema: { response: { 200: RuleStatsSchema } } }, async () => {
    const [rules, ledger, archivedCategories, archivedAccounts] = await Promise.all([
      prisma.rule.findMany({ orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }] }),
      loadLedger(prisma),
      prisma.category.findMany({ where: { archived: true }, select: { name: true } }),
      prisma.account.findMany({ where: { archived: true }, select: { id: true } }),
    ]);
    const audit = auditRules({
      rules: rules.map(mapRule),
      rows: listRuleSubjects(ledger),
      archivedCategories: new Set(archivedCategories.map((category) => category.name)),
      archivedAccounts: new Set(archivedAccounts.map((account) => account.id)),
    });
    return [...audit].map(([id, entry]) => ({ id, ...entry }));
  });

  /** Read-only: what a rule would catch before it is saved. */
  app.post('/rules/preview', { schema: { body: RulePreviewInputSchema, response: { 200: RulePreviewSchema } } }, async (request) => {
    const ledger = await loadLedger(prisma);
    const match = createRuleMatcher([
      { id: 'preview', ...request.body, category: null, transferToAccountId: null, priority: 0 },
    ]);
    const subjects = listRuleSubjects(ledger).filter((subject) => match(subject) !== undefined);
    const byId = new Map(ledger.transactions.map((transaction) => [transaction.id, transaction]));
    const categories = Map.groupBy(
      subjects.filter((subject) => subject.category !== null && !subject.needsReview),
      (subject) => subject.category ?? '',
    );
    return {
      matches: subjects.length,
      waiting: subjects.filter((subject) => subject.needsReview).length,
      categories: [...categories]
        .map(([category, rows]) => ({ category, count: rows.length }))
        .toSorted((left, right) => right.count - left.count),
      sample: subjects
        .toReversed()
        .slice(0, PREVIEW_SAMPLE)
        .flatMap((subject) => {
          const transaction = byId.get(subject.id);
          return transaction === undefined ? [] : [toTransactionRow(ledger, transaction)];
        }),
    };
  });

  app.post('/rules', { schema: { body: RuleInputSchema, response: { 201: RuleSchema } } }, async (request, reply) => {
    reply.code(201);
    return mapRule(await prisma.rule.create({ data: request.body }));
  });

  app.put(
    '/rules/:id',
    { schema: { params: IdParamsSchema, body: RuleInputSchema, response: { 200: RuleSchema } } },
    async (request) => {
      const { count } = await prisma.rule.updateMany({ where: { id: request.params.id }, data: request.body });
      if (count === 0) throw notFound(`Rule "${request.params.id}" not found`);
      return mapRule(await prisma.rule.findUniqueOrThrow({ where: { id: request.params.id } }));
    },
  );

  app.delete('/rules/:id', { schema: { params: IdParamsSchema } }, async (request, reply) => {
    const { count } = await prisma.rule.deleteMany({ where: { id: request.params.id } });
    if (count === 0) throw notFound(`Rule "${request.params.id}" not found`);
    reply.code(204);
  });
};
