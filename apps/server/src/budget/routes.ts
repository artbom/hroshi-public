import { type Budget, BudgetQuerySchema, BudgetSchema, type IsoDate, SavingsGoalSchema } from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { loadLedger } from '../ledger.ts';
import { composeBudget } from './compose.ts';
import { readSavingsGoal, saveSavingsGoal } from './store.ts';

const describeBudget = async (asOf: IsoDate): Promise<Budget> => {
  const goal = await readSavingsGoal(prisma);
  if (goal === null) return { goal, budget: null };
  return { goal, budget: await composeBudget({ db: prisma, ledger: await loadLedger(prisma), goal, asOf, today: findToday() }) };
};

export const budgetRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/budget', { schema: { querystring: BudgetQuerySchema, response: { 200: BudgetSchema } } }, async (request) =>
    describeBudget(request.query.asOf ?? findToday()),
  );

  app.put('/budget/goal', { schema: { body: SavingsGoalSchema, response: { 200: BudgetSchema } } }, async (request) => {
    await saveSavingsGoal({ db: prisma, goal: request.body });
    return describeBudget(findToday());
  });
};
