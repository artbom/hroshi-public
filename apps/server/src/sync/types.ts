import type { FileImportResult, SyncSource } from '@hroshi/schema';

import type { Db } from '../db.ts';

export type SyncCounts = { fetched: number; created: number; updated: number; warnings?: string[] };

export type SyncContext = { db: Db; log: (message: string) => void };

export type SyncProvider = {
  source: SyncSource;
  isConfigured: () => boolean;
  run: (context: SyncContext) => Promise<SyncCounts>;
};

/**
 * What a file import would do, worked out before anything is written, and the step that does it.
 * `source` names the sync whose status screen records the run; a statement kept as a file has none.
 */
export type ImportPlan = {
  preview: Omit<FileImportResult, 'kind' | 'dryRun' | 'outcome'>;
  source: SyncSource | null;
  apply: () => Promise<SyncCounts>;
};

/** An uploaded or local file, already parsed as JSON. */
export type ImportFile = { name: string; modified: Date; content: unknown };
