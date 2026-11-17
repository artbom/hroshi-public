import { z } from 'zod';

import { AccountSchema } from './account.ts';
import { SpendingEffectSchema } from './analytics.ts';
import { RateUsageSchema } from './fx.ts';
import { CurrencySchema, SourceSchema } from './primitives.ts';
import { RuleSchema } from './rule.ts';
import { TransactionRowSchema } from './transaction.ts';

export const AccountRefSchema = AccountSchema.pick({ id: true, name: true, currency: true, kind: true });
export type AccountRef = z.infer<typeof AccountRefSchema>;

/** The provider's own line, read defensively from the stored payload: providers differ in shape. */
export const BankLineSchema = z.object({
  provider: z.enum(['mono', 'enable-banking']),
  /** The account whose statement the line comes from; for a transfer it may be the receiving one. */
  accountId: z.string(),
  description: z.string().nullable(),
  counterparty: z.string().nullable(),
  counterIban: z.string().nullable(),
  comment: z.string().nullable(),
  mcc: z.number().int().nullable(),
  mccName: z.string().nullable(),
  /** Signed, in the statement account's currency. */
  amount: z.number().nullable(),
  /** Signed, in the currency the card was charged in. ISO alpha code, or the numeric one when unknown. */
  operationAmount: z.number().nullable(),
  operationCurrency: z.string().nullable(),
  /** The bank's balance right after the line, credit limit taken out. */
  balanceAfter: z.number().nullable(),
  /** Exact moment for Monobank, the booking day for Enable Banking. */
  bookedAt: z.string().nullable(),
  hold: z.boolean().nullable(),
});
export type BankLine = z.infer<typeof BankLineSchema>;

/** The record against the bank's line, in the statement account's terms (signed: money in is positive). */
export const BankCheckSchema = z.object({
  accountId: z.string(),
  currency: CurrencySchema,
  /** What the bank booked; null when the line is linked but its content was never stored. */
  bankAmount: z.number().nullable(),
  recordAmount: z.number(),
  /**
   * Rows that may make up the difference: others booked from the same line (an ATM fee), and hand
   * rows on the same account and day with no bank line of their own.
   */
  companions: z.array(TransactionRowSchema),
  /** The companion that accounts for the difference: exactly when the bank's amount is known, by elimination otherwise. */
  compensatedById: z.string().nullable(),
});
export type BankCheck = z.infer<typeof BankCheckSchema>;

export const TransactionOriginSchema = z.object({
  source: SourceSchema,
  /** Linked to a bank or exchange line, so sync keeps it up to date. */
  linked: z.boolean(),
  externalId: z.string().nullable(),
  toExternalId: z.string().nullable(),
  bankLine: BankLineSchema.nullable(),
  /** A hand entry whose amount the owner estimated («орієнтовно»). */
  estimated: z.boolean(),
  createdAt: z.iso.datetime(),
});
export type TransactionOrigin = z.infer<typeof TransactionOriginSchema>;

/**
 * Why the row is booked the way it is: a rule, the structure of the money (own transfer, P2P,
 * ATM, a cancellation of an earlier purchase), the owner's hand, an import, or the fallback.
 */
export const ClassificationVerdictSchema = z.enum([
  'rule',
  'own-transfer',
  'p2p',
  'atm',
  'cancellation',
  'valuation',
  'manual',
  'imported',
  'fallback',
]);
export type ClassificationVerdict = z.infer<typeof ClassificationVerdictSchema>;

export const ClassificationSchema = z.object({
  verdict: ClassificationVerdictSchema,
  /** The rule that matches the row today, whether or not it decided the booking. */
  rule: RuleSchema.nullable(),
  /** The matching rule would book the row differently: the owner changed it by hand. */
  overridden: z.boolean(),
  effect: SpendingEffectSchema,
});
export type Classification = z.infer<typeof ClassificationSchema>;

export const TransactionExplainSchema = z.object({
  transaction: TransactionRowSchema,
  account: AccountRefSchema,
  target: AccountRefSchema.nullable(),
  origin: TransactionOriginSchema,
  classification: ClassificationSchema,
  /** Who the money went to or came from, normalised as the payee lists show it. */
  payee: z.object({ key: z.string(), name: z.string(), pattern: z.string() }),
  /** The rate that turned `amount` into `transaction.eur`; null when none is known. */
  fx: RateUsageSchema.nullable(),
  /** Units of the target currency per unit sent, for a transfer between currencies with a known credit. */
  transferRate: z.number().nullable(),
  /** The other rows of the same money move (see `chainId`). */
  related: z.array(TransactionRowSchema),
  /** The money move as a whole: what it cost once holds, releases and instalment refunds net out. */
  chain: z
    .object({
      kind: z.enum(['hold', 'instalment', 'sale', 'split']),
      /** Net spending of the move in EUR; zero for a sale, which only moves money. */
      netEur: z.number(),
      rows: z.number().int(),
    })
    .nullable(),
  /** The bank line split into parts: the parent row and every part, whichever of them is explained. */
  split: z
    .object({
      parent: TransactionRowSchema,
      parts: z.array(TransactionRowSchema),
    })
    .nullable(),
  twin: z
    .object({
      /** duplicates: this bank line probably repeats the twin; duplicatedBy: the twin repeats this row. */
      relation: z.enum(['duplicates', 'duplicatedBy']),
      transaction: TransactionRowSchema,
    })
    .nullable(),
  /** A bank-linked row whose amount departs from the bank's line, or whose line was never stored. */
  bankCheck: BankCheckSchema.nullable(),
});
export type TransactionExplain = z.infer<typeof TransactionExplainSchema>;
