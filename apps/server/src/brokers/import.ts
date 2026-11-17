import { readFile, stat } from 'node:fs/promises';
import { basename } from 'node:path';

import type { BrokerReport } from '@hroshi/schema';

import { env } from '../env.ts';
import { fetchFlexStatement } from '../sync/ibkr/flex.ts';
import { parseBinanceBalances } from './binance.ts';
import { parseFreedom24Report } from './freedom24.ts';
import { saveBrokerFile } from './store.ts';

/**
 * Checks the statement parses before keeping it, so a wrong export never replaces a good one.
 * A balances export has no date inside: the day the file was written is when it was true.
 */
export const keepBrokerStatement = async ({
  broker,
  json,
  name,
  modified,
  dryRun,
}: {
  broker: 'freedom24' | 'binance';
  json: unknown;
  name: string;
  modified: Date;
  dryRun: boolean;
}): Promise<{ report: BrokerReport; saved: string | null }> => {
  const report =
    broker === 'freedom24'
      ? parseFreedom24Report({ json, file: name })
      : parseBinanceBalances({ json, file: name, asOf: modified.toLocaleDateString('en-CA') });
  const kept = broker === 'freedom24' ? `report-${report.asOf}.json` : `balances-${report.asOf}.json`;
  return { report, saved: dryRun ? null : await saveBrokerFile({ broker, name: kept, content: JSON.stringify(json) }) };
};

export const importBrokerFile = async ({ broker, path }: { broker: 'freedom24' | 'binance'; path: string }) => {
  const [content, stats] = await Promise.all([readFile(path, 'utf8'), stat(path)]);
  const { report, saved } = await keepBrokerStatement({ broker, json: JSON.parse(content), name: basename(path), modified: stats.mtime, dryRun: false });
  return { saved, asOf: report.asOf };
};

/** Keeps today's Flex statement (positions, cash records, daily NAV) for the investments page. */
export const saveIbkrStatement = async ({ xml, date }: { xml: string; date: string }) =>
  saveBrokerFile({ broker: 'ibkr', name: `flex-${date}.xml`, content: xml });

export const fetchIbkrStatement = async ({ date }: { date: string }) => {
  if (env.IBKR_FLEX_TOKEN === undefined || env.IBKR_FLEX_QUERY_ID === undefined) {
    throw new Error('IBKR_FLEX_TOKEN and IBKR_FLEX_QUERY_ID are not set');
  }
  const xml = await fetchFlexStatement({ token: env.IBKR_FLEX_TOKEN, queryId: env.IBKR_FLEX_QUERY_ID });
  return { saved: await saveIbkrStatement({ xml, date }) };
};
