import type { Currency, IsoDate } from '@hroshi/schema';

import type { Prisma } from '../generated/prisma/client.ts';

/** One bank statement line, normalised so every provider feeds the same ingestion. */
export type StatementItem = {
  externalId: string;
  accountId: string;
  date: IsoDate;
  /** Signed, in the account currency: negative leaves the account. */
  amount: number;
  /** Signed, in the currency the operation happened in (the card was charged in EUR, the cash came out in EUR). */
  operationAmount: number | null;
  operationCurrency: Currency | null;
  description: string;
  counterparty: string | null;
  counterIban: string | null;
  /** Set by a provider that already knows the other own account (Revolut pockets share one IBAN). */
  counterAccountId?: string;
  mcc: number | null;
  comment: string | null;
  raw: Prisma.InputJsonValue;
};

export const normalizeIban = (iban: string): string => iban.replace(/\s+/g, '').toUpperCase();

/** Local calendar date of a provider timestamp, in the owner's time zone (TZ). */
export const toLocalDate = (moment: Date): IsoDate => moment.toLocaleDateString('en-CA');

export const roundMoney = (value: number): number => Math.round(value * 100) / 100;
