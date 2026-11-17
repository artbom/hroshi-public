import { shiftDate } from '@hroshi/domain';
import type { IsoDate } from '@hroshi/schema';

import type { Db } from '../../db.ts';
import { fromIsoDate, toIsoDate, toNullableNumber } from '../../mappers.ts';
import { prefixExternalId } from '../ingest.ts';
import type { SyncCounts } from '../types.ts';

export type P2pPurchase = {
  orderNumber: string;
  date: IsoDate;
  fiatAmount: number;
  /** USDT the order credited. */
  assetAmount: number;
  payMethod: string;
  counterparty: string;
};

const BINANCE_ACCOUNT_ID = 'binance';
/** Orders are timestamped in UTC, card lines in local time; a late-evening order can land on the next day. */
const MATCH_WINDOW_DAYS = 1;
const AMOUNT_TOLERANCE = 0.005;
/** Payment methods that mean the hryvnia left the Mono white card. */
const MONO_PAY_METHODS = new Set(['Monobank']);
const MONO_CARD_ACCOUNT_ID = 'mono-uah';

/**
 * Finds the hryvnia that paid for the order: a card payment to a stranger (still in review) or
 * a transfer to Binance whose USDT is unknown. A hand-entered USDT figure is kept: it is what
 * actually arrived, after the fixed P2P fee the order does not show.
 */
const findPayment = async ({ db, order }: { db: Db; order: P2pPurchase }) =>
  db.transaction.findFirst({
    where: {
      toExternalId: null,
      amount: { gte: order.fiatAmount - AMOUNT_TOLERANCE, lte: order.fiatAmount + AMOUNT_TOLERANCE },
      currency: 'UAH',
      date: {
        gte: fromIsoDate(shiftDate(order.date, -MATCH_WINDOW_DAYS)),
        lte: fromIsoDate(shiftDate(order.date, MATCH_WINDOW_DAYS)),
      },
      OR: [{ type: 'expense' }, { type: 'transfer', toAccountId: { in: [BINANCE_ACCOUNT_ID, 'crypto'] } }],
    },
    orderBy: { date: 'asc' },
  });

export type P2pPreview = {
  /** Already booked: the order's id is on a row. */
  known: number;
  /** Will turn a hryvnia payment already in the ledger into the transfer to Binance. */
  linked: number;
  /** No payment yet: a placeholder transfer the Mono line claims later. */
  placeholders: number;
  /** Neither: listed as a warning, nothing written. */
  unmatched: number;
  /** USDT the linked and placeholder orders credit. */
  usdt: number;
  from: IsoDate | null;
  to: IsoDate | null;
};

/** What `ingestP2pPurchases` would do with these orders, worked out without writing. */
export const previewP2pPurchases = async ({ db, orders }: { db: Db; orders: readonly P2pPurchase[] }): Promise<P2pPreview> => {
  const binance = await db.account.findUniqueOrThrow({ where: { id: BINANCE_ACCOUNT_ID } });
  const preview: P2pPreview = { known: 0, linked: 0, placeholders: 0, unmatched: 0, usdt: 0, from: null, to: null };
  for (const order of orders) {
    const toExternalId = prefixExternalId('binance', `p2p:${order.orderNumber}`);
    if ((await db.transaction.findUnique({ where: { toExternalId } })) !== null) {
      preview.known += 1;
      continue;
    }
    if ((await findPayment({ db, order })) !== null) preview.linked += 1;
    else if (order.date >= toIsoDate(binance.openingDate) && MONO_PAY_METHODS.has(order.payMethod)) preview.placeholders += 1;
    else {
      preview.unmatched += 1;
      continue;
    }
    preview.usdt += order.assetAmount;
    preview.from = preview.from === null || order.date < preview.from ? order.date : preview.from;
    preview.to = preview.to === null || order.date > preview.to ? order.date : preview.to;
  }
  return preview;
};

export const ingestP2pPurchases = async ({
  db,
  orders,
}: {
  db: Db;
  orders: readonly P2pPurchase[];
}): Promise<SyncCounts> => {
  const counts = { fetched: orders.length, created: 0, updated: 0, warnings: [] as string[] };
  const binance = await db.account.findUniqueOrThrow({ where: { id: BINANCE_ACCOUNT_ID } });
  const unmatched: string[] = [];

  for (const order of orders) {
    const toExternalId = prefixExternalId('binance', `p2p:${order.orderNumber}`);
    if ((await db.transaction.findUnique({ where: { toExternalId } })) !== null) continue;
    const note = `P2P → ${order.assetAmount} USDT (${order.counterparty || order.payMethod})`;

    const payment = await findPayment({ db, order });
    if (payment !== null) {
      const knownCredit = payment.type === 'transfer' ? toNullableNumber(payment.toAmount) : null;
      await db.transaction.update({
        where: { id: payment.id },
        data: {
          type: 'transfer',
          toAccountId: binance.id,
          toAmount: knownCredit !== null && knownCredit > 0 ? knownCredit : order.assetAmount,
          toCurrency: 'USDT',
          category: null,
          toExternalId,
          needsReview: false,
          reviewReason: null,
          duplicateOfId: null,
          ...(payment.note === null || payment.type === 'expense' ? { note } : {}),
        },
      });
      counts.updated += 1;
      continue;
    }

    // Only orders that move the current Binance balance are worth a placeholder; the Mono
    // line claims it when it arrives.
    if (order.date >= toIsoDate(binance.openingDate) && MONO_PAY_METHODS.has(order.payMethod)) {
      await db.transaction.create({
        data: {
          type: 'transfer',
          date: fromIsoDate(order.date),
          accountId: MONO_CARD_ACCOUNT_ID,
          amount: order.fiatAmount,
          currency: 'UAH',
          toAccountId: binance.id,
          toAmount: order.assetAmount,
          toCurrency: 'USDT',
          note,
          source: 'binance',
          toExternalId,
        },
      });
      counts.created += 1;
    } else {
      unmatched.push(`${order.date.split('-').toReversed().join('.')} ${order.fiatAmount} грн`);
    }
  }

  if (unmatched.length > 0) {
    counts.warnings.push(`P2P без платежу в трекері (${unmatched.length}): ${unmatched.slice(-5).join(', ')}`);
  }
  return counts;
};
