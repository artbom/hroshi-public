import type { SyncSource } from '@hroshi/schema';

import type { Db } from '../db.ts';
import { requireTelegramOwner, sendTelegramMessage } from '../telegram.ts';
import { describeConsentReminder } from './consent-reminder.ts';
import { ConsentExpiredError, ConsentLostError } from './enable-banking/errors.ts';

/** The bot answers this button with a fresh consent link from the bank. */
export const RENEW_REVOLUT = 'revolut:renew';

const SOURCE_NAMES: Readonly<Record<SyncSource, string>> = {
  mono: 'Monobank',
  revolut: 'Revolut',
  binance: 'Binance',
  ibkr: 'IBKR',
  splitwise: 'Splitwise',
};

/** Enable Banking errors quote whole response bodies; the gist fits in a line. */
const MAX_ERROR_LENGTH = 300;

/** On the days the Revolut consent nears its end: a message with the button that renews it. */
export const remindRevolutConsent = async ({ db, now }: { db: Db; now: Date }): Promise<string | null> => {
  const connection = await db.connection.findUnique({ where: { source: 'revolut' } });
  if (connection?.validUntil == null) return null;
  const text = describeConsentReminder({ bank: SOURCE_NAMES.revolut, validUntil: connection.validUntil, now });
  if (text === null) return null;
  await sendTelegramMessage({ ...requireTelegramOwner(), text, button: { text: '🔄 Поновити Revolut', data: RENEW_REVOLUT } });
  return text;
};

/** A sync that broke says so. A consent that ran out or was closed early gets the reminder instead, so it is not repeated daily. */
export const alertSyncFailure = async ({ source, error }: { source: SyncSource; error: unknown }): Promise<void> => {
  if (error instanceof ConsentExpiredError || error instanceof ConsentLostError) return;
  const message = error instanceof Error ? error.message : String(error);
  const gist = message.length > MAX_ERROR_LENGTH ? `${message.slice(0, MAX_ERROR_LENGTH - 1)}…` : message;
  await sendTelegramMessage({ ...requireTelegramOwner(), text: `⚠️ Синк ${SOURCE_NAMES[source]} не вдався: ${gist}` });
};
