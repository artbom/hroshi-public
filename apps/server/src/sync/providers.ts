import type { SyncSource } from '@hroshi/schema';

import { binanceProvider } from './binance/provider.ts';
import { revolutProvider } from './enable-banking/provider.ts';
import { ibkrProvider } from './ibkr/provider.ts';
import { monoProvider } from './mono/provider.ts';
import { splitwiseProvider } from './splitwise/provider.ts';
import type { SyncProvider } from './types.ts';

export const SYNC_PROVIDERS: Readonly<Record<SyncSource, SyncProvider>> = {
  mono: monoProvider,
  revolut: revolutProvider,
  binance: binanceProvider,
  ibkr: ibkrProvider,
  splitwise: splitwiseProvider,
};
