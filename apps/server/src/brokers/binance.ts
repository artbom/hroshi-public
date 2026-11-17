import type { BrokerReport } from '@hroshi/schema';
import { z } from 'zod';

const NumberSchema = z.union([z.number(), z.string()]).pipe(z.coerce.number());

const BalancesSchema = z.object({
  spot: z.array(z.object({ asset: z.string(), free: NumberSchema, locked: NumberSchema })).default([]),
  funding: z.array(z.object({ asset: z.string(), free: NumberSchema })).default([]),
  earn_flexible: z.array(z.object({ asset: z.string(), totalAmount: NumberSchema })).default([]),
  earn_locked: z.array(z.object({ asset: z.string(), amount: NumberSchema })).default([]),
});

/** Stablecoins worth one dollar; everything else is shown by quantity, priced by Binance's wallet total. */
const DOLLAR_ASSETS = new Set(['USDT', 'USDC', 'FDUSD', 'BUSD', 'DAI']);
/** Spot balances prefixed LD are Simple Earn receipts already counted under Earn. */
const EARN_RECEIPT = /^LD/;
/** Airdrop leftovers worth less than this are noise. */
const DUST = 1e-4;

export const parseBinanceBalances = ({ json, file, asOf }: { json: unknown; file: string; asOf: string }): BrokerReport => {
  const balances = BalancesSchema.parse(json);
  const totals = new Map<string, number>();
  const add = (asset: string, amount: number) => totals.set(asset, (totals.get(asset) ?? 0) + amount);
  for (const entry of balances.spot) if (!EARN_RECEIPT.test(entry.asset)) add(entry.asset, entry.free + entry.locked);
  for (const entry of balances.funding) add(entry.asset, entry.free);
  for (const entry of balances.earn_flexible) add(entry.asset, entry.totalAmount);
  for (const entry of balances.earn_locked) add(entry.asset, entry.amount);

  return {
    broker: 'binance',
    asOf,
    file,
    currency: 'USDT',
    netAssets: null,
    holdings: [...totals]
      .filter(([, quantity]) => quantity > DUST)
      .map(([asset, quantity]) => ({
        symbol: asset,
        name: null,
        quantity,
        currency: asset,
        price: DOLLAR_ASSETS.has(asset) ? 1 : null,
        value: DOLLAR_ASSETS.has(asset) ? quantity : null,
        cost: null,
      }))
      .toSorted((left, right) => (right.value ?? 0) - (left.value ?? 0)),
    cashFlows: [],
    navHistory: [],
    realized: null,
    trades: null,
    navChange: null,
  };
};
