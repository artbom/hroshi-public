import { z } from 'zod';

import { TransactionRowSchema } from './transaction.ts';

export const RuleSchema = z.object({
  id: z.string(),
  pattern: z.string().nullable(),
  mcc: z.number().int().nullable(),
  accountId: z.string().nullable(),
  category: z.string().nullable(),
  transferToAccountId: z.string().nullable(),
  priority: z.number().int(),
  note: z.string().nullable(),
});
export type Rule = z.infer<typeof RuleSchema>;

export const RuleListSchema = z.array(RuleSchema);

const { id: _id, ...ruleFields } = RuleSchema.shape;

export const RuleInputSchema = z
  .object({ ...ruleFields, pattern: z.string().trim().min(2).nullable() })
  .refine((rule) => rule.pattern !== null || rule.mcc !== null, 'Вкажи шаблон або MCC')
  .refine(
    (rule) => (rule.category === null) !== (rule.transferToAccountId === null),
    'Правило задає або категорію, або рахунок для переказу',
  );
export type RuleInput = z.infer<typeof RuleInputSchema>;

/**
 * duplicate: same condition twice; shadowed: a shorter rule that wins first catches it; broad: its
 * matches land in many categories; unused: its text never matched a row; archived: it books into
 * an archived category or account.
 */
export const RuleIssueSchema = z.enum(['duplicate', 'shadowed', 'broad', 'unused', 'archived']);
export type RuleIssue = z.infer<typeof RuleIssueSchema>;

export const RuleStatsSchema = z.array(
  z.object({
    id: z.string(),
    /** Rows in the ledger this rule is the first match for. */
    hits: z.number().int(),
    lastMatch: z.iso.date().nullable(),
    issues: z.array(RuleIssueSchema),
    /** The other rule behind a duplicate or shadowed issue. */
    relatedId: z.string().nullable(),
    /** Categories the owner booked this rule's matches into. */
    categories: z.number().int(),
  }),
);
export type RuleStats = z.infer<typeof RuleStatsSchema>;

export const RulePreviewInputSchema = z.object({
  pattern: z.string().trim().min(2).nullable(),
  mcc: z.number().int().nullable(),
  accountId: z.string().nullable(),
});
export type RulePreviewInput = z.infer<typeof RulePreviewInputSchema>;

/** What a rule would catch in the history before it is saved. */
export const RulePreviewSchema = z.object({
  matches: z.number().int(),
  /** Matches still waiting in the review inbox. */
  waiting: z.number().int(),
  /** How the owner booked the matches so far. */
  categories: z.array(z.object({ category: z.string(), count: z.number().int() })),
  sample: z.array(TransactionRowSchema),
});
export type RulePreview = z.infer<typeof RulePreviewSchema>;
