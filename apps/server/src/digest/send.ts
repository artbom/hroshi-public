import { mkdir, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { shiftDate } from '@hroshi/domain';
import type { IsoDate } from '@hroshi/schema';

import { composeBudget } from '../budget/compose.ts';
import { describeBudgetCaption, renderBudget } from '../budget/render.ts';
import { readSavingsGoal } from '../budget/store.ts';
import type { Db } from '../db.ts';
import { loadLedger } from '../ledger.ts';
import { composeDigest, describeCaption } from './compose.ts';
import { type DigestKind, findLastMonth, findLastWeekEnd, type PeriodKind } from './period.ts';
import { renderWeeklyDigest } from './render.ts';
import { requireTelegramOwner, sendTelegramPhoto } from '../telegram.ts';

type Report = { png: Buffer; caption: string; from: IsoDate; to: IsoDate };

/** The month's budget up to `asOf`, yesterday by default: the morning's syncs have only just brought it in full. */
const prepareBudgetReport = async ({ db, today, asOf = shiftDate(today, -1) }: { db: Db; today: IsoDate; asOf?: IsoDate | undefined }): Promise<Report> => {
  const goal = await readSavingsGoal(db);
  if (goal === null) throw new Error('No savings goal yet: set it on the categories page or ask the bot');
  const [ledger, reviewCount] = await Promise.all([loadLedger(db), db.transaction.count({ where: { needsReview: true } })]);
  const budget = await composeBudget({ db, ledger, goal, asOf, today });
  return {
    png: await renderBudget({ budget, today }),
    caption: describeBudgetCaption({ budget, today, reviewCount }),
    from: `${budget.month}-01`,
    to: budget.asOf,
  };
};

/** The last full week or month, or the one ending on `to`. */
const preparePeriodDigest = async ({ db, kind, today, to }: { db: Db; kind: PeriodKind; today: IsoDate; to?: IsoDate | undefined }): Promise<Report> => {
  const periodEnd = to ?? (kind === 'week' ? findLastWeekEnd(today) : `${findLastMonth(today)}-28`);
  const weekly = await composeDigest({ db, kind, to: periodEnd, today });
  return { png: await renderWeeklyDigest(weekly), caption: describeCaption(weekly), from: weekly.digest.from, to: weekly.digest.to };
};

/** Renders a report; saves the picture when asked, sends it when Telegram is configured and asked. */
export const sendDigest = async ({
  db,
  kind,
  today,
  to,
  send,
  outDir,
}: {
  db: Db;
  kind: DigestKind;
  today?: IsoDate | undefined;
  /** The last day the report covers. */
  to?: IsoDate | undefined;
  send: boolean;
  outDir?: string;
}) => {
  const now = today ?? new Date().toISOString().slice(0, 10);
  const report = kind === 'day' ? await prepareBudgetReport({ db, today: now, asOf: to }) : await preparePeriodDigest({ db, kind, today: now, to });

  let saved: string | null = null;
  if (outDir !== undefined) {
    await mkdir(outDir, { recursive: true });
    saved = join(outDir, `${kind}-${report.to}.png`);
    await writeFile(saved, report.png);
  }
  if (send) await sendTelegramPhoto({ ...requireTelegramOwner(), png: report.png, caption: report.caption });
  return { period: `${report.from}…${report.to}`, saved, sent: send, caption: report.caption };
};
