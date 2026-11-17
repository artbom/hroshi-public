import { z } from 'zod';

import { IncomeRoleSchema, IsoDateSchema } from './primitives.ts';

export const CategorySchema = z.object({
  name: z.string().min(1),
  forExpense: z.boolean(),
  forIncome: z.boolean(),
  incomeRole: IncomeRoleSchema,
  countsAsSpending: z.boolean(),
  monthlyLimitEur: z.number().nullable(),
  order: z.number().int(),
  archived: z.boolean(),
  /** One level only: analytics roll a subcategory up into this one. */
  parent: z.string().nullable(),
});
export type Category = z.infer<typeof CategorySchema>;

export const CategoryListSchema = z.array(CategorySchema);

export const CategoryParamsSchema = z.object({ name: z.string().min(1) });

const CategoryNameSchema = z.string().trim().min(1).max(40);

/** A new category is either somewhere money goes or a source of income; refunds net into expense ones. */
export const CreateCategorySchema = z.object({
  name: CategoryNameSchema,
  kind: z.enum(['expense', 'income']),
});
export type CreateCategory = z.infer<typeof CreateCategorySchema>;

/**
 * Renaming moves every row and rule with it; archiving only hides the name from pickers; `parent`
 * nests it one level under another category of the same kind (null takes it out again).
 */
export const UpdateCategorySchema = z
  .object({
    name: CategoryNameSchema.optional(),
    archived: z.boolean().optional(),
    parent: CategoryNameSchema.nullable().optional(),
  })
  .refine((patch) => patch.name !== undefined || patch.archived !== undefined || patch.parent !== undefined, {
    message: 'Nothing to change',
  });
export type UpdateCategory = z.infer<typeof UpdateCategorySchema>;

export const CategoryUsageSchema = z.object({
  name: CategorySchema.shape.name,
  rows: z.number().int(),
  rules: z.number().int(),
  lastDate: IsoDateSchema.nullable(),
  /** The fallback the sync and the money rules rely on: it can be neither renamed nor archived. */
  locked: z.boolean(),
});
export type CategoryUsage = z.infer<typeof CategoryUsageSchema>;

export const CategoryUsageListSchema = z.array(CategoryUsageSchema);

export const SetLimitSchema = z.object({
  monthlyLimitEur: z.number().positive().finite().nullable(),
});
