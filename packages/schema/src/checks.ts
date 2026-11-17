import { z } from 'zod';

import { SyncSourceSchema } from './primitives.ts';

/** One comparison of the tracker's balance with the bank's. */
export const BalanceCheckSchema = z.object({
  accountId: z.string(),
  accountName: z.string(),
  source: z.union([SyncSourceSchema, z.literal('freedom24')]),
  /**
   * statement: the balance Monobank printed after its newest line; sync: what the last sync run
   * reported; broker: the net assets in the broker's latest statement; wallet: the wallet totals
   * in the latest Binance export.
   */
  basis: z.enum(['statement', 'sync', 'broker', 'wallet']),
  checkedAt: z.iso.datetime(),
  bankBalance: z.number(),
  trackerBalance: z.number(),
  /** Tracker minus bank. */
  difference: z.number(),
  /** Largest difference still read as agreement: a cent for banks, a sliver of a market-priced wallet. */
  tolerance: z.number(),
  matches: z.boolean(),
});
export type BalanceCheck = z.infer<typeof BalanceCheckSchema>;
