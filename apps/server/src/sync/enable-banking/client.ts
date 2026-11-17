import { createPrivateKey, type KeyObject } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { resolve } from 'node:path';

import { SignJWT } from 'jose';
import { z } from 'zod';

import { env, REPO_ROOT } from '../../env.ts';
import { ConsentLostError } from './errors.ts';

const API = 'https://api.enablebanking.com';
/** The API rejects tokens that live longer than a day; an hour is plenty for one sync. */
const TOKEN_TTL = '1h';

const AmountSchema = z.object({ amount: z.coerce.number(), currency: z.string() });

const SessionAccountSchema = z.object({
  uid: z.string(),
  account_id: z.object({ iban: z.string().nullish() }).nullish(),
  currency: z.string().nullish(),
  name: z.string().nullish(),
});

export const SessionSchema = z.object({
  session_id: z.string(),
  accounts: z.array(SessionAccountSchema),
  access: z.object({ valid_until: z.string() }),
});

const PartySchema = z.object({ name: z.string().nullish() }).nullish();
const AccountReferenceSchema = z.object({ iban: z.string().nullish() }).nullish();

export const BankTransactionSchema = z.object({
  entry_reference: z.string().nullish(),
  transaction_id: z.string().nullish(),
  transaction_amount: AmountSchema,
  credit_debit_indicator: z.enum(['CRDT', 'DBIT']),
  status: z.string(),
  booking_date: z.string().nullish(),
  value_date: z.string().nullish(),
  transaction_date: z.string().nullish(),
  creditor: PartySchema,
  debtor: PartySchema,
  creditor_account: AccountReferenceSchema,
  debtor_account: AccountReferenceSchema,
  remittance_information: z.array(z.string()).nullish(),
  merchant_category_code: z.string().nullish(),
});
export type BankTransaction = z.infer<typeof BankTransactionSchema>;

const TransactionsPageSchema = z.object({
  transactions: z.array(BankTransactionSchema),
  continuation_key: z.string().nullish(),
});

const BalancesSchema = z.object({
  balances: z.array(z.object({ balance_amount: AmountSchema, balance_type: z.string() })),
});

const AspspsSchema = z.object({
  aspsps: z.array(z.object({ name: z.string(), country: z.string(), maximum_consent_validity: z.number().nullish() })),
});

/** Enable Banking's codes for a session the bank or the owner closed before `valid_until`. */
const CONSENT_LOST = /EXPIRED_SESSION|REVOKED_SESSION|CLOSED_SESSION|ASPSP_PSU_ACTION_REQUIRED/;

const readCredentials = async (): Promise<{ appId: string; key: KeyObject }> => {
  if (env.ENABLE_BANKING_APP_ID === undefined || env.ENABLE_BANKING_KEY_PATH === undefined) {
    throw new Error('ENABLE_BANKING_APP_ID and ENABLE_BANKING_KEY_PATH are not set');
  }
  // createPrivateKey reads both PKCS#1 and PKCS#8 PEM, whichever the control panel produced.
  const keyPath = resolve(REPO_ROOT, env.ENABLE_BANKING_KEY_PATH);
  return { appId: env.ENABLE_BANKING_APP_ID, key: createPrivateKey(await readFile(keyPath)) };
};

export const createEnableBankingClient = async () => {
  const { appId, key } = await readCredentials();
  const token = await new SignJWT({})
    .setProtectedHeader({ typ: 'JWT', alg: 'RS256', kid: appId })
    .setIssuer('enablebanking.com')
    .setAudience('api.enablebanking.com')
    .setIssuedAt()
    .setExpirationTime(TOKEN_TTL)
    .sign(key);

  const request = async <TSchema extends z.ZodType>(
    path: string,
    schema: TSchema,
    init: { method?: 'GET' | 'POST'; body?: unknown } = {},
  ): Promise<z.infer<TSchema>> => {
    const response = await fetch(`${API}${path}`, {
      method: init.method ?? 'GET',
      headers: { Authorization: `Bearer ${token}`, 'Content-Type': 'application/json' },
      ...(init.body === undefined ? {} : { body: JSON.stringify(init.body) }),
    });
    if (!response.ok) {
      const body = await response.text();
      const message = `Enable Banking ${path.split('?')[0]} answered ${response.status}: ${body}`;
      throw CONSENT_LOST.test(body) ? new ConsentLostError(message) : new Error(message);
    }
    return schema.parse(await response.json());
  };

  /** `longest` asks the bank for everything it still has; banks allow that only shortly after consent. */
  const fetchTransactions = async ({
    accountUid,
    dateFrom,
    strategy = 'default',
  }: {
    accountUid: string;
    dateFrom: string;
    strategy?: 'default' | 'longest';
  }) => {
    const transactions: BankTransaction[] = [];
    let continuationKey: string | null | undefined;
    do {
      const query = new URLSearchParams({
        date_from: dateFrom,
        strategy,
        ...(continuationKey ? { continuation_key: continuationKey } : {}),
      });
      const page = await request(`/accounts/${encodeURIComponent(accountUid)}/transactions?${query}`, TransactionsPageSchema);
      transactions.push(...page.transactions);
      continuationKey = page.continuation_key;
    } while (continuationKey);
    return transactions;
  };

  return {
    listAspsps: (country: string) => request(`/aspsps?country=${encodeURIComponent(country)}`, AspspsSchema),
    startAuthorization: (body: {
      access: { valid_until: string };
      aspsp: { name: string; country: string };
      state: string;
      redirect_url: string;
      psu_type: 'personal';
    }) => request('/auth', z.object({ url: z.url() }), { method: 'POST', body }),
    createSession: (code: string) => request('/sessions', SessionSchema, { method: 'POST', body: { code } }),
    fetchBalances: (accountUid: string) => request(`/accounts/${encodeURIComponent(accountUid)}/balances`, BalancesSchema),
    fetchTransactions,
  };
};
