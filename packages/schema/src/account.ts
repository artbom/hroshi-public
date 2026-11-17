import { z } from 'zod';

import { BalanceCheckSchema } from './checks.ts';
import { AccountKindSchema, CurrencySchema, IsoDateSchema, SourceSchema } from './primitives.ts';
import { TransactionRowSchema } from './transaction.ts';

export const AccountSchema = z.object({
  id: z.string().min(1),
  name: z.string().min(1),
  currency: CurrencySchema,
  kind: AccountKindSchema,
  bank: z.string().nullable(),
  openingBalance: z.number(),
  openingDate: IsoDateSchema,
  creditLimit: z.number().nullable(),
  order: z.number().int(),
  note: z.string().nullable(),
  archived: z.boolean(),
  passThrough: z.boolean(),
  syncSource: SourceSchema.nullable(),
  /** Loans only: who owes, or is owed, the money. */
  counterparty: z.string().nullable(),
  /** Loans only: when the money is due back. */
  dueDate: IsoDateSchema.nullable(),
});
export type Account = z.infer<typeof AccountSchema>;

export const AccountBalanceSchema = z.object({
  ...AccountSchema.shape,
  balance: z.number(),
  /** Date of the latest valuation row; null for an account never revalued (its balance is the opening one). */
  valuedAt: IsoDateSchema.nullable(),
  /** Newest row touching the account: how fresh a hand-kept account is. */
  lastRowDate: IsoDateSchema.nullable(),
  /** The latest comparison with the bank or broker, when one exists. */
  check: BalanceCheckSchema.nullable(),
});
export type AccountBalance = z.infer<typeof AccountBalanceSchema>;

export const AccountListSchema = z.array(AccountBalanceSchema);

/**
 * Who a loan is with and when it is due; only loan (receivable) accounts take it. A loan without a
 * name cannot be chased, so the name is required; an empty due date means «без строку».
 */
export const UpdateLoanSchema = z.object({
  counterparty: z.string().trim().min(1, 'Вкажи, з ким ця позика: ім’я обов’язкове').max(80, 'Не довше 80 символів'),
  dueDate: IsoDateSchema.nullable(),
});
export type UpdateLoan = z.input<typeof UpdateLoanSchema>;

export const AccountRecordQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(500).default(50),
  offset: z.coerce.number().int().min(0).default(0),
});

export const BalanceSourceSchema = z.enum(['bank', 'computed']);

/** One row of an account's statement with the balance right after it. */
export const AccountRecordSchema = z.object({
  row: TransactionRowSchema,
  /** What the row did to this account, signed. */
  delta: z.number(),
  /** The opening balance carried through every row up to this one (back-cast for history rows). */
  computedBalance: z.number(),
  /** The balance the bank printed on this line, credit limit taken out; null when the line does not say. */
  bankBalance: z.number().nullable(),
  /** Dated before the opening date: history that back-casts the balance, never moves today's. */
  history: z.boolean(),
});
export type AccountRecord = z.infer<typeof AccountRecordSchema>;

export const AccountRecordPageSchema = z.object({
  items: z.array(AccountRecordSchema),
  total: z.number().int(),
  /** First bank-linked row of a bank-synced account; null for accounts no bank reports. */
  bankSince: IsoDateSchema.nullable(),
});
export type AccountRecordPage = z.infer<typeof AccountRecordPageSchema>;
