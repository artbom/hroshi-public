import { z } from 'zod';

const API = 'https://secure.splitwise.com/api/v3.0';
/** The web app's page; its markup carries the CSRF token that cookie-session writes need. */
const WEB_APP = 'https://secure.splitwise.com/';
const CSRF_TOKEN = /<meta name="csrf-token" content="([^"]+)"/;
const MAX_REDIRECTS = 5;
/** Splitwise's largest page; a personal account has a few dozen expenses a month. */
const PAGE_SIZE = 200;

/** Amounts come as decimal strings: "12.50". */
const MoneySchema = z.coerce.number();

const UserSchema = z.object({
  id: z.number().int(),
  first_name: z.string().nullable(),
  last_name: z.string().nullable(),
});
export type SplitwiseUser = z.infer<typeof UserSchema>;

const BalanceSchema = z.object({ currency_code: z.string(), amount: MoneySchema });

const FriendSchema = z.object({
  ...UserSchema.shape,
  /** Per currency; positive: the friend owes the owner. */
  balance: z.array(BalanceSchema),
});
export type SplitwiseFriend = z.infer<typeof FriendSchema>;

const GroupSchema = z.object({ id: z.number().int(), name: z.string(), members: z.array(UserSchema) });

const ExpenseShareSchema = z.object({
  user_id: z.number().int(),
  user: UserSchema.nullable().optional(),
  paid_share: MoneySchema,
  owed_share: MoneySchema,
});

export const SplitwiseExpenseSchema = z.object({
  id: z.number().int(),
  group_id: z.number().int().nullable(),
  description: z.string(),
  /** A settle-up between two people rather than a shared cost. */
  payment: z.boolean(),
  cost: MoneySchema,
  currency_code: z.string(),
  date: z.string(),
  deleted_at: z.string().nullable(),
  category: z.object({ id: z.number().int(), name: z.string() }).nullable().optional(),
  users: z.array(ExpenseShareSchema),
});
export type SplitwiseExpense = z.infer<typeof SplitwiseExpenseSchema>;

/** Splitwise answers 200 with `errors` filled when it refuses a write. */
const ErrorsSchema = z.union([z.record(z.string(), z.array(z.string())), z.array(z.string())]).optional();

const describeErrors = (errors: z.infer<typeof ErrorsSchema>) =>
  errors === undefined ? '' : (Array.isArray(errors) ? errors : Object.values(errors).flat()).join('; ');

/** What the bot asks Splitwise to record: who paid what and who owes what, per user. */
export type NewSplitwiseExpense = {
  description: string;
  cost: number;
  currency: string;
  date: string;
  groupId: number | null;
  payment: boolean;
  shares: readonly { userId: number; paid: number; owed: number }[];
};

const splitCookie = (pair: string): [string, string] => {
  const at = pair.indexOf('=');
  return [pair.slice(0, at), pair.slice(at + 1)];
};

/**
 * Splitwise answers 403 to a cookie-session write without a CSRF token. The token belongs to the
 * session cookie the page renews alongside it, so the write sends the renewed cookies. Signed in by
 * `user_credentials` alone, the page first redirects to itself with a fresh session cookie, which
 * `fetch` would drop between hops.
 */
const startWriteSession = async (cookie: string) => {
  const cookies = new Map(cookie.split('; ').map(splitCookie));
  const toHeader = () => [...cookies].map(([name, value]) => `${name}=${value}`).join('; ');
  let url = WEB_APP;
  for (let hop = 0; hop < MAX_REDIRECTS; hop++) {
    const page = await fetch(url, { headers: { cookie: toHeader() }, redirect: 'manual' });
    for (const line of page.headers.getSetCookie()) cookies.set(...splitCookie(line.replace(/;.*/s, '')));
    const location = page.headers.get('location');
    if (location !== null) {
      url = new URL(location, url).href;
      continue;
    }
    const token = CSRF_TOKEN.exec(await page.text())?.[1];
    if (token === undefined) throw new Error(`Splitwise web page answered ${page.status} without a CSRF token`);
    return { token, cookie: toHeader() };
  }
  throw new Error(`Splitwise web page redirected more than ${MAX_REDIRECTS} times`);
};

/** The browser's login cookies stand for the owner; every call acts as them, and errors never echo them. */
export const createSplitwiseClient = (cookie: string) => {
  const call = async <Schema extends z.ZodType>({ path, schema, init = { headers: { cookie } } }: { path: string; schema: Schema; init?: RequestInit }) => {
    const response = await fetch(`${API}${path}`, init);
    if (!response.ok) throw new Error(`Splitwise ${path.split('?')[0]} answered ${response.status}: ${(await response.text()).slice(0, 300)}`);
    return schema.parse(await response.json());
  };

  const write = async ({ path, body }: { path: string; body: Record<string, unknown> }) => {
    const session = await startWriteSession(cookie);
    const answer = await call({
      path,
      schema: z.object({ expenses: z.array(SplitwiseExpenseSchema).optional(), success: z.boolean().optional(), errors: ErrorsSchema }),
      init: {
        method: 'POST',
        headers: { cookie: session.cookie, 'x-csrf-token': session.token, 'content-type': 'application/json' },
        body: JSON.stringify(body),
      },
    });
    const refused = describeErrors(answer.errors);
    if (refused !== '' || answer.success === false) throw new Error(`Splitwise refused: ${refused || path}`);
    return answer.expenses ?? [];
  };

  return {
    readCurrentUser: async () => (await call({ path: '/get_current_user', schema: z.object({ user: UserSchema }) })).user,

    listFriends: async () => (await call({ path: '/get_friends', schema: z.object({ friends: z.array(FriendSchema) }) })).friends,

    listGroups: async () => (await call({ path: '/get_groups', schema: z.object({ groups: z.array(GroupSchema) }) })).groups,

    /** Every expense dated on or after `datedAfter`, deleted ones included, page by page. */
    listExpenses: async ({ datedAfter, friendId, groupId }: { datedAfter: string; friendId?: number; groupId?: number }) => {
      const expenses: SplitwiseExpense[] = [];
      for (let offset = 0; ; offset += PAGE_SIZE) {
        const params = new URLSearchParams({ dated_after: datedAfter, limit: String(PAGE_SIZE), offset: String(offset) });
        if (friendId !== undefined) params.set('friend_id', String(friendId));
        if (groupId !== undefined) params.set('group_id', String(groupId));
        const page = await call({ path: `/get_expenses?${params}`, schema: z.object({ expenses: z.array(SplitwiseExpenseSchema) }) });
        expenses.push(...page.expenses);
        if (page.expenses.length < PAGE_SIZE) return expenses;
      }
    },

    createExpense: async (expense: NewSplitwiseExpense) => {
      const shares = Object.fromEntries(
        expense.shares.flatMap((share, index) => [
          [`users__${index}__user_id`, share.userId],
          [`users__${index}__paid_share`, share.paid.toFixed(2)],
          [`users__${index}__owed_share`, share.owed.toFixed(2)],
        ]),
      );
      const [created] = await write({
        path: '/create_expense',
        body: {
          description: expense.description,
          cost: expense.cost.toFixed(2),
          currency_code: expense.currency,
          date: expense.date,
          group_id: expense.groupId ?? 0,
          payment: expense.payment,
          ...shares,
        },
      });
      if (created === undefined) throw new Error('Splitwise created nothing');
      return created;
    },

    deleteExpense: async (id: number) => {
      await write({ path: `/delete_expense/${id}`, body: {} });
    },

    restoreExpense: async (id: number) => {
      await write({ path: `/undelete_expense/${id}`, body: {} });
    },

    readExpense: async (id: number) =>
      (await call({ path: `/get_expense/${id}`, schema: z.object({ expense: SplitwiseExpenseSchema }) })).expense,
  };
};
export type SplitwiseClient = ReturnType<typeof createSplitwiseClient>;
