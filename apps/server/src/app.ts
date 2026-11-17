import { existsSync } from 'node:fs';

import fastifyStatic from '@fastify/static';
import Fastify from 'fastify';
import { serializerCompiler, validatorCompiler, type ZodTypeProvider } from 'fastify-type-provider-zod';

import { accountRoutes } from './accounts/routes.ts';
import { analyticsRoutes } from './analytics/routes.ts';
import { budgetRoutes } from './budget/routes.ts';
import { categoryRoutes } from './categories/routes.ts';
import { chatMcpRoutes } from './chat/mcp.ts';
import { env } from './env.ts';
import { exportRoutes } from './export/routes.ts';
import { insightRoutes } from './insights/routes.ts';
import { investmentRoutes } from './investments/routes.ts';
import { payeeRoutes } from './payees/routes.ts';
import { plannedRoutes } from './planned/routes.ts';
import { reviewRoutes } from './review/routes.ts';
import { ruleRoutes } from './rules/routes.ts';
import { syncRoutes } from './sync/routes.ts';
import { transactionRoutes } from './transactions/routes.ts';

export const buildApp = async () => {
  const app = Fastify({
    logger: {
      level: 'info',
      // Provider tokens travel in headers; keep them out of the logs.
      redact: ['req.headers["x-token"]', 'req.headers.authorization'],
    },
  }).withTypeProvider<ZodTypeProvider>();

  app.setValidatorCompiler(validatorCompiler);
  app.setSerializerCompiler(serializerCompiler);

  await app.register(
    async (api) => {
      await api.register(accountRoutes);
      await api.register(transactionRoutes);
      await api.register(analyticsRoutes);
      await api.register(budgetRoutes);
      await api.register(insightRoutes);
      await api.register(investmentRoutes);
      await api.register(reviewRoutes);
      await api.register(plannedRoutes);
      await api.register(payeeRoutes);
      await api.register(categoryRoutes);
      await api.register(ruleRoutes);
      await api.register(exportRoutes);
      await api.register(syncRoutes);
      await api.register(chatMcpRoutes);
    },
    { prefix: '/api' },
  );

  if (existsSync(env.WEB_DIST)) {
    await app.register(fastifyStatic, { root: env.WEB_DIST });
  }

  return app;
};
