import { z } from 'zod';

import {
  CurrencySchema,
  IsoDateSchema,
  MonthSchema,
  PositiveAmountSchema,
  SourceSchema,
  TransactionTypeSchema,
} from './primitives.ts';

export const TransactionSchema = z.object({
  id: z.string(),
  type: TransactionTypeSchema,
  date: IsoDateSchema,
  accountId: z.string(),
  amount: z.number(),
  currency: CurrencySchema,
  toAccountId: z.string().nullable(),
  toAmount: z.number().nullable(),
  toCurrency: CurrencySchema.nullable(),
  category: z.string().nullable(),
  note: z.string().nullable(),
  tags: z.array(z.string()),
  source: SourceSchema,
  needsReview: z.boolean(),
  reviewReason: z.string().nullable(),
  /** The hand entry this bank line probably duplicates. */
  duplicateOfId: z.string().nullable(),
  /** The row this one is a part of; the parent stays out of balances and analytics. */
  splitOfId: z.string().nullable(),
  /** Linked to a bank or exchange line, so sync keeps it up to date. */
  synced: z.boolean(),
  createdAt: z.iso.datetime(),
  /** The bank's own description of the payee; the owner's note may have been rewritten. */
  bankText: z.string().nullable(),
  /** EUR the card was charged, when a non-EUR card paid in euros: the price, without the bank's conversion. */
  operationEur: z.number().nullable(),
  /** Merchant category code of the bank line. */
  mcc: z.number().int().nullable(),
  /** The bank line's own amount (unsigned, row currency) when the row departs from it; null when they agree or no line is stored. */
  bankAmount: z.number().nullable(),
  /** The owner's name for the payee, when he renamed or merged it (Дані → Отримувачі). */
  payee: z.string().optional(),
});
export type Transaction = z.infer<typeof TransactionSchema>;

export const TransactionRowSchema = z.object({
  ...TransactionSchema.shape,
  /** Amount in EUR at the rate of the transaction date; null when no rate is known. */
  eur: z.number().nullable(),
  /**
   * Rows that are one money move share this id (the first row's): a card hold and its
   * cancellations, a ФОП currency sale and its onward leg to a card.
   */
  chainId: z.string().nullable(),
});
export type TransactionRow = z.infer<typeof TransactionRowSchema>;

const NoteSchema = z.string().trim().max(500);
const TagsSchema = z.array(z.string().trim().min(1).max(80)).max(20);

const NewTransactionBase = {
  date: IsoDateSchema,
  accountId: z.string().min(1),
  note: NoteSchema.optional(),
  tags: TagsSchema.optional(),
};

export const CreateTransactionSchema = z.discriminatedUnion('type', [
  z.object({
    type: z.literal('expense'),
    ...NewTransactionBase,
    amount: PositiveAmountSchema,
    category: z.string().min(1),
  }),
  z.object({
    type: z.literal('income'),
    ...NewTransactionBase,
    amount: PositiveAmountSchema,
    category: z.string().min(1),
  }),
  z.object({
    type: z.literal('transfer'),
    ...NewTransactionBase,
    amount: PositiveAmountSchema,
    toAccountId: z.string().min(1),
    /** Amount credited in the target currency. Omit when the currencies match. */
    toAmount: z.number().nonnegative().finite().optional(),
  }),
  z.object({
    type: z.literal('valuation'),
    ...NewTransactionBase,
    amount: z
      .number()
      .finite()
      .refine((value) => value !== 0, 'A valuation must change the balance'),
  }),
]);
export type CreateTransaction = z.infer<typeof CreateTransactionSchema>;

export const CreateTransactionsSchema = z.object({
  items: z.array(CreateTransactionSchema).min(1).max(500),
});

export const CreatedTransactionSchema = z.object({
  transaction: TransactionSchema,
  /** One short line when the expense pushes its category near or over the monthly limit. */
  notice: z.string().nullable(),
});
export type CreatedTransaction = z.infer<typeof CreatedTransactionSchema>;

export const CreatedTransactionsSchema = z.object({
  transactions: z.array(TransactionSchema),
  notices: z.array(z.string()),
});

export const UpdateTransactionSchema = z
  .object({
    /** Lets the review inbox turn a mis-booked expense into a transfer (P2P, own card). */
    type: TransactionTypeSchema,
    date: IsoDateSchema,
    accountId: z.string().min(1),
    amount: z.number().finite(),
    toAccountId: z.string().min(1).nullable(),
    toAmount: z.number().nonnegative().finite().nullable(),
    category: z.string().min(1).nullable(),
    note: NoteSchema.nullable(),
    tags: TagsSchema,
    needsReview: z.boolean(),
  })
  .partial();
export type UpdateTransaction = z.infer<typeof UpdateTransactionSchema>;

export const TransactionQuerySchema = z.object({
  q: z.string().trim().optional(),
  type: TransactionTypeSchema.optional(),
  category: z.string().optional(),
  accountId: z.string().optional(),
  from: MonthSchema.optional(),
  to: MonthSchema.optional(),
  needsReview: z.stringbool().optional(),
  tag: z.string().optional(),
  /** Normalised payee key, as the payee lists give it. */
  payee: z.string().optional(),
  source: SourceSchema.optional(),
  /** Size in EUR, sign ignored. */
  minEur: z.coerce.number().nonnegative().optional(),
  maxEur: z.coerce.number().nonnegative().optional(),
  sort: z.enum(['date', 'eur']).default('date'),
  dir: z.enum(['asc', 'desc']).default('desc'),
  limit: z.coerce.number().int().min(1).max(5000).default(200),
  offset: z.coerce.number().int().min(0).default(0),
});
export type TransactionQuery = z.infer<typeof TransactionQuerySchema>;

export const TransactionPageSchema = z.object({
  items: z.array(TransactionRowSchema),
  total: z.number().int(),
  expenseEur: z.number(),
  /** Income minus expenses in EUR across all matching rows, transfers excluded. */
  netEur: z.number(),
  /** Account id → day of its first bank-linked row: an unlinked import after it is an exception worth a chip. */
  bankSince: z.record(z.string(), IsoDateSchema),
});
export type TransactionPage = z.infer<typeof TransactionPageSchema>;

export const IdParamsSchema = z.object({ id: z.string().min(1) });

export const SplitPartSchema = z.object({
  category: z.string().min(1),
  amount: PositiveAmountSchema,
  note: NoteSchema.optional(),
});
export type SplitPart = z.infer<typeof SplitPartSchema>;

/** Parts of one expense or income; they must add up to the row's amount. Replaces an earlier split. */
export const SplitTransactionSchema = z.object({
  parts: z.array(SplitPartSchema).min(2).max(20),
});
export type SplitTransaction = z.infer<typeof SplitTransactionSchema>;

export const TransactionSplitSchema = z.object({
  parent: TransactionSchema,
  parts: z.array(TransactionSchema),
});
export type TransactionSplit = z.infer<typeof TransactionSplitSchema>;

/** Keeps `intoId` (usually the owner's hand entry) and folds the bank link of `:id` into it. */
export const MergeTransactionSchema = z.object({ intoId: z.string().min(1) });
