import { setTimeout as sleep } from 'node:timers/promises';

import { z } from 'zod';

const MONO_API = 'https://api.monobank.ua';
/** The personal API allows one request per 60 s per token. */
const REQUEST_SPACING_MS = 61_000;
const MAX_ATTEMPTS = 5;
/** A statement call covers at most 31 days and 1 hour. */
export const MAX_STATEMENT_WINDOW_S = 31 * 24 * 3600;
/** A full page means older lines in the window were cut off. */
const STATEMENT_PAGE_SIZE = 500;

export const MonoAccountSchema = z.object({
  id: z.string(),
  type: z.string(),
  currencyCode: z.number().int(),
  balance: z.number().int(),
  creditLimit: z.number().int(),
  maskedPan: z.array(z.string()),
  iban: z.string(),
});
export type MonoAccount = z.infer<typeof MonoAccountSchema>;

export const MonoStatementItemSchema = z.object({
  id: z.string(),
  time: z.number().int(),
  description: z.string(),
  mcc: z.number().int(),
  originalMcc: z.number().int().optional(),
  amount: z.number().int(),
  operationAmount: z.number().int(),
  currencyCode: z.number().int(),
  commissionRate: z.number().int().optional(),
  cashbackAmount: z.number().int().optional(),
  balance: z.number().int(),
  hold: z.boolean(),
  comment: z.string().optional(),
  receiptId: z.string().optional(),
  counterEdrpou: z.string().optional(),
  counterIban: z.string().optional(),
  counterName: z.string().optional(),
});
export type MonoStatementItem = z.infer<typeof MonoStatementItemSchema>;

const ClientInfoSchema = z.object({ accounts: z.array(MonoAccountSchema) });

/**
 * What a failed call means for the owner. Monobank answers a bad token itself, in JSON; an HTML 403
 * comes from the CDN in front of it, which blocks an IP for about a day and lifts it on its own.
 */
export const describeMonoFailure = ({ path, status, body }: { path: string; status: number; body: string }): string => {
  const fromMonobank = body.trimStart().startsWith('{');
  if (status === 401 || (status === 403 && fromMonobank)) {
    return `Monobank rejected the token (${status}): issue a new one at api.monobank.ua and put it into MONO_TOKEN`;
  }
  if (status === 403) return 'Monobank is blocking this IP for now (403, usually about a day): the next morning sync tries again';
  // The path carries account ids, not the token, so it is safe to report.
  return `Monobank ${path} answered ${status}: ${body.slice(0, 200)}`;
};

export const createMonoClient = ({ token }: { token: string }) => {
  let lastRequestAt = 0;

  const request = async <TSchema extends z.ZodType>(path: string, schema: TSchema): Promise<z.infer<TSchema>> => {
    for (let attempt = 1; attempt <= MAX_ATTEMPTS; attempt += 1) {
      const wait = lastRequestAt + REQUEST_SPACING_MS - Date.now();
      if (lastRequestAt > 0 && wait > 0) await sleep(wait);
      lastRequestAt = Date.now();
      const response = await fetch(`${MONO_API}${path}`, { headers: { 'X-Token': token } });
      if (response.status === 429) continue;
      if (!response.ok) throw new Error(describeMonoFailure({ path, status: response.status, body: await response.text() }));
      return schema.parse(await response.json());
    }
    throw new Error(`Monobank kept rate-limiting ${path}`);
  };

  const fetchStatement = async ({ accountId, from, to }: { accountId: string; from: number; to: number }) => {
    const items: MonoStatementItem[] = [];
    let until = to;
    for (;;) {
      const page = await request(`/personal/statement/${accountId}/${from}/${until}`, z.array(MonoStatementItemSchema));
      items.push(...page);
      if (page.length < STATEMENT_PAGE_SIZE) return items;
      until = Math.min(...page.map((item) => item.time)) - 1;
    }
  };

  return {
    fetchClientInfo: () => request('/personal/client-info', ClientInfoSchema),
    fetchStatement,
  };
};
