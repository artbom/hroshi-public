import { z } from 'zod';

import { BalanceCheckSchema } from './checks.ts';
import { CurrencySchema, IsoDateSchema, SyncSourceSchema } from './primitives.ts';

export const SyncRunSchema = z.object({
  startedAt: z.iso.datetime(),
  finishedAt: z.iso.datetime().nullable(),
  status: z.enum(['running', 'ok', 'error']),
  error: z.string().nullable(),
  fetched: z.number().int(),
  created: z.number().int(),
  updated: z.number().int(),
  /** Reconciliation findings, e.g. a computed balance that differs from the bank's. */
  warnings: z.array(z.string()),
});

export const SyncSourceStatusSchema = z.object({
  source: SyncSourceSchema,
  /** Credentials for the provider are present in the environment. */
  configured: z.boolean(),
  lastRun: SyncRunSchema.nullable(),
  lastSuccessAt: z.iso.datetime().nullable(),
  /** Bank consent expiry, for providers that need periodic re-authorisation. */
  consentValidUntil: z.iso.datetime().nullable(),
  /** Newest runs first, imports and back-fills included. */
  recentRuns: z.array(SyncRunSchema),
  /** Tracker balances compared with the bank's, one per account the source could check. */
  checks: z.array(BalanceCheckSchema),
});
export type SyncSourceStatus = z.infer<typeof SyncSourceStatusSchema>;

export const SyncStatusListSchema = z.array(SyncSourceStatusSchema);

export const SyncParamsSchema = z.object({ source: SyncSourceSchema });

export const ConsentStartSchema = z.object({ url: z.url() });

/** What the bank's redirect after consent carries; the bot takes it from the address the owner pastes. */
export const ConsentCompletionSchema = z.object({ code: z.string().min(1), state: z.string().min(1) });
export type ConsentCompletion = z.infer<typeof ConsentCompletionSchema>;
export const ConsentCompletedSchema = z.object({ validUntil: z.iso.datetime() });

/** From this many days before a bank consent runs out, the app and the bot start warning. */
export const CONSENT_WARNING_DAYS = 14;

/** Files the import screen accepts: a mono_export.py file, a Binance export folder, a Freedom24 report. */
export const FileImportKindSchema = z.enum(['mono', 'binance', 'freedom24']);
export type FileImportKind = z.infer<typeof FileImportKindSchema>;

export const FileImportRequestSchema = z.object({
  kind: FileImportKindSchema,
  /** Only report what the import would do; nothing is written. */
  dryRun: z.boolean(),
  /** Parsed in the browser; each importer validates its own shape. */
  files: z
    .array(z.object({ name: z.string().min(1), lastModified: z.iso.datetime(), content: z.unknown() }))
    .min(1)
    .max(4),
});
export type FileImportRequest = z.infer<typeof FileImportRequestSchema>;

export const FileImportAccountSchema = z.object({
  accountId: z.string().nullable(),
  /** The tracker account, or what the file calls an account the tracker does not know. */
  name: z.string(),
  currency: CurrencySchema.nullable(),
  /** Lines the ledger does not hold yet. */
  added: z.number().int(),
  /** Lines already in the ledger: imported before or synced. */
  known: z.number().int(),
  /** Lines the owner deleted once; they stay deleted. */
  dismissed: z.number().int(),
  /** New lines with a hand entry of the same amount a couple of days around: likely linked to it instead. */
  likelyHand: z.number().int(),
  from: IsoDateSchema.nullable(),
  to: IsoDateSchema.nullable(),
  /** Money in and out across the new lines, in the account currency. */
  inflow: z.number(),
  outflow: z.number(),
});
export type FileImportAccount = z.infer<typeof FileImportAccountSchema>;

export const FileImportResultSchema = z.object({
  kind: FileImportKindSchema,
  dryRun: z.boolean(),
  lines: z.number().int(),
  added: z.number().int(),
  known: z.number().int(),
  dismissed: z.number().int(),
  /** Lines no import uses: zero amounts, other assets, accounts the tracker skips. */
  skipped: z.number().int(),
  from: IsoDateSchema.nullable(),
  to: IsoDateSchema.nullable(),
  accounts: z.array(FileImportAccountSchema),
  /** Plain sentences about what else happens: a valuation, a statement kept for the investments page. */
  notes: z.array(z.string()),
  /** What the ledger reported after a real import; null for a dry run. */
  outcome: z
    .object({ fetched: z.number().int(), created: z.number().int(), updated: z.number().int(), warnings: z.array(z.string()) })
    .nullable(),
});
export type FileImportResult = z.infer<typeof FileImportResultSchema>;
