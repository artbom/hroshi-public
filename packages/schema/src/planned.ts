import { z } from 'zod';

import { CurrencySchema, IsoDateSchema } from './primitives.ts';

/** confirmed: a real planned payment on the owner's terms; ignored: not regular, stop expecting it. */
export const PlannedStatusSchema = z.enum(['confirmed', 'ignored']);
export type PlannedStatus = z.infer<typeof PlannedStatusSchema>;

/** The owner's word on a detected recurring payment, keyed like detection: the normalised payee. */
export const PlannedOverrideSchema = z.object({
  key: z.string().min(1),
  status: PlannedStatusSchema,
  name: z.string().nullable(),
  amount: z.number().nullable(),
  currency: CurrencySchema.nullable(),
  /** A day past a month's end means its last day. */
  dayOfMonth: z.number().int().min(1).max(31).nullable(),
  accountId: z.string().nullable(),
  category: z.string().nullable(),
});
export type PlannedOverride = z.infer<typeof PlannedOverrideSchema>;

const PlannedNameSchema = z.string().trim().min(1).max(80);

/** Confirming states the owner's terms; «не регулярний» needs only the key. */
export const PlannedInputSchema = z.discriminatedUnion('status', [
  z.object({
    key: PlannedOverrideSchema.shape.key,
    status: z.literal('confirmed'),
    name: PlannedNameSchema.optional(),
    amount: z.number().positive().finite(),
    currency: CurrencySchema,
    dayOfMonth: z.number().int().min(1).max(31),
    accountId: z.string().min(1),
    category: z.string().min(1),
  }),
  z.object({
    key: PlannedOverrideSchema.shape.key,
    status: z.literal('ignored'),
    name: PlannedNameSchema.optional(),
  }),
]);
export type PlannedInput = z.infer<typeof PlannedInputSchema>;

export const PlannedKeyQuerySchema = z.object({ key: PlannedOverrideSchema.shape.key });
export type PlannedKeyQuery = z.infer<typeof PlannedKeyQuerySchema>;

/** A payee the owner has entered before, with what a new entry for it most likely looks like. */
export const QuickAddPayeeSchema = z.object({
  name: z.string(),
  category: z.string(),
  accountId: z.string(),
  /** Median of the recent amounts, in the currency of the latest one. */
  amount: z.number(),
  currency: CurrencySchema,
  count: z.number().int(),
  lastDate: IsoDateSchema,
});
export type QuickAddPayee = z.infer<typeof QuickAddPayeeSchema>;

export const QuickAddSchema = z.object({
  /** The personal account and category of the latest hand entry: where the next one most likely goes. */
  accountId: z.string().nullable(),
  category: z.string().nullable(),
  /** Payees from history, most frequent first: autocomplete, and what picking one pre-fills. */
  payees: z.array(QuickAddPayeeSchema),
  /** The latest distinct hand entries, to repeat in one tap. */
  templates: z.array(QuickAddPayeeSchema),
});
export type QuickAdd = z.infer<typeof QuickAddSchema>;
