import { roundAmount, shiftDate } from '@hroshi/domain';
import type { FileImportAccount, IsoDate, Source, SyncSource } from '@hroshi/schema';

import type { Db } from '../db.ts';
import { fromIsoDate, toIsoDate, toNumber } from '../mappers.ts';
import { prefixExternalId } from './ingest.ts';
import type { StatementItem } from './statement.ts';

/** Rows a bank line may claim instead of adding its own: the same set ingestion adopts. */
const HAND_SOURCES: Source[] = ['claude', 'page', 'zenmoney'];
/** A hand entry is dated by the receipt, the bank books a day or two later. */
const HAND_WINDOW_DAYS = 2;
/** Hand entries are often typed in whole units or estimated from a foreign-currency receipt. */
const HAND_AMOUNT_MIN = 1;
const HAND_AMOUNT_RATIO = 0.015;

type HandRow = { accountId: string; date: IsoDate; amount: number };

const daysBetween = (left: IsoDate, right: IsoDate) =>
  Math.abs(Date.parse(`${left}T00:00:00Z`) - Date.parse(`${right}T00:00:00Z`)) / 86_400_000;

const isNearHandEntry = ({ item, hand }: { item: StatementItem; hand: readonly HandRow[] }) => {
  const amount = Math.abs(item.amount);
  const slack = Math.max(HAND_AMOUNT_MIN, amount * HAND_AMOUNT_RATIO);
  return hand.some(
    (row) => row.accountId === item.accountId && daysBetween(row.date, item.date) <= HAND_WINDOW_DAYS && Math.abs(row.amount - amount) <= slack,
  );
};

const sortDates = (dates: readonly IsoDate[]) => dates.toSorted();

export type StatementPreview = Pick<FileImportAccount, 'added' | 'known' | 'dismissed'> & {
  from: IsoDate | null;
  to: IsoDate | null;
  accounts: FileImportAccount[];
};

/**
 * What ingestion would make of statement lines, read without writing: which lines the ledger
 * already holds (by provider line id), which the owner deleted, which are new and, of those,
 * which sit next to a hand entry they would probably claim. Exact for the first three; the
 * last is the same window and amount slack ingestion uses, without its word matching.
 */
export const previewStatement = async ({
  db,
  source,
  items,
}: {
  db: Db;
  source: SyncSource;
  items: readonly StatementItem[];
}): Promise<StatementPreview> => {
  const money = items.filter((item) => item.amount !== 0);
  const ids = money.map((item) => prefixExternalId(source, item.externalId));
  const dates = sortDates(money.map((item) => item.date));
  const [stored, dismissedLines, accounts, handRows] = await Promise.all([
    db.transaction.findMany({
      where: { OR: [{ externalId: { in: ids } }, { toExternalId: { in: ids } }] },
      select: { externalId: true, toExternalId: true },
    }),
    db.dismissedLine.findMany({ where: { externalId: { in: ids } }, select: { externalId: true } }),
    db.account.findMany({ select: { id: true, name: true, currency: true } }),
    dates.length === 0
      ? Promise.resolve([])
      : db.transaction.findMany({
          where: {
            source: { in: HAND_SOURCES },
            externalId: null,
            accountId: { in: [...new Set(money.map((item) => item.accountId))] },
            date: {
              gte: fromIsoDate(shiftDate(dates[0] ?? '', -HAND_WINDOW_DAYS)),
              lte: fromIsoDate(shiftDate(dates.at(-1) ?? '', HAND_WINDOW_DAYS)),
            },
          },
          select: { accountId: true, date: true, amount: true },
        }),
  ]);
  const known = new Set(stored.flatMap((row) => [row.externalId, row.toExternalId].filter((id) => id !== null)));
  const dismissed = new Set(dismissedLines.map((line) => line.externalId));
  const hand = handRows.map((row) => ({ accountId: row.accountId, date: toIsoDate(row.date), amount: toNumber(row.amount) }));
  const names = new Map(accounts.map((account) => [account.id, account]));

  const perAccount = [...Map.groupBy(money, (item) => item.accountId)].map(([accountId, lines]): FileImportAccount => {
    const fresh = lines.filter((item) => {
      const id = prefixExternalId(source, item.externalId);
      return !known.has(id) && !dismissed.has(id);
    });
    const freshDates = sortDates(fresh.map((item) => item.date));
    const account = names.get(accountId);
    return {
      accountId,
      name: account?.name ?? accountId,
      currency: account?.currency ?? null,
      added: fresh.length,
      known: lines.filter((item) => known.has(prefixExternalId(source, item.externalId))).length,
      dismissed: lines.filter((item) => dismissed.has(prefixExternalId(source, item.externalId))).length,
      likelyHand: fresh.filter((item) => isNearHandEntry({ item, hand })).length,
      from: freshDates[0] ?? null,
      to: freshDates.at(-1) ?? null,
      inflow: roundAmount(fresh.reduce((sum, item) => sum + Math.max(0, item.amount), 0)),
      outflow: roundAmount(fresh.reduce((sum, item) => sum + Math.max(0, -item.amount), 0)),
    };
  });

  const sum = (key: 'added' | 'known' | 'dismissed') => perAccount.reduce((total, entry) => total + entry[key], 0);
  return {
    added: sum('added'),
    known: sum('known'),
    dismissed: sum('dismissed'),
    from: dates[0] ?? null,
    to: dates.at(-1) ?? null,
    accounts: perAccount.toSorted((left, right) => right.added - left.added || right.known - left.known),
  };
};
