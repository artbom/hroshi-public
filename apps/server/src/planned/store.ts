import { detectRecurring } from '@hroshi/domain';
import type { IsoDate, PlannedInput, PlannedOverride, Recurring } from '@hroshi/schema';

import type { Db } from '../db.ts';
import type { PlannedPayment as PlannedRow } from '../generated/prisma/client.ts';
import { badRequest } from '../http-errors.ts';
import type { Ledger } from '../ledger.ts';
import { toNullableNumber } from '../mappers.ts';

const mapOverride = (row: PlannedRow): PlannedOverride => ({
  key: row.key,
  status: row.status,
  name: row.name,
  amount: toNullableNumber(row.amount),
  currency: row.currency,
  dayOfMonth: row.dayOfMonth,
  accountId: row.accountId,
  category: row.category,
});

export const loadPlannedOverrides = async (db: Db): Promise<PlannedOverride[]> =>
  (await db.plannedPayment.findMany({ orderBy: { key: 'asc' } })).map(mapOverride);

/** Recurring payments as the owner sees them: what detection found, with his word on top. */
export const findPlannedPayments = async ({
  db,
  ledger,
  today,
}: {
  db: Db;
  ledger: Pick<Ledger, 'transactions' | 'policies' | 'fx'>;
  today: IsoDate;
}): Promise<Recurring> =>
  detectRecurring({
    transactions: ledger.transactions,
    policies: ledger.policies,
    fx: ledger.fx,
    today,
    overrides: await loadPlannedOverrides(db),
  });

const assertTerms = async ({ db, accountId, category }: { db: Db; accountId: string; category: string }) => {
  const [account, found] = await Promise.all([
    db.account.findUnique({ where: { id: accountId } }),
    db.category.findUnique({ where: { name: category } }),
  ]);
  if (account === null || account.archived) throw badRequest(`Account "${accountId}" is not active`);
  if (found === null || found.archived || !found.forExpense) throw badRequest(`"${category}" is not an expense category`);
};

/** Marking a payment «не регулярний» drops any terms confirmed before, so undoing it starts clean. */
export const savePlannedOverride = async ({ db, input }: { db: Db; input: PlannedInput }): Promise<PlannedOverride> => {
  const terms =
    input.status === 'confirmed'
      ? {
          amount: input.amount,
          currency: input.currency,
          dayOfMonth: input.dayOfMonth,
          accountId: input.accountId,
          category: input.category,
        }
      : { amount: null, currency: null, dayOfMonth: null, accountId: null, category: null };
  if (input.status === 'confirmed') await assertTerms({ db, accountId: input.accountId, category: input.category });
  const data = { status: input.status, name: input.name ?? null, ...terms };
  return mapOverride(await db.plannedPayment.upsert({ where: { key: input.key }, create: { key: input.key, ...data }, update: data }));
};
