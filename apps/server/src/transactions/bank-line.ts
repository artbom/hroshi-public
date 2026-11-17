import { describeMcc } from '@hroshi/domain';
import type { Account, BankLine, Transaction } from '@hroshi/schema';
import { z } from 'zod';

/** ISO 4217 numeric codes Monobank uses for the operation currency. */
const CURRENCY_BY_NUMERIC_CODE: Readonly<Record<number, string>> = {
  36: 'AUD',
  124: 'CAD',
  156: 'CNY',
  191: 'HRK',
  203: 'CZK',
  208: 'DKK',
  348: 'HUF',
  376: 'ILS',
  392: 'JPY',
  578: 'NOK',
  643: 'RUB',
  752: 'SEK',
  756: 'CHF',
  764: 'THB',
  784: 'AED',
  826: 'GBP',
  840: 'USD',
  933: 'BYN',
  941: 'RSD',
  946: 'RON',
  949: 'TRY',
  975: 'BGN',
  978: 'EUR',
  980: 'UAH',
  981: 'GEL',
  985: 'PLN',
};

/** Stored payloads are older or newer than today's parser, so every field is optional here. */
const MonoLineSchema = z.object({
  time: z.number(),
  description: z.string().optional(),
  mcc: z.number().int().optional(),
  amount: z.number(),
  operationAmount: z.number().optional(),
  currencyCode: z.number().int().optional(),
  balance: z.number().optional(),
  hold: z.boolean().optional(),
  comment: z.string().optional(),
  counterName: z.string().optional(),
  counterIban: z.string().optional(),
});

const PartySchema = z.object({ name: z.string().nullish() }).nullish();

const EnableBankingLineSchema = z.object({
  credit_debit_indicator: z.enum(['CRDT', 'DBIT']),
  transaction_amount: z.object({ amount: z.coerce.number(), currency: z.string() }),
  booking_date: z.string().nullish(),
  value_date: z.string().nullish(),
  creditor: PartySchema,
  debtor: PartySchema,
  creditor_account: z.object({ iban: z.string().nullish() }).nullish(),
  debtor_account: z.object({ iban: z.string().nullish() }).nullish(),
  remittance_information: z.array(z.string()).nullish(),
  merchant_category_code: z.string().nullish(),
});

type LineAccount = Pick<Account, 'id' | 'creditLimit'>;

/**
 * Which account's statement a stored line belongs to. Money arriving (a broker paying out, an
 * own-card top-up) is stored on the transfer it completed, whose `accountId` is the sender.
 */
const findStatementAccountId = (transaction: Pick<Transaction, 'type' | 'accountId' | 'toAccountId'>, incoming: boolean) =>
  transaction.type === 'transfer' && incoming && transaction.toAccountId !== null ? transaction.toAccountId : transaction.accountId;

const toNullable = <TValue>(value: TValue | undefined | null): TValue | null => value ?? null;

export const readBankLine = ({
  raw,
  transaction,
  accounts,
}: {
  raw: unknown;
  transaction: Pick<Transaction, 'type' | 'accountId' | 'toAccountId'>;
  accounts: ReadonlyMap<string, LineAccount>;
}): BankLine | null => {
  const mono = MonoLineSchema.safeParse(raw);
  if (mono.success) {
    const line = mono.data;
    const accountId = findStatementAccountId(transaction, line.amount > 0);
    const creditLimit = accounts.get(accountId)?.creditLimit ?? 0;
    const mcc = toNullable(line.mcc);
    return {
      provider: 'mono',
      accountId,
      description: toNullable(line.description),
      counterparty: toNullable(line.counterName),
      counterIban: toNullable(line.counterIban),
      comment: toNullable(line.comment),
      mcc,
      mccName: describeMcc(mcc),
      amount: line.amount / 100,
      operationAmount: line.operationAmount === undefined ? null : line.operationAmount / 100,
      operationCurrency:
        line.currencyCode === undefined
          ? null
          : (CURRENCY_BY_NUMERIC_CODE[line.currencyCode] ?? String(line.currencyCode)),
      // Mono reports a credit card's balance with the limit included.
      balanceAfter: line.balance === undefined ? null : line.balance / 100 - creditLimit,
      bookedAt: new Date(line.time * 1000).toISOString(),
      hold: toNullable(line.hold),
    };
  }

  const enableBanking = EnableBankingLineSchema.safeParse(raw);
  if (!enableBanking.success) return null;
  const line = enableBanking.data;
  const outgoing = line.credit_debit_indicator === 'DBIT';
  const mcc = Number(line.merchant_category_code);
  const knownMcc = Number.isInteger(mcc) && mcc > 0 ? mcc : null;
  return {
    provider: 'enable-banking',
    accountId: findStatementAccountId(transaction, !outgoing),
    description: toNullable(line.remittance_information?.join(' ')),
    counterparty: toNullable((outgoing ? line.creditor : line.debtor)?.name),
    counterIban: toNullable((outgoing ? line.creditor_account : line.debtor_account)?.iban),
    comment: null,
    mcc: knownMcc,
    mccName: describeMcc(knownMcc),
    amount: (outgoing ? -1 : 1) * Math.abs(line.transaction_amount.amount),
    operationAmount: null,
    operationCurrency: line.transaction_amount.currency,
    balanceAfter: null,
    bookedAt: toNullable(line.booking_date ?? line.value_date),
    hold: null,
  };
};
