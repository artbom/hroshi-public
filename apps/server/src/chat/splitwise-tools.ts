import { shiftDate } from '@hroshi/domain';
import { CurrencySchema, IsoDateSchema } from '@hroshi/schema';
import type { McpServer } from '@modelcontextprotocol/sdk/server/mcp.js';
import { z } from 'zod';

import { findToday } from '../clock.ts';
import { prisma } from '../db.ts';
import { planExpenseBooking } from '../sync/splitwise/book.ts';
import type { NewSplitwiseExpense, SplitwiseExpense } from '../sync/splitwise/client.ts';
import { prepareSplitwiseBooking, requireSplitwiseClient } from '../sync/splitwise/provider.ts';
import { describeShare, describeUserName, splitEvenly } from '../sync/splitwise/shares.ts';
import { toLocalDate } from '../sync/statement.ts';
import { trackChatWrite } from './changes.ts';
import { recordSplitwiseChange } from './splitwise-log.ts';
import { reply, requireBatch } from './tool-helpers.ts';

/** How far back the expense list looks when the model names no date. */
const EXPENSES_LOOKBACK_DAYS = 60;
const EXPENSES_SHOWN = 40;
/** Splitwise stores a moment; noon UTC keeps the day the same in Madrid. */
const describeNoon = (date: string) => `${date}T12:00:00Z`;

const UserIdSchema = z.number().int().positive();

const ExpensesInputSchema = z.object({
  from: IsoDateSchema.optional().describe(`Без нього останні ${EXPENSES_LOOKBACK_DAYS} днів`),
  friendId: UserIdSchema.optional(),
  groupId: UserIdSchema.optional(),
});

const AddExpenseSchema = z
  .object({
    description: z.string().min(1).max(100),
    cost: z.number().positive(),
    currency: CurrencySchema.default('EUR'),
    date: IsoDateSchema.optional().describe('Без нього сьогодні'),
    groupId: UserIdSchema.optional().describe('Група зі splitwise_friends; без неї витрата просто між друзями'),
    paidBy: UserIdSchema.describe('id того, хто платив; твій — me.id'),
    participants: z.array(UserIdSchema).min(1).describe('id усіх, на кого ділиться витрата, з тобою, якщо твоя частка теж є'),
    owed: z.array(z.number().nonnegative()).optional().describe('Нерівні частки в порядку participants; без них порівну'),
  })
  .refine(({ owed, participants }) => owed === undefined || owed.length === participants.length, { message: 'owed має по частці на кожного з participants' })
  .refine(({ owed, cost }) => owed === undefined || Math.abs(owed.reduce((sum, part) => sum + part, 0) - cost) < 0.01, {
    message: 'Частки owed мають скласти cost',
  });

const SettleUpSchema = z.object({
  friendId: UserIdSchema,
  amount: z.number().positive(),
  currency: CurrencySchema.default('EUR'),
  direction: z.enum(['paid', 'received']).describe('paid: ти віддав другові; received: друг віддав тобі'),
  date: IsoDateSchema.optional(),
});

const ExpenseIdSchema = z.object({ id: UserIdSchema.describe('id витрати зі splitwise_expenses') });

const describeExpense = (expense: Pick<SplitwiseExpense, 'description' | 'cost' | 'currency_code'>) =>
  `«${expense.description}» · ${expense.cost} ${expense.currency_code}`;

const trimExpense = (expense: SplitwiseExpense) => ({
  id: expense.id,
  date: toLocalDate(new Date(expense.date)),
  description: expense.description,
  cost: expense.cost,
  currency: expense.currency_code,
  payment: expense.payment,
  category: expense.category?.name ?? null,
  groupId: expense.group_id,
  users: expense.users.map((share) => ({ id: share.user_id, name: describeUserName(share.user ?? undefined), paid: share.paid_share, owed: share.owed_share })),
});

/** The expense as the ledger sees it right after the write, tracked so the chat can undo both sides. */
const bookInLedger = async ({ batchId, me, expense }: { batchId: string; me: number; expense: SplitwiseExpense }) => {
  const share = describeShare({ expense, me });
  const currencies = new Set(share === undefined || share.kind === 'foreign' ? [] : [share.currency]);
  const booking = await prepareSplitwiseBooking({ db: prisma, me, currencies });
  const plan = await planExpenseBooking({ booking, expense });
  const { created, updated } = await trackChatWrite({ db: prisma, batchId, ids: plan.touches, write: plan.apply, listCreated: (result) => result.created });
  return { ledgerRows: created.length + updated, warnings: booking.warnings };
};

/** Writes go to the owner's Splitwise, where friends see them; each one is logged for undo. */
const createAndBook = async ({ batchId, expense }: { batchId: string; expense: NewSplitwiseExpense }) => {
  const client = requireSplitwiseClient();
  const me = await client.readCurrentUser();
  if (!expense.shares.some((share) => share.userId === me.id)) {
    throw new Error('Витрата без тебе не стосується твого обліку; її краще записати в Splitwise самому');
  }
  const created = await client.createExpense(expense);
  await recordSplitwiseChange({ db: prisma, batchId, expenseId: created.id, action: 'created', summary: describeExpense(created) });
  return { created: trimExpense(created), ...(await bookInLedger({ batchId, me: me.id, expense: created })) };
};

export const registerSplitwiseTools = ({ server, batchId }: { server: McpServer; batchId: string | undefined }) => {
  const read = { readOnlyHint: true };
  const shared = { openWorldHint: true };

  server.registerTool(
    'splitwise_friends',
    { description: 'Ти (me), друзі зі Splitwise з балансами (додатний: друг винен тобі) і групи з учасниками. Звідси id для решти інструментів.', annotations: read },
    async () => {
      const client = requireSplitwiseClient();
      const [me, friends, groups] = await Promise.all([client.readCurrentUser(), client.listFriends(), client.listGroups()]);
      return reply({
        me: { id: me.id, name: describeUserName(me) },
        friends: friends.map((friend) => ({ id: friend.id, name: describeUserName(friend), balance: friend.balance.filter(({ amount }) => amount !== 0) })),
        // Group 0 is Splitwise's bucket for expenses outside any group.
        groups: groups
          .filter((group) => group.id !== 0)
          .map((group) => ({ id: group.id, name: group.name, members: group.members.map((member) => ({ id: member.id, name: describeUserName(member) })) })),
      });
    },
  );

  server.registerTool(
    'splitwise_expenses',
    { description: 'Витрати й погашення в Splitwise, найновіші першими: хто скільки платив (paid) і скільки з кого (owed).', inputSchema: ExpensesInputSchema, annotations: read },
    async ({ from, friendId, groupId }) => {
      const expenses = await requireSplitwiseClient().listExpenses({
        datedAfter: from ?? shiftDate(findToday(), -EXPENSES_LOOKBACK_DAYS),
        ...(friendId === undefined ? {} : { friendId }),
        ...(groupId === undefined ? {} : { groupId }),
      });
      return reply(
        expenses
          .filter((expense) => expense.deleted_at === null)
          .toSorted((left, right) => right.date.localeCompare(left.date))
          .slice(0, EXPENSES_SHOWN)
          .map(trimExpense),
      );
    },
  );

  server.registerTool(
    'splitwise_add_expense',
    {
      description:
        'Додає спільну витрату в Splitwise (друзі її побачать) і одразу вносить твою частку в облік. Платив ти — оплата карткою вже є з банку, тож окремо витрату не додавай.',
      inputSchema: AddExpenseSchema,
      annotations: shared,
    },
    async ({ description, cost, currency, date, groupId, paidBy, participants, owed }) => {
      const parts = owed ?? splitEvenly({ cost, count: participants.length });
      const shares = [...new Set([paidBy, ...participants])].map((userId) => ({
        userId,
        paid: userId === paidBy ? cost : 0,
        owed: parts[participants.indexOf(userId)] ?? 0,
      }));
      return reply(
        await createAndBook({
          batchId: requireBatch(batchId),
          expense: { description, cost, currency, date: describeNoon(date ?? findToday()), groupId: groupId ?? null, payment: false, shares },
        }),
      );
    },
  );

  server.registerTool(
    'splitwise_settle_up',
    {
      description: 'Записує в Splitwise погашення боргу між тобою і другом і зводить його з переказом із банку, якщо той уже прийшов.',
      inputSchema: SettleUpSchema,
      annotations: shared,
    },
    async ({ friendId, amount, currency, direction, date }) => {
      const me = (await requireSplitwiseClient().readCurrentUser()).id;
      const [payer, receiver] = direction === 'paid' ? [me, friendId] : [friendId, me];
      return reply(
        await createAndBook({
          batchId: requireBatch(batchId),
          expense: {
            description: 'Погашення',
            cost: amount,
            currency,
            date: describeNoon(date ?? findToday()),
            groupId: null,
            payment: true,
            shares: [
              { userId: payer, paid: amount, owed: 0 },
              { userId: receiver, paid: 0, owed: amount },
            ],
          },
        }),
      );
    },
  );

  server.registerTool(
    'splitwise_delete_expense',
    {
      description: 'Видаляє витрату чи погашення в Splitwise (у друзів теж) і прибирає її з обліку. «Скасувати» її відновить.',
      inputSchema: ExpenseIdSchema,
      annotations: { ...shared, destructiveHint: true },
    },
    async ({ id }) => {
      const batch = requireBatch(batchId);
      const client = requireSplitwiseClient();
      const [me, expense] = await Promise.all([client.readCurrentUser(), client.readExpense(id)]);
      if (expense.deleted_at !== null) throw new Error('Ця витрата в Splitwise уже видалена');
      await client.deleteExpense(id);
      await recordSplitwiseChange({ db: prisma, batchId: batch, expenseId: id, action: 'deleted', summary: describeExpense(expense) });
      const booked = await bookInLedger({ batchId: batch, me: me.id, expense: { ...expense, deleted_at: new Date().toISOString() } });
      return reply({ deleted: id, ...booked });
    },
  );
};
