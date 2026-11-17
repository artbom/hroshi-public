import type { BrokerReport } from '@hroshi/schema';

import { parseBinanceBalances } from './binance.ts';
import { parseFreedom24Report } from './freedom24.ts';
import { parseFlexReport } from './ibkr.ts';
import { readLatestBrokerFile } from './store.ts';

/** Tracker account each broker's statement describes. */
export const ACCOUNT_BY_BROKER = { ibkr: 'ibkr', freedom24: 'freedom24', binance: 'binance' } as const;

/** A statement that no longer parses is left out rather than breaking the page. */
const readSafely = async (read: () => Promise<BrokerReport | undefined>): Promise<BrokerReport | undefined> => {
  try {
    return await read();
  } catch {
    return undefined;
  }
};

/** The latest imported statement of each broker, keyed by tracker account id. */
export const loadBrokerReports = async (): Promise<Map<string, BrokerReport>> => {
  const [ibkr, freedom24, binance] = await Promise.all([
    readSafely(async () => {
      const file = await readLatestBrokerFile('ibkr');
      return file === undefined ? undefined : parseFlexReport({ xml: file.content, file: file.name });
    }),
    readSafely(async () => {
      const file = await readLatestBrokerFile('freedom24');
      return file === undefined ? undefined : parseFreedom24Report({ json: JSON.parse(file.content), file: file.name });
    }),
    readSafely(async () => {
      const file = await readLatestBrokerFile('binance');
      // The export file carries no date of its own; its import day is when the balances were true.
      const asOf = file?.name.match(/\d{4}-\d{2}-\d{2}/)?.[0];
      return file === undefined || asOf === undefined
        ? undefined
        : parseBinanceBalances({ json: JSON.parse(file.content), file: file.name, asOf });
    }),
  ]);
  const entries: [string, BrokerReport | undefined][] = [
    [ACCOUNT_BY_BROKER.ibkr, ibkr],
    [ACCOUNT_BY_BROKER.freedom24, freedom24],
    [ACCOUNT_BY_BROKER.binance, binance],
  ];
  return new Map(entries.flatMap(([id, report]) => (report === undefined ? [] : [[id, report] as const])));
};
