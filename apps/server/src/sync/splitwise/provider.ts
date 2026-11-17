import { computeBalances, roundAmount, shiftDate } from '@hroshi/domain';
import { type Currency, CurrencySchema, type IsoDate } from '@hroshi/schema';

import { findToday } from '../../clock.ts';
import type { Db } from '../../db.ts';
import { env } from '../../env.ts';
import type { Account as AccountRow } from '../../generated/prisma/client.ts';
import { loadLedger } from '../../ledger.ts';
import { toIsoDate, toNumber } from '../../mappers.ts';
import { describeBalanceMismatch } from '../reconciliation.ts';
import { toLocalDate } from '../statement.ts';
import type { SyncCounts, SyncProvider } from '../types.ts';
import { listTrips, planExpenseBooking, planVanishedBookings, type SplitwiseBooking } from './book.ts';
import { createSplitwiseClient, type SplitwiseClient, type SplitwiseExpense, type SplitwiseFriend } from './client.ts';
import { describeShare } from './shares.ts';

const ACCOUNT_PREFIX = 'splitwise-';

/** Either cookie alone signs in, so the client still works while one of them has expired. */
const buildSplitwiseCookie = () => {
  const cookies = Object.entries({ _splitwise_session: env.SPLITWISE_SESSION, user_credentials: env.SPLITWISE_USER_CREDENTIALS }).flatMap(([name, value]) =>
    value === undefined ? [] : [`${name}=${value}`],
  );
  return cookies.length === 0 ? undefined : cookies.join('; ');
};

export const requireSplitwiseClient = (): SplitwiseClient => {
  const cookie = buildSplitwiseCookie();
  if (cookie === undefined) throw new Error('SPLITWISE_SESSION and SPLITWISE_USER_CREDENTIALS are not set');
  return createSplitwiseClient(cookie);
};

/**
 * One receivable account per currency mirrors the Splitwise balance in it. The owner's own
 * `splitwise-eur` is adopted; a currency seen for the first time gets an account opening with it.
 */
const ensureAccounts = async ({ db, currencies }: { db: Db; currencies: ReadonlySet<Currency> }) => {
  const found = await db.account.findMany({ where: { OR: [{ syncSource: 'splitwise' }, { id: { startsWith: ACCOUNT_PREFIX } }] } });
  await Promise.all(
    found.filter((account) => account.syncSource === null).map((account) => db.account.update({ where: { id: account.id }, data: { syncSource: 'splitwise' } })),
  );
  const accounts = new Map<Currency, AccountRow>(found.map((account) => [account.currency, account]));
  const missing = [...currencies].filter((currency) => !accounts.has(currency));
  if (missing.length === 0) return accounts;

  const opening = found.map((account) => account.openingDate).toSorted((left, right) => left.getTime() - right.getTime())[0] ?? new Date(`${findToday().slice(0, 7)}-01`);
  const { _max } = await db.account.aggregate({ _max: { order: true } });
  for (const [index, currency] of missing.entries()) {
    const account = await db.account.create({
      data: {
        id: `${ACCOUNT_PREFIX}${currency.toLowerCase()}`,
        name: `Splitwise ${currency}`,
        currency,
        kind: 'receivable',
        openingBalance: 0,
        openingDate: opening,
        order: (_max.order ?? 0) + 1 + index,
        syncSource: 'splitwise',
      },
    });
    accounts.set(currency, account);
  }
  return accounts;
};

/** The first day the ledger mirrors Splitwise; what was owed before it is the accounts' opening balance. */
const findMirrorStart = async (db: Db): Promise<IsoDate> => {
  const first = await db.account.findFirst({
    where: { OR: [{ syncSource: 'splitwise' }, { id: { startsWith: ACCOUNT_PREFIX } }] },
    orderBy: { openingDate: 'asc' },
  });
  return first === null ? `${findToday().slice(0, 7)}-01` : toIsoDate(first.openingDate);
};

const listCurrencies = ({ expenses, friends, me }: { expenses: readonly SplitwiseExpense[]; friends: readonly SplitwiseFriend[]; me: number }) => {
  const codes = [
    ...expenses.flatMap((expense) => {
      const share = describeShare({ expense, me });
      return share === undefined || share.kind === 'foreign' ? [] : [share.currency];
    }),
    ...friends.flatMap((friend) => friend.balance.map((balance) => balance.currency_code)),
  ];
  return new Set(codes.flatMap((code) => CurrencySchema.safeParse(code).data ?? []));
};

/** Everything booking needs, read once: the ledger, the mirror accounts and the trips. */
export const prepareSplitwiseBooking = async ({ db, me, currencies }: { db: Db; me: number; currencies: ReadonlySet<Currency> }): Promise<SplitwiseBooking> => {
  const accounts = await ensureAccounts({ db, currencies });
  const ledger = await loadLedger(db);
  return { db, me, ledger, accounts, trips: listTrips(ledger.transactions), claimed: new Set(), warnings: [] };
};

/** What Splitwise says each friend owes the owner, summed per currency; negative, the owner owes. */
const sumFriendBalances = (friends: readonly SplitwiseFriend[]) => {
  const sums = new Map<string, number>();
  for (const { currency_code: currency, amount } of friends.flatMap((friend) => friend.balance)) sums.set(currency, (sums.get(currency) ?? 0) + amount);
  return sums;
};

const syncSplitwise = async ({ db, log }: { db: Db; log: (message: string) => void }): Promise<SyncCounts> => {
  const client = requireSplitwiseClient();
  const from = await findMirrorStart(db);
  const [user, friends, fetched] = await Promise.all([
    client.readCurrentUser(),
    client.listFriends(),
    // A day early: Splitwise dates by UTC, the ledger by Madrid.
    client.listExpenses({ datedAfter: shiftDate(from, -1) }),
  ]);
  const expenses = fetched.filter((expense) => toLocalDate(new Date(expense.date)) >= from);
  const booking = await prepareSplitwiseBooking({ db, me: user.id, currencies: listCurrencies({ expenses, friends, me: user.id }) });

  const counts: SyncCounts = { fetched: expenses.length, created: 0, updated: 0 };
  for (const expense of expenses.toSorted((left, right) => left.date.localeCompare(right.date))) {
    const { created, updated } = await (await planExpenseBooking({ booking, expense })).apply();
    counts.created += created.length;
    counts.updated += updated;
  }
  const listed = new Set(expenses.filter((expense) => expense.deleted_at === null).map((expense) => expense.id));
  for (const plan of await planVanishedBookings({ booking, listed, from })) counts.updated += (await plan.apply()).updated;
  log(`${expenses.length} expenses since ${from}: ${counts.created} new, ${counts.updated} changed`);

  const ledger = await loadLedger(db);
  const balances = computeBalances({ accounts: ledger.accounts, transactions: ledger.transactions });
  const owed = sumFriendBalances(friends);
  const checks = [...booking.accounts.values()].map((account) =>
    describeBalanceMismatch({
      name: account.name,
      tracker: roundAmount(balances.get(account.id) ?? toNumber(account.openingBalance)),
      bank: roundAmount(owed.get(account.currency) ?? 0),
    }),
  );
  return { ...counts, warnings: [...booking.warnings, ...checks] };
};

export const splitwiseProvider: SyncProvider = {
  source: 'splitwise',
  isConfigured: () => buildSplitwiseCookie() !== undefined,
  run: syncSplitwise,
};
