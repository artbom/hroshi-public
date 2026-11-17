import { z } from 'zod';

import { IsoDateSchema } from './primitives.ts';

/** A payee as the domain keys it: the normalised bank text. */
export const PayeeKeySchema = z.string().min(1);

/**
 * Who a counterparty is, as far as the money rules care: own (the owner's own name, his jars),
 * cash (an ATM), tax (ДПС, the treasury), person (a private person) or merchant (everything else).
 */
export const PayeeKindSchema = z.enum(['merchant', 'person', 'own', 'cash', 'tax']);
export type PayeeKind = z.infer<typeof PayeeKindSchema>;

/** The domain cuts a payee name at a comma, a «·» or a bracket and keeps 40 characters, so a name may not carry them. */
export const PayeeNameSchema = z
  .string()
  .trim()
  .min(1)
  .max(40)
  .regex(/^[^,·()]+$/u, 'Без ком, «·» і дужок');

/** One spelling of a payee the bank used, before any rename. */
export const PayeeMemberSchema = z.object({
  key: PayeeKeySchema,
  name: z.string(),
  count: z.number().int(),
});
export type PayeeMember = z.infer<typeof PayeeMemberSchema>;

export const PayeeEntrySchema = z.object({
  /** The key the rest of the app filters on: after renames and merges. */
  key: PayeeKeySchema,
  name: z.string(),
  /** The owner's name for it, when he renamed or merged it. */
  alias: z.string().nullable(),
  kind: PayeeKindSchema,
  /** The owner set the kind; otherwise it is detected from the bank text. */
  kindByOwner: z.boolean(),
  count: z.number().int(),
  /** Net spending in EUR (refunds subtract), and earnings in EUR. */
  spentEur: z.number(),
  receivedEur: z.number(),
  category: z.string().nullable(),
  lastDate: IsoDateSchema,
  /** The bank spellings renamed into it; empty while it is just its own spelling, whose key is `key`. */
  members: z.array(PayeeMemberSchema),
});
export type PayeeEntry = z.infer<typeof PayeeEntrySchema>;

export const PayeeDirectorySchema = z.object({
  payees: z.array(PayeeEntrySchema),
  /** «Схожі назви»: groups of payee keys that are probably one payee, busiest first; nothing is merged until the owner says so. */
  similar: z.array(z.array(PayeeKeySchema).min(2)),
});
export type PayeeDirectory = z.infer<typeof PayeeDirectorySchema>;

/**
 * Renames, merges or re-kinds payees by their bank spellings: every key gets the same name, so they
 * read as one payee. A field left out stays as it is; null clears it, and a key left with neither is forgotten.
 */
export const SavePayeeAliasesSchema = z
  .object({
    keys: z.array(PayeeKeySchema).min(1).max(500),
    name: PayeeNameSchema.nullable().optional(),
    kind: PayeeKindSchema.nullable().optional(),
  })
  .refine((input) => input.name !== undefined || input.kind !== undefined, { message: 'Nothing to change' });
export type SavePayeeAliases = z.infer<typeof SavePayeeAliasesSchema>;

export const SavedPayeeAliasesSchema = z.object({ updated: z.number().int() });
export type SavedPayeeAliases = z.infer<typeof SavedPayeeAliasesSchema>;
