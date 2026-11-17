import { PlannedInputSchema, PlannedKeyQuerySchema, PlannedOverrideSchema, QuickAddSchema } from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { notFound } from '../http-errors.ts';
import { loadLedger } from '../ledger.ts';
import { describeQuickAdd } from './quick-add.ts';
import { savePlannedOverride } from './store.ts';

/** Planned payments (the owner's word on detected recurring ones) and quick-add helpers. */
export const plannedRoutes: FastifyPluginAsyncZod = async (app) => {
  app.put(
    '/planned',
    { schema: { body: PlannedInputSchema, response: { 200: PlannedOverrideSchema } } },
    async (request) => savePlannedOverride({ db: prisma, input: request.body }),
  );

  /** Back to what detection says. */
  app.delete('/planned', { schema: { querystring: PlannedKeyQuerySchema } }, async (request, reply) => {
    const { count } = await prisma.plannedPayment.deleteMany({ where: { key: request.query.key } });
    if (count === 0) throw notFound(`Planned payment "${request.query.key}" not found`);
    reply.code(204);
  });

  app.get('/quick-add', { schema: { response: { 200: QuickAddSchema } } }, async () => {
    const { accounts, transactions } = await loadLedger(prisma);
    return describeQuickAdd({ accounts, transactions, today: findToday() });
  });
};
