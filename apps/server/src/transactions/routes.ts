import {
  CreatedTransactionSchema,
  CreatedTransactionsSchema,
  CreateTransactionSchema,
  CreateTransactionsSchema,
  IdParamsSchema,
  MergeTransactionSchema,
  SplitTransactionSchema,
  TransactionPageSchema,
  TransactionExplainSchema,
  TransactionQuerySchema,
  TransactionSchema,
  TransactionSplitSchema,
  UpdateTransactionSchema,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { prisma } from '../db.ts';
import { loadLedger } from '../ledger.ts';
import { explainTransaction } from './explain.ts';
import { queryTransactions } from './query.ts';
import {
  createTransaction,
  createTransactions,
  deleteTransaction,
  mergeTransaction,
  splitTransaction,
  unsplitTransaction,
  updateTransaction,
} from './service.ts';

export const transactionRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get(
    '/transactions',
    { schema: { querystring: TransactionQuerySchema, response: { 200: TransactionPageSchema } } },
    async (request) => queryTransactions({ ledger: await loadLedger(prisma), query: request.query }),
  );

  app.get(
    '/transactions/:id/explain',
    { schema: { params: IdParamsSchema, response: { 200: TransactionExplainSchema } } },
    async (request) => explainTransaction({ db: prisma, id: request.params.id }),
  );

  app.post(
    '/transactions',
    { schema: { body: CreateTransactionSchema, response: { 201: CreatedTransactionSchema } } },
    async (request, reply) => {
      reply.code(201);
      return createTransaction({ db: prisma, input: request.body, source: 'page' });
    },
  );

  app.post(
    '/transactions/batch',
    { schema: { body: CreateTransactionsSchema, response: { 201: CreatedTransactionsSchema } } },
    async (request, reply) => {
      reply.code(201);
      return createTransactions({ db: prisma, items: request.body.items, source: 'page' });
    },
  );

  app.patch(
    '/transactions/:id',
    { schema: { params: IdParamsSchema, body: UpdateTransactionSchema, response: { 200: TransactionSchema } } },
    async (request) => updateTransaction({ db: prisma, id: request.params.id, patch: request.body }),
  );

  app.post(
    '/transactions/:id/merge',
    { schema: { params: IdParamsSchema, body: MergeTransactionSchema, response: { 200: TransactionSchema } } },
    async (request) => mergeTransaction({ db: prisma, id: request.params.id, intoId: request.body.intoId }),
  );

  app.put(
    '/transactions/:id/split',
    { schema: { params: IdParamsSchema, body: SplitTransactionSchema, response: { 200: TransactionSplitSchema } } },
    async (request) => splitTransaction({ db: prisma, id: request.params.id, input: request.body }),
  );

  app.delete(
    '/transactions/:id/split',
    { schema: { params: IdParamsSchema, response: { 200: TransactionSchema } } },
    async (request) => unsplitTransaction({ db: prisma, id: request.params.id }),
  );

  app.delete('/transactions/:id', { schema: { params: IdParamsSchema } }, async (request, reply) => {
    await deleteTransaction({ db: prisma, id: request.params.id });
    reply.code(204);
  });
};
