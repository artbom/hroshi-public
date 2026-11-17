import type { FileImportKind, FileImportResult, IsoDate } from '@hroshi/schema';

import { keepBrokerStatement } from '../brokers/import.ts';
import { readLatestBrokerFile } from '../brokers/store.ts';
import type { Db } from '../db.ts';
import { badRequest } from '../http-errors.ts';
import { planBinanceImport } from './binance/provider.ts';
import { planMonoImport } from './mono/provider.ts';
import { listOpenWarnings } from './reconciliation.ts';
import { recordSyncRun } from './runner.ts';
import type { ImportFile, ImportPlan } from './types.ts';

const formatDay = (date: IsoDate) =>
  new Date(`${date}T12:00:00Z`).toLocaleDateString('uk-UA', { day: 'numeric', month: 'short', year: 'numeric' }).replace(/\s*р\.$/u, '');

const formatAmount = (value: number) => value.toLocaleString('uk-UA', { maximumFractionDigits: 2 });

/** A Freedom24 report adds no rows: it feeds the investments page and the value check. */
const planFreedom24Import = async ({ files }: { files: readonly ImportFile[] }): Promise<ImportPlan> => {
  const [file] = files;
  if (file === undefined) throw badRequest('Потрібен звіт Freedom24 (*_all.json)');
  const keep = (dryRun: boolean) =>
    keepBrokerStatement({ broker: 'freedom24', json: file.content, name: file.name, modified: file.modified, dryRun });
  const { report } = await keep(true);
  const kept = (await readLatestBrokerFile('freedom24'))?.name.match(/\d{4}-\d{2}-\d{2}/u)?.[0];
  const dates = report.cashFlows.map((flow) => flow.date).toSorted();
  return {
    preview: {
      lines: report.cashFlows.length,
      added: 0,
      known: 0,
      dismissed: 0,
      skipped: 0,
      from: dates[0] ?? null,
      to: dates.at(-1) ?? null,
      accounts: [],
      notes: [
        `Звіт на ${formatDay(report.asOf)}: чисті активи ${report.netAssets === null ? '—' : `${formatAmount(report.netAssets)} ${report.currency}`}, позицій ${report.holdings.length}, грошових рухів ${report.cashFlows.length}`,
        'Записів у трекері звіт не додає: з нього «Інвестиції» беруть позиції й дивіденди, а «Рахунки» — звірку вартості',
        ...(kept === undefined
          ? []
          : kept > report.asOf
            ? [`Уже збережено новіший звіт (на ${formatDay(kept)}); цей стане основним, тож краще імпортувати новіший`]
            : kept === report.asOf
              ? ['Звіт на цей день уже збережено: імпорт перезапише його']
              : [`Замінить збережений звіт на ${formatDay(kept)}`]),
      ],
    },
    source: null,
    apply: async () => {
      await keep(false);
      return { fetched: report.cashFlows.length, created: 0, updated: 0 };
    },
  };
};

const planImport = ({
  db,
  kind,
  files,
  log,
}: {
  db: Db;
  kind: FileImportKind;
  files: readonly ImportFile[];
  log: (message: string) => void;
}): Promise<ImportPlan> => {
  switch (kind) {
    case 'mono': {
      const [file] = files;
      if (file === undefined) throw badRequest('Потрібен файл mono_export.json');
      return planMonoImport({ db, content: file.content, log });
    }
    case 'binance':
      return planBinanceImport({ db, files });
    case 'freedom24':
      return planFreedom24Import({ files });
  }
};

/**
 * The one way files get in, for the CLI and the import screen alike: the plan is worked out
 * first, read-only; a dry run stops there, a real one applies it and is recorded like a sync.
 */
export const importFiles = async ({
  db,
  kind,
  files,
  dryRun,
  log,
}: {
  db: Db;
  kind: FileImportKind;
  files: readonly ImportFile[];
  dryRun: boolean;
  log: (message: string) => void;
}): Promise<FileImportResult> => {
  const plan = await planImport({ db, kind, files, log });
  const counts = dryRun ? null : plan.source === null ? await plan.apply() : await recordSyncRun({ db, source: plan.source, task: plan.apply });
  return {
    kind,
    dryRun,
    ...plan.preview,
    outcome:
      counts === null
        ? null
        : { fetched: counts.fetched, created: counts.created, updated: counts.updated, warnings: listOpenWarnings(counts.warnings ?? []) },
  };
};
