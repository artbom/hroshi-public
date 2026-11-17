import { createHmac } from 'node:crypto';

import { z } from 'zod';

const BINANCE_API = 'https://api.binance.com';
const RECV_WINDOW_MS = 10_000;
/** The P2P history endpoint accepts at most this span per call. */
export const P2P_WINDOW_MS = 30 * 24 * 3600 * 1000;
const P2P_PAGE_SIZE = 100;

const NumericStringSchema = z.union([z.string(), z.number()]).pipe(z.coerce.number());

const P2pOrderSchema = z.object({
  orderNumber: z.string(),
  tradeType: z.string(),
  asset: z.string(),
  fiat: z.string(),
  amount: NumericStringSchema,
  totalPrice: NumericStringSchema,
  orderStatus: z.string(),
  createTime: z.number(),
  counterPartNickName: z.string().optional(),
  payMethodName: z.string().optional(),
});

const P2pPageSchema = z.object({ data: z.array(P2pOrderSchema).default([]), total: z.number().optional() });

const WalletBalanceSchema = z.array(z.object({ walletName: z.string(), balance: NumericStringSchema }));

export type BinanceP2pOrder = z.infer<typeof P2pOrderSchema>;

export const createBinanceClient = ({ apiKey, apiSecret }: { apiKey: string; apiSecret: string }) => {
  const request = async <TSchema extends z.ZodType>(
    path: string,
    params: Record<string, string | number>,
    schema: TSchema,
  ): Promise<z.infer<TSchema>> => {
    const query = new URLSearchParams(
      Object.fromEntries(
        Object.entries({ ...params, recvWindow: RECV_WINDOW_MS, timestamp: Date.now() }).map(([key, value]) => [
          key,
          String(value),
        ]),
      ),
    ).toString();
    const signature = createHmac('sha256', apiSecret).update(query).digest('hex');
    const response = await fetch(`${BINANCE_API}${path}?${query}&signature=${signature}`, {
      headers: { 'X-MBX-APIKEY': apiKey },
    });
    if (!response.ok) throw new Error(`Binance ${path} answered ${response.status}: ${await response.text()}`);
    return schema.parse(await response.json());
  };

  const fetchP2pOrders = async ({ from, to }: { from: number; to: number }): Promise<BinanceP2pOrder[]> => {
    const orders: BinanceP2pOrder[] = [];
    for (let start = from; start < to; start += P2P_WINDOW_MS) {
      for (let page = 1; ; page += 1) {
        const { data } = await request(
          '/sapi/v1/c2c/orderMatch/listUserOrderHistory',
          { tradeType: 'BUY', startTimestamp: start, endTimestamp: Math.min(start + P2P_WINDOW_MS, to), page, rows: P2P_PAGE_SIZE },
          P2pPageSchema,
        );
        orders.push(...data);
        if (data.length < P2P_PAGE_SIZE) break;
      }
    }
    return orders;
  };

  /** Every wallet (Spot, Funding, Earn…) valued in USDT by Binance itself. */
  const fetchTotalUsdt = async (): Promise<number> => {
    const wallets = await request('/sapi/v1/asset/wallet/balance', { quoteAsset: 'USDT' }, WalletBalanceSchema);
    return wallets.reduce((sum, wallet) => sum + wallet.balance, 0);
  };

  return { fetchP2pOrders, fetchTotalUsdt };
};
