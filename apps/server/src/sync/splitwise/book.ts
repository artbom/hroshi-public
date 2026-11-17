import { countDaysBetween, shiftDate } from '@hroshi/domain';
import type { Currency, IsoDate, Transaction } from '@hroshi/schema';

import type { Db } from '../../db.ts';
import type { Account as AccountRow, Prisma, Transaction as TransactionRow } from '../../generated/prisma/client.ts';
import type { Ledger } from '../../ledger.ts';
import { fromIsoDate, toIsoDate, toNumber } from '../../mappers.ts';
import { prefixExternalId } from '../ingest.ts';
import { roundMoney, toLocalDate } from '../statement.ts';
import type { SplitwiseExpense } from './client.ts';
import { describeShare, describeUserName, mapSplitwiseCategory } from './shares.ts';

/** Splitwise dates a purchase by the receipt; the bank books it a day or two either side. */
const CARD_WINDOW_DAYS = 2;
/** A settle-up reaches the bank within a few days of being recorded. */
const PAYMENT_WINDOW_DAYS = 3;
/** The card was charged in another currency: converted amounts agree this closely. */
const FX_TOLERANCE = 0.02;
const AMOUNT_TOLERANCE = 0.01;
/** Hand entries are typed in round figures or estimated. */
const HAND_AMOUNT_MIN = 1;
const HAND_AMOUNT_RATIO = 0.015;
const HAND_SOURCES = ['claude', 'page'] as const;
const TRIP_PREFIX = 'trip:';
/** During a trip everything goes to «Подорожі» under the trip's tag (handover §6.5). */
const TRIP_CATEGORY = 'Подорожі';
const FALLBACK_CATEGORY = 'Інше';

type Trip = { tag: string; from: IsoDate; to: IsoDate };

export type SplitwiseBooking = {
  db: Db;
  me: number;
  ledger: Ledger;
  /** Per currency, the receivable account that mirrors the Splitwise balance. */
  accounts: ReadonlyMap<Currency, AccountRow>;
  trips: readonly Trip[];
  /** Rows an earlier expense of this run already claimed: two equal settle-ups must not share a bank line. */
  claimed: Set<string>;
  warnings: string[];
};

/** What booking one expense would touch, and the write that does it; the chat wraps it for undo. */
export type BookingPlan = { touches: string[]; apply: () => Promise<{ created: string[]; updated: number }> };

const NOTHING: BookingPlan = { touches: [], apply: async () => ({ created: [], updated: 0 }) };

const touch = ({ booking, id, write }: { booking: SplitwiseBooking; id: string; write: () => Promise<unknown> }): BookingPlan => {
  booking.claimed.add(id);
  return {
    touches: [id],
    apply: async () => {
      await write();
      return { created: [], updated: 1 };
    },
  };
};

const EXTERNAL_PREFIX = prefixExternalId('splitwise', '');

/** A trip is the span of days its tagged rows cover. */
export const listTrips = (transactions: readonly Pick<Transaction, 'date' | 'tags'>[]): Trip[] => {
  const trips = new Map<string, Trip>();
  for (const { date, tags } of transactions) {
    for (const tag of tags.filter((candidate) => candidate.startsWith(TRIP_PREFIX))) {
      const trip = trips.get(tag);
      trips.set(tag, trip === undefined ? { tag, from: date, to: date } : { tag, from: date < trip.from ? date : trip.from, to: date > trip.to ? date : trip.to });
    }
  }
  return [...trips.values()];
};

const isWithinDays = (left: IsoDate, right: IsoDate, days: number) => Math.abs(countDaysBetween(left, right)) <= days;

const pickClosest = <Row extends { date: IsoDate }>(rows: readonly Row[], date: IsoDate): Row | undefined =>
  rows.toSorted((left, right) => Math.abs(countDaysBetween(left.date, date)) - Math.abs(countDaysBetween(right.date, date))).at(0);

/** Same currency to the cent; otherwise the euros the card was charged, or the day's rate. */
const matchesAmount = ({ ledger, row, amount, currency, date }: { ledger: Ledger; row: Transaction; amount: number; currency: Currency; date: IsoDate }) => {
  if (row.currency === currency) return Math.abs(row.amount - amount) <= AMOUNT_TOLERANCE;
  const wanted = ledger.fx.toEur(amount, currency, date);
  const charged = row.operationEur ?? ledger.fx.toEur(row.amount, row.currency, row.date);
  return wanted !== null && charged !== null && Math.abs(charged - wanted) <= wanted * FX_TOLERANCE;
};

const listOwnAccountIds = (booking: SplitwiseBooking) => new Set([...booking.accounts.values()].map((account) => account.id));

/** The card payment of a bill the owner paid for everyone: its category and trip tag are the share's too. */
const findCardPayment = ({ booking, paid, currency, date }: { booking: SplitwiseBooking; paid: number; currency: Currency; date: IsoDate }) => {
  const mirrors = listOwnAccountIds(booking);
  return pickClosest(
    booking.ledger.transactions.filter(
      (row) =>
        row.type === 'expense' &&
        !mirrors.has(row.accountId) &&
        isWithinDays(row.date, date, CARD_WINDOW_DAYS) &&
        matchesAmount({ ledger: booking.ledger, row, amount: paid, currency, date }),
    ),
    date,
  );
};

const findHandEntry = async ({
  booking,
  account,
  type,
  amount,
  date,
}: {
  booking: SplitwiseBooking;
  account: AccountRow;
  type: 'expense' | 'income';
  amount: number;
  date: IsoDate;
}) => {
  const slack = Math.max(HAND_AMOUNT_MIN, amount * HAND_AMOUNT_RATIO);
  const rows = await booking.db.transaction.findMany({
    where: {
      id: { notIn: [...booking.claimed] },
      accountId: account.id,
      type,
      externalId: null,
      source: { in: [...HAND_SOURCES] },
      splitOfId: null,
      amount: { gte: amount - slack, lte: amount + slack },
      date: { gte: fromIsoDate(shiftDate(date, -CARD_WINDOW_DAYS)), lte: fromIsoDate(shiftDate(date, CARD_WINDOW_DAYS)) },
    },
  });
  return pickClosest(rows.map((row) => ({ ...row, date: toIsoDate(row.date) })), date);
};

/** The expense is gone or no longer the owner's: a row it made goes, a row it claimed goes back to review. */
const planRelease = ({ booking, row, externalId }: { booking: SplitwiseBooking; row: TransactionRow; externalId: string }): BookingPlan => {
  const { db } = booking;
  if (row.source === 'splitwise') return touch({ booking, id: row.id, write: () => db.transaction.delete({ where: { id: row.id } }) });
  return touch({
    booking,
    id: row.id,
    write: () =>
      db.transaction.update({
        where: { id: row.id },
        data: {
          ...(row.externalId === externalId ? { externalId: null } : { toExternalId: null }),
          needsReview: true,
          reviewReason: 'У Splitwise цієї витрати більше немає',
        },
      }),
  });
};

const describeCostRow = ({
  booking,
  expense,
  delta,
  paid,
  currency,
  date,
}: {
  booking: SplitwiseBooking;
  expense: SplitwiseExpense;
  delta: number;
  paid: number;
  currency: Currency;
  date: IsoDate;
}) => {
  if (delta > 0) {
    const card = findCardPayment({ booking, paid, currency, date });
    if (card !== undefined) {
      return { category: card.category ?? FALLBACK_CATEGORY, tags: card.tags, note: `${expense.description} · частка інших`, reviewReason: null };
    }
  }
  const trip = booking.trips.find(({ from, to }) => from <= date && date <= to);
  const mapped = mapSplitwiseCategory(expense.category?.name);
  const category = trip === undefined ? (mapped ?? FALLBACK_CATEGORY) : TRIP_CATEGORY;
  const payer = expense.users.find((share) => share.user_id !== booking.me && share.paid_share > 0)?.user ?? undefined;
  if (delta > 0) {
    return {
      category,
      tags: trip === undefined ? [] : [trip.tag],
      note: `${expense.description} · частка інших`,
      reviewReason: `Не знайшов оплату ${paid} ${currency} карткою; перевір категорію частки інших`,
    };
  }
  return {
    category,
    tags: trip === undefined ? [] : [trip.tag],
    note: `${expense.description} · платив ${describeUserName(payer)}`,
    reviewReason: trip === undefined && mapped === undefined ? `Splitwise: ${expense.category?.name ?? 'без категорії'}` : null,
  };
};

/**
 * A shared cost: the owner's part of a bill someone else paid is an expense from the Splitwise
 * account; the others' part of a bill the owner paid is income there in the bill's category, so the
 * month's spending is the owner's share and the account mirrors what Splitwise says is owed.
 */
const planCost = async ({
  booking,
  expense,
  linked,
  account,
  delta,
  paid,
  date,
  externalId,
}: {
  booking: SplitwiseBooking;
  expense: SplitwiseExpense;
  linked: TransactionRow | null;
  account: AccountRow;
  delta: number;
  paid: number;
  date: IsoDate;
  externalId: string;
}): Promise<BookingPlan> => {
  const { db } = booking;
  const amount = Math.abs(delta);
  const type = delta < 0 ? 'expense' : 'income';
  if (linked !== null) {
    const unchanged =
      linked.type === type && linked.accountId === account.id && Math.abs(toNumber(linked.amount) - amount) < AMOUNT_TOLERANCE / 2 && toIsoDate(linked.date) === date;
    if (unchanged) return NOTHING;
    // Splitwise owns the figures; the category, tags and note stay the owner's.
    return touch({
      booking,
      id: linked.id,
      write: () => db.transaction.update({ where: { id: linked.id }, data: { type, amount, accountId: account.id, currency: account.currency, date: fromIsoDate(date) } }),
    });
  }

  const raw: Prisma.InputJsonValue = expense;
  const hand = await findHandEntry({ booking, account, type, amount, date });
  if (hand !== undefined) {
    return touch({ booking, id: hand.id, write: () => db.transaction.update({ where: { id: hand.id }, data: { externalId, amount, raw } }) });
  }

  const row = describeCostRow({ booking, expense, delta, paid, currency: account.currency, date });
  return {
    touches: [],
    apply: async () => {
      const created = await db.transaction.create({
        data: {
          type,
          date: fromIsoDate(date),
          accountId: account.id,
          amount,
          currency: account.currency,
          category: row.category,
          tags: row.tags,
          note: row.note,
          source: 'splitwise',
          externalId,
          needsReview: row.reviewReason !== null,
          reviewReason: row.reviewReason,
          raw,
        },
      });
      return { created: [created.id], updated: 0 };
    },
  };
};

/**
 * A settle-up moved real money, so the bank has it: a transfer to (or from) the Splitwise account.
 * One the owner already booked is linked; a bank line still waiting in review becomes that transfer.
 */
const planPayment = async ({
  booking,
  expense,
  account,
  delta,
  date,
  externalId,
}: {
  booking: SplitwiseBooking;
  expense: SplitwiseExpense;
  account: AccountRow;
  delta: number;
  date: IsoDate;
  externalId: string;
}): Promise<BookingPlan> => {
  const { db, ledger } = booking;
  const amount = Math.abs(delta);
  const paidOut = delta > 0;
  const nearby = ledger.transactions.filter(
    (row) => isWithinDays(row.date, date, PAYMENT_WINDOW_DAYS) && row.splitOfId === null && !booking.claimed.has(row.id),
  );
  const isBookedTransfer = (row: Transaction) =>
    row.type === 'transfer' &&
    (paidOut
      ? row.toAccountId === account.id && Math.abs((row.toAmount ?? row.amount) - amount) <= AMOUNT_TOLERANCE
      : row.accountId === account.id && Math.abs(row.amount - amount) <= AMOUNT_TOLERANCE);

  const booked = pickClosest(nearby.filter(isBookedTransfer), date);
  if (booked !== undefined) {
    const current = await db.transaction.findUniqueOrThrow({ where: { id: booked.id } });
    if ((paidOut ? current.toExternalId : current.externalId) === null) {
      return touch({
        booking,
        id: booked.id,
        write: () => db.transaction.update({ where: { id: booked.id }, data: paidOut ? { toExternalId: externalId } : { externalId } }),
      });
    }
  }

  const mirrors = listOwnAccountIds(booking);
  const line = pickClosest(
    nearby.filter(
      (row) =>
        row.type === (paidOut ? 'expense' : 'income') &&
        row.needsReview &&
        row.synced &&
        !mirrors.has(row.accountId) &&
        matchesAmount({ ledger, row, amount, currency: account.currency, date }),
    ),
    date,
  );
  if (line === undefined) {
    const friend = describeUserName(expense.users.find((share) => share.user_id !== booking.me)?.user ?? undefined);
    booking.warnings.push(`Splitwise: погашення ${amount} ${account.currency} ${paidOut ? 'для' : 'від'} ${friend} (${date}) ще не видно в банку`);
    return NOTHING;
  }

  const sameCurrency = line.currency === account.currency;
  const cleared = { type: 'transfer', category: null, needsReview: false, reviewReason: null } as const;
  if (paidOut) {
    return touch({
      booking,
      id: line.id,
      write: () =>
        db.transaction.update({
          where: { id: line.id },
          data: { ...cleared, toAccountId: account.id, toAmount: sameCurrency ? null : amount, toCurrency: account.currency, toExternalId: externalId },
        }),
    });
  }
  const bankLine = await db.transaction.findUniqueOrThrow({ where: { id: line.id } });
  return touch({
    booking,
    id: line.id,
    write: () =>
      db.transaction.update({
        where: { id: line.id },
        data: {
          ...cleared,
          accountId: account.id,
          amount,
          currency: account.currency,
          toAccountId: line.accountId,
          toAmount: sameCurrency ? null : line.amount,
          toCurrency: line.currency,
          externalId,
          toExternalId: bankLine.externalId,
        },
      }),
  });
};

/** How one Splitwise expense lands in the ledger, idempotent: booking it again changes nothing. */
export const planExpenseBooking = async ({ booking, expense }: { booking: SplitwiseBooking; expense: SplitwiseExpense }): Promise<BookingPlan> => {
  const { db, me } = booking;
  const externalId = prefixExternalId('splitwise', String(expense.id));
  const linked = await db.transaction.findFirst({ where: { OR: [{ externalId }, { toExternalId: externalId }] } });
  const share = expense.deleted_at === null ? describeShare({ expense, me }) : undefined;
  if (share === undefined || (share.kind === 'cost' && share.delta === 0)) {
    return linked === null ? NOTHING : planRelease({ booking, row: linked, externalId });
  }
  if (share.kind === 'foreign') {
    booking.warnings.push(`Splitwise: «${expense.description}» у ${share.currency}, такої валюти облік не веде`);
    return NOTHING;
  }
  const account = booking.accounts.get(share.currency);
  if (account === undefined) {
    booking.warnings.push(`Splitwise: немає рахунку для ${share.currency}, «${expense.description}» не внесено`);
    return NOTHING;
  }
  const date = toLocalDate(new Date(expense.date));
  if (share.kind === 'cost') {
    return planCost({ booking, expense, linked, account, delta: share.delta, paid: share.paid, date, externalId });
  }
  if (linked !== null) return NOTHING;
  return planPayment({ booking, expense, account, delta: roundMoney(share.delta), date, externalId });
};

/** Rows of expenses Splitwise no longer lists from `from` on: deleted for good, or not the owner's any more. */
export const planVanishedBookings = async ({
  booking,
  listed,
  from,
}: {
  booking: SplitwiseBooking;
  listed: ReadonlySet<number>;
  from: IsoDate;
}): Promise<BookingPlan[]> => {
  const rows = await booking.db.transaction.findMany({
    where: {
      date: { gte: fromIsoDate(from) },
      OR: [{ externalId: { startsWith: EXTERNAL_PREFIX } }, { toExternalId: { startsWith: EXTERNAL_PREFIX } }],
    },
  });
  return rows.flatMap((row) => {
    const externalId = [row.externalId, row.toExternalId].find((id) => id?.startsWith(EXTERNAL_PREFIX) === true);
    if (externalId == null || listed.has(Number(externalId.slice(EXTERNAL_PREFIX.length)))) return [];
    return [planRelease({ booking, row, externalId })];
  });
};
