import { z } from 'zod';

import { PayeeKindSchema } from './payees.ts';
import { PlannedOverrideSchema } from './planned.ts';
import { CurrencySchema, IsoDateSchema, MonthSchema } from './primitives.ts';
import { TransactionRowSchema } from './transaction.ts';

/** A hand entry whose amount the owner estimated carries this word in its note. */
export const ESTIMATE_MARKER = 'орієнтовно';

export const PeriodQuerySchema = z.object({
  from: MonthSchema.optional(),
  to: MonthSchema.optional(),
});

export const PayeeSchema = z.object({
  /** Normalised key: what the table search uses to find the payee's rows. */
  key: z.string(),
  name: z.string(),
  /**
   * The bank named no one (a masked card, «Щомісячний платіж», no text): `name` is then the
   * category, and the rows are found in the review inbox rather than by payee.
   */
  unnamed: z.boolean(),
  /** Net of refunds and cancellations. */
  eur: z.number(),
  count: z.number().int(),
  /** The category most of the money went to. */
  category: z.string(),
  lastDate: IsoDateSchema,
});
export type Payee = z.infer<typeof PayeeSchema>;

export const IncomeSourceSchema = z.object({
  key: z.string(),
  name: z.string(),
  eur: z.number(),
  count: z.number().int(),
  category: z.string(),
  lastDate: IsoDateSchema,
  /** Months in the period with money from this payer. */
  months: z.number().int(),
});
export type IncomeSource = z.infer<typeof IncomeSourceSchema>;

export const PayeesSchema = z.object({
  from: MonthSchema,
  to: MonthSchema,
  payees: z.array(PayeeSchema),
  incomeSources: z.array(IncomeSourceSchema),
});
export type Payees = z.infer<typeof PayeesSchema>;

export const RecurringPaymentSchema = z.object({
  key: z.string(),
  name: z.string(),
  category: z.string(),
  /** The account the latest payment left from, to book the next one the same way. */
  accountId: z.string(),
  /** Median of the occurrences, in the currency of the latest one. */
  amount: z.number(),
  currency: CurrencySchema,
  eur: z.number(),
  occurrences: z.number().int(),
  /** Median days between payments. */
  cadenceDays: z.number(),
  lastDate: IsoDateSchema,
  nextDate: IsoDateSchema,
  /** The next payment is well past due: cancelled, moved to another card, or not booked yet. */
  late: z.boolean(),
  /** detected: inferred from history; confirmed: the owner's terms (amount, day, account, category) win. */
  status: z.enum(['detected', 'confirmed']),
  /** The owner's due day of the month; null while only detected. */
  dayOfMonth: z.number().int().nullable(),
  /** Days the next payment is past due; 0 while it is not due yet. */
  overdueDays: z.number().int(),
});
export type RecurringPayment = z.infer<typeof RecurringPaymentSchema>;

export const RecurringSchema = z.object({
  payments: z.array(RecurringPaymentSchema),
  /** Sum of the payments that are not late, per month. */
  monthlyEur: z.number(),
  since: IsoDateSchema,
  /** What the owner marked as not regular: out of the expected list and the monthly sum. */
  ignored: z.array(PlannedOverrideSchema),
});
export type Recurring = z.infer<typeof RecurringSchema>;

export const MonthQualitySchema = z.object({
  month: MonthSchema,
  rows: z.number().int(),
  /** Linked to a bank or exchange line. */
  bank: z.number().int(),
  /** Imported from ZenMoney and never matched to a bank line. */
  zenmoney: z.number().int(),
  /** Entered by hand or by Claude, not matched to a bank line. */
  hand: z.number().int(),
  /** Hand entries with an estimated amount. */
  estimated: z.number().int(),
  review: z.number().int(),
  hasIncome: z.boolean(),
  sparse: z.boolean(),
  partial: z.boolean(),
  status: z.enum(['complete', 'sparse', 'missing', 'partial']),
});
export type MonthQuality = z.infer<typeof MonthQualitySchema>;

export const DataQualityQuerySchema = z.object({
  months: z.coerce.number().int().min(1).max(120).default(24),
});

export const DataQualitySchema = z.object({ months: z.array(MonthQualitySchema) });
export type DataQuality = z.infer<typeof DataQualitySchema>;

/**
 * What trip money went on, by merchant code: getting there and around, a bed, food, things to do,
 * the rest, and money friends sent back (negative).
 */
export const TripSpendKindSchema = z.enum(['transport', 'stay', 'food', 'fun', 'other', 'returns']);
export type TripSpendKind = z.infer<typeof TripSpendKindSchema>;

export const TagSummarySchema = z.object({
  tag: z.string(),
  /** Spending net of refunds, so a friend's Splitwise share comes off the trip. */
  eur: z.number(),
  rows: z.number().int(),
  from: IsoDateSchema,
  to: IsoDateSchema,
  categories: z.array(z.object({ category: z.string(), eur: z.number() })),
});
export type TagSummary = z.infer<typeof TagSummarySchema>;

export const TagListSchema = z.array(TagSummarySchema);

/** A tag read as a trip: how long it lasted and what its money went on. */
export const TripSummarySchema = z.object({
  ...TagSummarySchema.shape,
  /** Calendar days from the first row to the last, both counted. */
  days: z.number().int(),
  /** The same spending by merchant code, biggest first. */
  kinds: z.array(z.object({ kind: TripSpendKindSchema, eur: z.number() })),
});
export type TripSummary = z.infer<typeof TripSummarySchema>;

/** Tags whose days touch the period, and the travel spending of the period without a trip tag. */
export const TripReportSchema = z.object({
  from: MonthSchema,
  to: MonthSchema,
  tags: z.array(TripSummarySchema),
  /** Null until a tagged trip shows which category trips are booked under. */
  untagged: z.object({ category: z.string(), eur: z.number(), rows: z.number().int() }).nullable(),
});
export type TripReport = z.infer<typeof TripReportSchema>;

const MonthTotalsSchema = z.object({
  incomeEur: z.number(),
  /** Spending net of refunds: the categories minus `refundEur`. */
  spendEur: z.number(),
  /** Refunds booked to no category («Повернення»); they come off the total, so tables show them as their own row. */
  refundEur: z.number(),
  categories: z.record(z.string(), z.number()),
});

export const MonthComparisonSchema = z.object({
  month: MonthSchema,
  current: MonthTotalsSchema,
  /** Average of the complete months among the `averageMonths` before this one. */
  average: MonthTotalsSchema,
  /** Months the average uses and the ones it leaves out, with why. */
  averageMonths: z.array(z.object({ month: MonthSchema, used: z.boolean(), reason: z.enum(['used', 'sparse', 'noIncome', 'partial']) })),
  lastYear: MonthTotalsSchema.nullable(),
  lastYearSparse: z.boolean(),
  /** For the running month only: where spending is heading. */
  projection: z
    .object({
      spendEur: z.number(),
      /** Monthly payments due this month that are not in the ledger yet. */
      expected: z.array(RecurringPaymentSchema),
      expectedEur: z.number(),
      /** The same expected payments per category, so a rent not booked yet is not read as a saving. */
      expectedByCategory: z.record(z.string(), z.number()),
      /** Everyday spending so far, carried on at the same pace for the days left. */
      paceEur: z.number(),
      /** The same pace split by each category's own everyday spending, so the categories' forecasts add up to the month's. */
      paceByCategory: z.record(z.string(), z.number()),
      savedEur: z.number(),
    })
    .nullable(),
  /** Days of the month already behind us; equals daysInMonth for a finished month. */
  daysElapsed: z.number().int(),
  daysInMonth: z.number().int(),
});
export type MonthComparison = z.infer<typeof MonthComparisonSchema>;

export const SuggestionConfidenceSchema = z.enum(['high', 'medium', 'low']);
export type SuggestionConfidence = z.infer<typeof SuggestionConfidenceSchema>;

export const CategorySuggestionSchema = z.object({
  category: z.string(),
  basis: z.enum(['payee', 'mcc']),
  /** One line for the owner: why this category. */
  reason: z.string(),
  /** high: the payee went to this category several times and almost always; one past row or an MCC guess is low. */
  confidence: SuggestionConfidenceSchema,
});
export type CategorySuggestion = z.infer<typeof CategorySuggestionSchema>;

export const ReviewImpactSchema = z.object({
  /** spend: in a category's spending (negative eur nets it down); income: earnings; refund: off total spending. */
  kind: z.enum(['spend', 'income', 'refund', 'none']),
  category: z.string().nullable(),
  eur: z.number(),
});
export type ReviewImpact = z.infer<typeof ReviewImpactSchema>;

/** A payee's kind, plus card (a masked card number: maybe one of the owner's) and generic bank wording. */
export const ReviewKindSchema = z.enum([...PayeeKindSchema.options, 'card', 'generic']);
export type ReviewKind = z.infer<typeof ReviewKindSchema>;

export const ReviewGroupSchema = z.object({
  key: z.string(),
  name: z.string(),
  /** card: a transfer to a masked card; person: to a private person; generic: bank wording like «Розстрочка». */
  kind: ReviewKindSchema,
  /** The owner set the kind on the payee, so the inbox does not ask again. */
  kindByOwner: z.boolean(),
  /** Keys of the bank spellings in the group: the owner's answers about the payee are stored under them. */
  bankKeys: z.array(z.string()),
  /** What a rule for this payee should look for in the bank line. */
  pattern: z.string(),
  /** Rows in the whole ledger the pattern would catch. */
  patternHits: z.number().int(),
  /** A rule is worth creating by default only for a named merchant. */
  ruleByDefault: z.boolean(),
  totalEur: z.number(),
  latestDate: IsoDateSchema,
  /** A purchase the row probably belongs to: the original of a cancellation or an instalment refund. */
  pairs: z.record(z.string(), TransactionRowSchema),
  rows: z.array(TransactionRowSchema),
  suggestion: CategorySuggestionSchema.nullable(),
  /** Up to three categories to offer in one click when nothing is guessed: by the payee's kind, its MCC, then overall use. */
  candidates: z.array(z.string()),
  /** Parked by the owner until this day; a new row from the same payee brings the group back. */
  snoozedUntil: IsoDateSchema.nullable(),
  /** Rows a bank line probably duplicates, keyed by the bank line's id. */
  twins: z.record(z.string(), TransactionRowSchema),
  /** How the rows count in analytics right now, biggest first: what leaving them as they are means. */
  impact: z.array(ReviewImpactSchema),
  /** Groups to answer first: the purchase a refund here belongs to is itself still waiting. */
  dependsOn: z.array(z.string()),
});
export type ReviewGroup = z.infer<typeof ReviewGroupSchema>;

export const ReviewInboxSchema = z.object({
  /** Rows waiting for an answer, parked ones included. */
  total: z.number().int(),
  /** Of them, rows the owner parked for later. */
  snoozed: z.number().int(),
  groups: z.array(ReviewGroupSchema),
});
export type ReviewInbox = z.infer<typeof ReviewInboxSchema>;

/** The navigation badge: rows still waiting, parked ones left out. */
export const ReviewCountSchema = z.object({ waiting: z.number().int(), snoozed: z.number().int() });
export type ReviewCount = z.infer<typeof ReviewCountSchema>;

/** Parks rows in the inbox until a day, or brings them back with null. */
export const SnoozeReviewSchema = z.object({
  ids: z.array(z.string().min(1)).min(1).max(1000),
  until: IsoDateSchema.nullable(),
});
export type SnoozeReview = z.infer<typeof SnoozeReviewSchema>;

export const SnoozedReviewSchema = z.object({ updated: z.number().int() });
