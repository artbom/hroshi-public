import { setTimeout as sleep } from 'node:timers/promises';

import type { IsoDate } from '@hroshi/schema';

const FLEX_SERVICE = 'https://ndcdyn.interactivebrokers.com/AccountManagement/FlexWebService';
/** IBKR answers "statement generation in progress" (1019) for a few seconds after SendRequest. */
const IN_PROGRESS_CODE = '1019';
const POLL_INTERVAL_MS = 5_000;
const MAX_POLLS = 24;

const decodeXml = (value: string) =>
  value.replaceAll('&quot;', '"').replaceAll('&apos;', "'").replaceAll('&lt;', '<').replaceAll('&gt;', '>').replaceAll('&amp;', '&');

const readTagText = (xml: string, tag: string): string | undefined =>
  xml.match(new RegExp(`<${tag}>([^<]*)</${tag}>`))?.[1]?.trim();

/** Flex rows are self-closing elements whose data lives entirely in attributes. */
export const readFlexRows = (xml: string, tag: string): Record<string, string>[] =>
  [...xml.matchAll(new RegExp(`<${tag}\\s([^>]*?)/?>`, 'g'))].map(([, attributes = '']) =>
    Object.fromEntries([...attributes.matchAll(/(\w+)="([^"]*)"/g)].map(([, key = '', value = '']) => [key, decodeXml(value)])),
  );

/** Flex dates come as 20261110, 2026-11-10 or 20261110;101500 depending on the query settings. */
export const parseFlexDate = (value: string | undefined): IsoDate | undefined => {
  const digits = value?.replaceAll('-', '').slice(0, 8);
  return digits !== undefined && /^\d{8}$/.test(digits)
    ? `${digits.slice(0, 4)}-${digits.slice(4, 6)}-${digits.slice(6, 8)}`
    : undefined;
};

const fetchXml = async (url: string): Promise<string> => {
  // The Flex service rejects requests without a user agent.
  const response = await fetch(url, { headers: { 'User-Agent': 'hroshi/1.0' } });
  if (!response.ok) throw new Error(`IBKR Flex answered ${response.status}`);
  return response.text();
};

const describeFlexError = (xml: string) =>
  `IBKR Flex error ${readTagText(xml, 'ErrorCode') ?? '?'}: ${readTagText(xml, 'ErrorMessage') ?? 'unknown'}`;

/** Runs the saved Flex query and returns the statement XML once IBKR has generated it. */
export const fetchFlexStatement = async ({ token, queryId }: { token: string; queryId: string }): Promise<string> => {
  const request = await fetchXml(`${FLEX_SERVICE}/SendRequest?t=${encodeURIComponent(token)}&q=${encodeURIComponent(queryId)}&v=3`);
  const referenceCode = readTagText(request, 'ReferenceCode');
  const statementUrl = readTagText(request, 'Url');
  if (readTagText(request, 'Status') !== 'Success' || referenceCode === undefined || statementUrl === undefined) {
    throw new Error(describeFlexError(request));
  }

  for (let poll = 0; poll < MAX_POLLS; poll += 1) {
    const statement = await fetchXml(`${statementUrl}?t=${encodeURIComponent(token)}&q=${encodeURIComponent(referenceCode)}&v=3`);
    if (statement.includes('<FlexQueryResponse')) return statement;
    if (readTagText(statement, 'ErrorCode') !== IN_PROGRESS_CODE) throw new Error(describeFlexError(statement));
    await sleep(POLL_INTERVAL_MS);
  }
  throw new Error('IBKR Flex statement was not ready in time');
};
