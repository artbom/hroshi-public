import { randomUUID } from 'node:crypto';

import { shiftDate } from '@hroshi/domain';
import { CurrencySchema } from '@hroshi/schema';
import { z } from 'zod';

import { findToday } from '../../clock.ts';
import type { Db } from '../../db.ts';
import { env } from '../../env.ts';
import { badRequest } from '../../http-errors.ts';
import { fromIsoDate } from '../../mappers.ts';
import { createEnableBankingClient, type SessionSchema } from './client.ts';

/** PSD2 caps consent at 180 days for most banks; a day of margin avoids an edge-of-expiry failure. */
const CONSENT_SECONDS = 179 * 24 * 3600;
/** The account the handover already tracks for Revolut's euro pocket. */
const EUR_ACCOUNT_ID = 'revolut-eur';

const PendingStateSchema = z.object({ pendingState: z.string() });

const requireRedirectUrl = (): string => {
  if (env.ENABLE_BANKING_REDIRECT_URL === undefined) throw new Error('ENABLE_BANKING_REDIRECT_URL is not set');
  return env.ENABLE_BANKING_REDIRECT_URL;
};

/** Asks the bank for consent; the owner finishes it in the browser and lands on the callback. */
export const startRevolutConsent = async (db: Db): Promise<{ url: string }> => {
  const client = await createEnableBankingClient();
  const { aspsps } = await client.listAspsps(env.ENABLE_BANKING_ASPSP_COUNTRY);
  const aspsp = aspsps.find((candidate) => candidate.name === env.ENABLE_BANKING_ASPSP_NAME);
  if (aspsp === undefined) {
    throw badRequest(
      `Enable Banking has no "${env.ENABLE_BANKING_ASPSP_NAME}" in ${env.ENABLE_BANKING_ASPSP_COUNTRY}; run \`pnpm cli eb:aspsps <country>\``,
    );
  }
  const seconds = Math.min(CONSENT_SECONDS, aspsp.maximum_consent_validity ?? CONSENT_SECONDS);
  const state = randomUUID();
  const { url } = await client.startAuthorization({
    access: { valid_until: new Date(Date.now() + seconds * 1000).toISOString() },
    aspsp: { name: aspsp.name, country: aspsp.country },
    state,
    redirect_url: requireRedirectUrl(),
    psu_type: 'personal',
  });
  await db.connection.upsert({
    where: { source: 'revolut' },
    create: { source: 'revolut', state: { pendingState: state } },
    update: { state: { pendingState: state } },
  });
  return { url };
};

/**
 * Revolut pockets become accounts: euros go to the existing Revolut EUR account, any other
 * pocket opens tomorrow at today's balance so lines already inside it never count twice.
 */
const linkRevolutAccounts = async ({ db, session }: { db: Db; session: z.infer<typeof SessionSchema> }) => {
  for (const account of session.accounts) {
    const currency = CurrencySchema.safeParse(account.currency);
    if (!currency.success) continue;
    const id = currency.data === 'EUR' ? EUR_ACCOUNT_ID : `revolut-${currency.data.toLowerCase()}`;
    const iban = account.account_id?.iban ?? null;
    const ibanOwner = iban === null ? null : await db.account.findUnique({ where: { iban } });
    const sync = {
      syncSource: 'revolut' as const,
      syncAccountId: account.uid,
      // Pockets can share one IBAN; only the first keeps it so own-transfer detection stays unambiguous.
      ...(iban !== null && (ibanOwner === null || ibanOwner.id === id) ? { iban } : {}),
    };
    const existing = await db.account.findUnique({ where: { id } });
    if (existing !== null) {
      await db.account.update({ where: { id }, data: sync });
      continue;
    }
    const client = await createEnableBankingClient();
    const { balances } = await client.fetchBalances(account.uid);
    await db.account.create({
      data: {
        id,
        name: `Revolut ${currency.data}`,
        currency: currency.data,
        bank: 'Revolut',
        order: 8,
        openingBalance: balances[0]?.balance_amount.amount ?? 0,
        openingDate: fromIsoDate(shiftDate(findToday(), 1)),
        ...sync,
      },
    });
  }
};

export const completeRevolutConsent = async ({ db, code, state }: { db: Db; code: string; state: string }): Promise<{ validUntil: string }> => {
  const connection = await db.connection.findUnique({ where: { source: 'revolut' } });
  const pending = PendingStateSchema.safeParse(connection?.state);
  if (!pending.success || pending.data.pendingState !== state) throw badRequest('Unknown or expired consent request');

  const client = await createEnableBankingClient();
  const session = await client.createSession(code);
  await linkRevolutAccounts({ db, session });
  const validUntil = new Date(session.access.valid_until);
  await db.connection.update({
    where: { source: 'revolut' },
    data: { sessionId: session.session_id, validUntil, state: { accounts: session.accounts.map((account) => account.uid) } },
  });
  return { validUntil: validUntil.toISOString() };
};
