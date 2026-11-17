import { FALLBACK_CATEGORY } from '@hroshi/domain';
import {
  CategoryListSchema,
  CategoryParamsSchema,
  CategorySchema,
  CategoryUsageListSchema,
  CreateCategorySchema,
  SetLimitSchema,
  UpdateCategorySchema,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';

import { prisma } from '../db.ts';
import { badRequest, conflict, notFound } from '../http-errors.ts';
import { mapCategory, toIsoDate } from '../mappers.ts';

type NestedCategory = { name: string; forExpense: boolean; forIncome: boolean; parent: string | null };

/** Why `category` cannot sit under `parent`, or null when it can: one level only, same kind, never under the fallback. */
const explainParentRefusal = ({
  category,
  parent,
  parentName,
  hasChildren,
}: {
  category: NestedCategory;
  parent: NestedCategory | null;
  parentName: string;
  hasChildren: boolean;
}): string | null => {
  if (parent === null) return `Категорії «${parentName}» немає`;
  if (parent.name === category.name) return 'Категорія не може бути дочірньою сама собі';
  if (parent.name === FALLBACK_CATEGORY) return `«${FALLBACK_CATEGORY}» — запасна категорія, під неї не вкладають`;
  if (parent.parent !== null) return `«${parent.name}» сама дочірня до «${parent.parent}»: вкладеність лише на один рівень`;
  if (hasChildren) return `У «${category.name}» є дочірні категорії: вкладеність лише на один рівень`;
  if (parent.forExpense !== category.forExpense || parent.forIncome !== category.forIncome) {
    return `«${parent.name}» іншого виду: витрати вкладають лише у витрати, доходи — у доходи`;
  }
  return null;
};

export const categoryRoutes: FastifyPluginAsyncZod = async (app) => {
  app.get('/categories', { schema: { response: { 200: CategoryListSchema } } }, async () =>
    (await prisma.category.findMany({ orderBy: { order: 'asc' } })).map(mapCategory),
  );

  /** How much each category is used, so archiving or renaming one is a decision made with the numbers in view. */
  app.get('/categories/usage', { schema: { response: { 200: CategoryUsageListSchema } } }, async () => {
    const [categories, rows, rules] = await Promise.all([
      prisma.category.findMany({ orderBy: { order: 'asc' }, select: { name: true } }),
      prisma.transaction.findMany({ where: { category: { not: null } }, select: { category: true, date: true } }),
      prisma.rule.findMany({ where: { category: { not: null } }, select: { category: true } }),
    ]);
    const rowsBy = Map.groupBy(rows, (row) => row.category);
    const rulesBy = Map.groupBy(rules, (rule) => rule.category);
    return categories.map(({ name }) => {
      const used = rowsBy.get(name) ?? [];
      const last = used.reduce<Date | null>((latest, row) => (latest === null || row.date > latest ? row.date : latest), null);
      return {
        name,
        rows: used.length,
        rules: rulesBy.get(name)?.length ?? 0,
        lastDate: last === null ? null : toIsoDate(last),
        locked: name === FALLBACK_CATEGORY,
      };
    });
  });

  app.post('/categories', { schema: { body: CreateCategorySchema, response: { 201: CategorySchema } } }, async (request, reply) => {
    const { name, kind } = request.body;
    const created = await prisma.$transaction(async (db) => {
      if ((await db.category.findUnique({ where: { name } })) !== null) throw conflict(`Категорія «${name}» вже є`);
      const last = await db.category.findFirst({ orderBy: { order: 'desc' }, select: { order: true } });
      return db.category.create({
        data: {
          name,
          forExpense: kind === 'expense',
          forIncome: kind === 'income',
          // An expense category takes refunds into itself; an income one is earnings.
          incomeRole: kind === 'expense' ? 'netting' : 'earning',
          order: (last?.order ?? 0) + 1,
        },
      });
    });
    return reply.code(201).send(mapCategory(created));
  });

  /**
   * The name is the key rows and rules point at, with ON UPDATE CASCADE, so one update renames
   * the category everywhere at once; the checks around it share its transaction.
   */
  app.patch(
    '/categories/:name',
    { schema: { params: CategoryParamsSchema, body: UpdateCategorySchema, response: { 200: CategorySchema } } },
    async (request) => {
      const current = request.params.name;
      const { name: next, archived, parent } = request.body;
      const updated = await prisma.$transaction(async (db) => {
        const category = await db.category.findUnique({ where: { name: current } });
        if (category === null) throw notFound(`Категорії «${current}» немає`);
        if (current === FALLBACK_CATEGORY) throw badRequest(`«${FALLBACK_CATEGORY}» — запасна категорія синхронізації, її не можна змінити`);
        if (next !== undefined && next !== current && (await db.category.findUnique({ where: { name: next } })) !== null) {
          throw conflict(`Категорія «${next}» вже є`);
        }
        if (parent !== undefined && parent !== null) {
          const refusal = explainParentRefusal({
            category,
            parent: await db.category.findUnique({ where: { name: parent } }),
            parentName: parent,
            hasChildren: (await db.category.count({ where: { parent: current } })) > 0,
          });
          if (refusal !== null) throw badRequest(refusal);
        }
        return db.category.update({
          where: { name: current },
          data: {
            ...(next === undefined ? {} : { name: next }),
            ...(archived === undefined ? {} : { archived }),
            ...(parent === undefined ? {} : { parent }),
          },
        });
      });
      return mapCategory(updated);
    },
  );

  app.put(
    '/categories/:name/limit',
    { schema: { params: CategoryParamsSchema, body: SetLimitSchema, response: { 200: CategorySchema } } },
    async (request) => {
      const { count } = await prisma.category.updateMany({
        where: { name: request.params.name },
        data: { monthlyLimitEur: request.body.monthlyLimitEur },
      });
      if (count === 0) throw notFound(`Category "${request.params.name}" not found`);
      return mapCategory(await prisma.category.findUniqueOrThrow({ where: { name: request.params.name } }));
    },
  );
};
