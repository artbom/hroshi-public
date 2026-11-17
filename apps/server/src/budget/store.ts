import type { SavingsGoal } from '@hroshi/schema';

import type { Db } from '../db.ts';
import { toNumber } from '../mappers.ts';

/** The table holds one row: the goal in force. */
const GOAL_ID = 1;

export const readSavingsGoal = async (db: Db): Promise<SavingsGoal | null> => {
  const row = await db.savingsGoal.findUnique({ where: { id: GOAL_ID } });
  return row === null ? null : { amount: toNumber(row.amount), currency: row.currency };
};

export const saveSavingsGoal = async ({ db, goal }: { db: Db; goal: SavingsGoal }): Promise<void> => {
  await db.savingsGoal.upsert({ where: { id: GOAL_ID }, create: { id: GOAL_ID, ...goal }, update: goal });
};
