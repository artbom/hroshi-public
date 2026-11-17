import type { Db } from '../db.ts';
import type { SplitwiseClient } from '../sync/splitwise/client.ts';

export type SplitwiseChange = { action: 'created' | 'deleted'; summary: string };

export const recordSplitwiseChange = async ({
  db,
  batchId,
  expenseId,
  action,
  summary,
}: {
  db: Db;
  batchId: string;
  expenseId: number;
  action: SplitwiseChange['action'];
  summary: string;
}) => {
  await db.chatSplitwiseChange.create({ data: { batchId, expenseId: String(expenseId), action, summary } });
};

export const listSplitwiseChanges = ({ db, batchId }: { db: Db; batchId: string }): Promise<SplitwiseChange[]> =>
  db.chatSplitwiseChange.findMany({ where: { batchId }, orderBy: { id: 'asc' }, select: { action: true, summary: true } });

export const formatSplitwiseChanges = (changes: readonly SplitwiseChange[]) =>
  changes.map(({ action, summary }) => `🤝 Splitwise: ${action === 'created' ? 'додано' : 'видалено'} ${summary}`).join('\n');

/** Splitwise keeps deleted expenses, so a deletion is undone by restoring, not by adding a copy. */
export const undoSplitwiseChanges = async ({ db, client, batchId }: { db: Db; client: () => SplitwiseClient; batchId: string }) => {
  const changes = await db.chatSplitwiseChange.findMany({ where: { batchId, undoneAt: null }, orderBy: { id: 'desc' } });
  for (const change of changes) {
    const id = Number(change.expenseId);
    await (change.action === 'created' ? client().deleteExpense(id) : client().restoreExpense(id));
    await db.chatSplitwiseChange.update({ where: { id: change.id }, data: { undoneAt: new Date() } });
  }
  return changes.length;
};
