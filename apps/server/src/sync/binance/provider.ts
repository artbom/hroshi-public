import { computeBalances, roundAmount } from '@hroshi/domain';
import { z } from 'zod';

import { findToday } from '../../clock.ts';
import type { Db } from '../../db.ts';
import { env } from '../../env.ts';
import { badRequest } from '../../http-errors.ts';
import { loadLedger } from '../../ledger.ts';
import { describeBalanceMismatch } from '../reconciliation.ts';
import { toLocalDate } from '../statement.ts';
import { keepBrokerStatement } from '../../brokers/import.ts';
import type { ImportFile, ImportPlan, SyncCounts, SyncProvider } from '../types.ts';
import { recordValuation } from '../valuation.ts';
import { createBinanceClient, type BinanceP2pOrder } from './client.ts';
import { ingestP2pPurchases, type P2pPurchase, previewP2pPurchases } from './p2p.ts';

const BINANCE_ACCOUNT_ID = 'binance';
/** A daily run looks back a month: late-completed orders and missed days are covered, matched orders are skipped. */
const LOOKBACK_MS = 30 * 24 * 3600 * 1000;
const VALUATION_NOTE = 'Переоцінка за даними Binance (Earn, курси, комісії)';

const mapApiOrder = (order: BinanceP2pOrder): P2pPurchase => ({
  orderNumber: order.orderNumber,
  date: toLocalDate(new Date(order.createTime)),
  fiatAmount: order.totalPrice,
  assetAmount: order.amount,
  payMethod: order.payMethodName ?? '',
  counterparty: order.counterPartNickName ?? '',
});

const settleBinance = async ({
  db,
  purchases,
  totalUsdt,
}: {
  db: Db;
  purchases: readonly P2pPurchase[];
  totalUsdt: number;
}): Promise<SyncCounts> => {
  const p2p = await ingestP2pPurchases({ db, orders: purchases });
  const valuation = await recordValuation({
    db,
    source: 'binance',
    accountId: BINANCE_ACCOUNT_ID,
    value: totalUsdt,
    date: findToday(),
    note: VALUATION_NOTE,
  });
  // Recorded even when it matches, so the accounts page can say «✓ як у Binance».
  const ledger = await loadLedger(db);
  const account = ledger.accounts.find((candidate) => candidate.id === BINANCE_ACCOUNT_ID);
  const tracker = computeBalances({ accounts: ledger.accounts, transactions: ledger.transactions }).get(BINANCE_ACCOUNT_ID);
  const check =
    account === undefined || tracker === undefined ? [] : [describeBalanceMismatch({ name: account.name, tracker, bank: roundAmount(totalUsdt) })];
  return {
    fetched: p2p.fetched,
    created: p2p.created + valuation.created,
    updated: p2p.updated + valuation.updated,
    warnings: [...(p2p.warnings ?? []), ...check],
  };
};

export const binanceProvider: SyncProvider = {
  source: 'binance',
  isConfigured: () => env.BINANCE_API_KEY !== undefined && env.BINANCE_API_SECRET !== undefined,
  run: async ({ db }) => {
    if (env.BINANCE_API_KEY === undefined || env.BINANCE_API_SECRET === undefined) {
      throw new Error('BINANCE_API_KEY and BINANCE_API_SECRET are not set');
    }
    const client = createBinanceClient({ apiKey: env.BINANCE_API_KEY, apiSecret: env.BINANCE_API_SECRET });
    const to = Date.now();
    const [orders, totalUsdt] = await Promise.all([
      client.fetchP2pOrders({ from: to - LOOKBACK_MS, to }),
      client.fetchTotalUsdt(),
    ]);
    const purchases = orders.filter((order) => order.orderStatus === 'COMPLETED' && order.asset === 'USDT');
    return settleBinance({ db, purchases: purchases.map(mapApiOrder), totalUsdt });
  },
};

const ExportOrderSchema = z.object({
  date_utc: z.string(),
  type: z.string(),
  fiat: z.string(),
  fiat_amount: z.coerce.number(),
  asset: z.string(),
  asset_amount: z.coerce.number(),
  counterparty: z.string(),
  pay_method: z.string(),
  order_number: z.string(),
});

const ExportBalancesSchema = z.object({
  wallets_usdt: z.array(z.object({ walletName: z.string(), balance: z.coerce.number() })),
});

const formatUsdt = (value: number) => `${value.toLocaleString('uk-UA', { maximumFractionDigits: 2 })} USDT`;

const isExportBalances = (content: unknown) => ExportBalancesSchema.safeParse(content).success;

/**
 * The owner's Binance export: p2p_completed.json (orders) and balances.json (wallet totals),
 * given in either order. Orders become transfers from the hryvnia card; the wallet total books
 * today's valuation.
 */
export const planBinanceImport = async ({ db, files }: { db: Db; files: readonly ImportFile[] }): Promise<ImportPlan> => {
  const balancesFile = files.find((file) => isExportBalances(file.content));
  const ordersFile = files.find((file) => !isExportBalances(file.content));
  if (balancesFile === undefined || ordersFile === undefined) {
    throw badRequest('Потрібні обидва файли експорту Binance: p2p_completed.json і balances.json');
  }
  const orders = z.array(ExportOrderSchema).parse(ordersFile.content);
  const { wallets_usdt: wallets } = ExportBalancesSchema.parse(balancesFile.content);
  const keepBalances = (dryRun: boolean) =>
    keepBrokerStatement({ broker: 'binance', json: balancesFile.content, name: balancesFile.name, modified: balancesFile.modified, dryRun });
  // Parsed up front so a balances file the investments page cannot read fails the preview, not the import.
  await keepBalances(true);
  const purchases = orders
    .filter((order) => order.type === 'BUY' && order.asset === 'USDT' && order.fiat === 'UAH')
    .map((order) => ({
      orderNumber: order.order_number,
      date: toLocalDate(new Date(`${order.date_utc.replace(' ', 'T')}Z`)),
      fiatAmount: order.fiat_amount,
      assetAmount: order.asset_amount,
      payMethod: order.pay_method,
      counterparty: order.counterparty,
    }));
  const totalUsdt = roundAmount(wallets.reduce((sum, wallet) => sum + wallet.balance, 0));
  const [p2p, ledger] = await Promise.all([previewP2pPurchases({ db, orders: purchases }), loadLedger(db)]);
  const balance = computeBalances({ accounts: ledger.accounts, transactions: ledger.transactions }).get(BINANCE_ACCOUNT_ID) ?? 0;
  const account = ledger.accounts.find((candidate) => candidate.id === BINANCE_ACCOUNT_ID);
  const added = p2p.linked + p2p.placeholders;
  return {
    preview: {
      lines: orders.length,
      added,
      known: p2p.known,
      dismissed: 0,
      skipped: orders.length - added - p2p.known,
      from: p2p.from,
      to: p2p.to,
      accounts: [
        {
          accountId: BINANCE_ACCOUNT_ID,
          name: account?.name ?? 'Binance',
          currency: 'USDT',
          added,
          known: p2p.known,
          dismissed: 0,
          likelyHand: p2p.linked,
          from: p2p.from,
          to: p2p.to,
          inflow: roundAmount(p2p.usdt),
          outflow: 0,
        },
      ],
      notes: [
        `Після імпорту баланс Binance дорівнюватиме сумі гаманців з експорту: ${formatUsdt(totalUsdt)} (зараз у трекері ${formatUsdt(balance)}). Те, чого не пояснять нові P2P, запише одна переоцінка на сьогодні`,
        ...(p2p.unmatched > 0 ? [`P2P-ордери без платежу в трекері й до відкриття рахунку пропускаються (${p2p.unmatched})`] : []),
        'Баланси збережуться як звіт Binance: з них «Інвестиції» показують монети, а «Рахунки» — звірку з гаманцями',
      ],
    },
    source: 'binance',
    apply: async () => {
      const counts = await settleBinance({ db, purchases, totalUsdt });
      await keepBalances(false);
      return counts;
    },
  };
};
