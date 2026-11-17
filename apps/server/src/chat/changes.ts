import { randomUUID } from 'node:crypto';

import { TransactionSchema } from '@hroshi/schema';
import { z } from 'zod';

import type { Db } from '../db.ts';
import { Prisma } from '../generated/prisma/client.ts';
import { conflict, notFound } from '../http-errors.ts';

/**
 * Snapshots are whole rows taken and restored by Postgres (`to_jsonb` / `jsonb_populate_record`),
 * so an undo brings back bank links, raw lines and review state without this module naming them.
 * The column list for the restore comes from the generated client for the same reason.
 */
const COLUMNS = Object.values(Prisma.TransactionScalarFieldEnum);
const TARGET_COLUMNS = Prisma.join(COLUMNS.map((column) => Prisma.raw(`"${column}"`)));
const SOURCE_COLUMNS = Prisma.join(COLUMNS.map((column) => Prisma.raw(`excluded."${column}"`)));

/** What a chat reply shows of a row. */
export const ChangedRowSchema = TransactionSchema.pick({
  id: true,
  date: true,
  type: true,
  accountId: true,
  toAccountId: true,
  amount: true,
  currency: true,
  category: true,
  note: true,
});
export type ChangedRow = z.infer<typeof ChangedRowSchema>;

export type ChatChange =
  | { kind: 'created'; after: ChangedRow }
  | { kind: 'updated'; before: ChangedRow; after: ChangedRow }
  | { kind: 'deleted'; before: ChangedRow };

const StoredChangeSchema = z.object({
  transactionId: z.string(),
  before: ChangedRowSchema.nullable(),
  after: ChangedRowSchema.nullable(),
});

/**
 * Runs one write of a chat message and logs the rows it touched before and after. `ids` are the
 * existing rows the write changes or deletes; `listCreated` names the rows it adds.
 */
export const trackChatWrite = async <Result>({
  db,
  batchId,
  ids,
  write,
  listCreated = () => [],
}: {
  db: Db;
  batchId: string;
  ids: readonly string[];
  write: () => Promise<Result>;
  listCreated?: (result: Result) => readonly string[];
}) => {
  const stepId = randomUUID();
  await db.$executeRaw`
    insert into "ChatChange" (id, "batchId", "stepId", "transactionId", before)
    select uuidv7()::text, ${batchId}, ${stepId}, t.id, to_jsonb(t) from "Transaction" t where t.id = any(${ids})`;

  let result: Result;
  try {
    result = await write();
  } catch (error) {
    // Left in place, the half-logged step would read as a deletion.
    await db.chatChange.deleteMany({ where: { stepId } });
    throw error;
  }

  const created = listCreated(result);
  if (created.length > 0) {
    await db.$executeRaw`
      insert into "ChatChange" (id, "batchId", "stepId", "transactionId")
      select uuidv7()::text, ${batchId}, ${stepId}, unnest(${created}::text[])`;
  }
  await db.$executeRaw`
    update "ChatChange" c set after = (select to_jsonb(t) from "Transaction" t where t.id = c."transactionId")
    where c."stepId" = ${stepId}`;
  return result;
};

/** One line per row: a row created and then edited in the same message shows once, as created. */
export const listChatChanges = async ({ db, batchId }: { db: Db; batchId: string }): Promise<ChatChange[]> => {
  const stored = (await db.chatChange.findMany({ where: { batchId }, orderBy: { id: 'asc' } })).map((row) =>
    StoredChangeSchema.parse(row),
  );
  const byRow = Map.groupBy(stored, (change) => change.transactionId);
  return [...byRow.values()].flatMap((changes): ChatChange[] => {
    const before = changes.at(0)?.before ?? null;
    const after = changes.at(-1)?.after ?? null;
    if (before === null) return after === null ? [] : [{ kind: 'created', after }];
    if (after === null) return [{ kind: 'deleted', before }];
    return [{ kind: 'updated', before, after }];
  });
};

const SameSchema = z.array(z.object({ same: z.boolean() }));

/**
 * Puts every row a chat message touched back as it was, newest write first. Refuses when a row
 * changed since (a sync or a hand edit), because the restore would silently overwrite that.
 */
export const undoChatBatch = async ({ db, batchId }: { db: Db; batchId: string }) => {
  const changes = await db.chatChange.findMany({ where: { batchId, undoneAt: null }, orderBy: { id: 'desc' } });
  if (changes.length === 0) throw notFound('Скасовувати нічого: ці зміни вже скасовано');

  // Within one write, rows that still exist go first: a merge hands its bank link back to the
  // deleted row only after the kept row lets go of it.
  const steps = Map.groupBy(changes, (change) => change.stepId);
  const ordered = [...steps.values()].flatMap((step) => step.toSorted((left, right) => Number(left.after === null) - Number(right.after === null)));

  await db.$transaction(async (client) => {
    for (const change of ordered) {
      const [state] = SameSchema.parse(
        await client.$queryRaw`
          select (select to_jsonb(t) - 'updatedAt' from "Transaction" t where t.id = c."transactionId")
            is not distinct from (c.after - 'updatedAt') as same
          from "ChatChange" c where c.id = ${change.id}`,
      );
      if (state?.same !== true) throw conflict('Запис змінився після цього повідомлення (синк чи правка вручну), тож скасування затерло б нове. Виправ його вручну.');

      if (change.before === null) {
        await client.$executeRaw`delete from "Transaction" where id = ${change.transactionId}`;
        continue;
      }
      await client.$executeRaw`
        insert into "Transaction"
        select * from jsonb_populate_record(null::"Transaction", (select before from "ChatChange" where id = ${change.id}))
        on conflict (id) do update set (${TARGET_COLUMNS}) = row(${SOURCE_COLUMNS})`;
      if (change.after === null) {
        // Deleting the row dismissed its bank lines; back in the ledger, sync must see them again.
        await client.$executeRaw`
          delete from "DismissedLine" d using "ChatChange" c
          where c.id = ${change.id} and d."externalId" in (c.before->>'externalId', c.before->>'toExternalId')`;
      }
    }
    await client.chatChange.updateMany({ where: { batchId }, data: { undoneAt: new Date() } });
  });
  return new Set(changes.map((change) => change.transactionId)).size;
};
