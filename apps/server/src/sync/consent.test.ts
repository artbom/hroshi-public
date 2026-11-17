import { describe, expect, it } from 'vitest';

import { describeConsentReminder } from './consent-reminder.ts';
import type { BankTransaction } from './enable-banking/client.ts';
import { mapTransaction } from './enable-banking/lines.ts';
import { parseConsentRedirect } from './enable-banking/redirect.ts';
import { describeMonoFailure } from './mono/client.ts';

const HOUR_MS = 3_600_000;
const validUntil = new Date('2027-05-09T02:13:00Z');
/** The reminder cron runs every morning at the same time. */
const morningsBefore = (days: number) => new Date(validUntil.getTime() - days * 24 * HOUR_MS + 4 * HOUR_MS);

describe('describeConsentReminder', () => {
  const remind = (now: Date) => describeConsentReminder({ bank: 'Revolut', validUntil, now });

  it('reminds two weeks, a week, three days and a day before, and once on the day it ends', () => {
    const reminded = Array.from({ length: 20 }, (_, index) => 16 - index).filter((days) => remind(morningsBefore(days)) !== null);
    expect(reminded).toEqual([14, 7, 3, 1, 0]);
  });

  it('says how much is left, and that the consent has ended on its last morning', () => {
    expect(remind(morningsBefore(3))).toContain('через 3 дні');
    expect(remind(morningsBefore(1))).toContain('через 1 день');
    expect(remind(morningsBefore(0))).toContain('закінчилась');
  });

  it('reminds once the morning after a consent the bank closed early, not every day', () => {
    const closed = new Date('2026-12-02T05:20:00Z');
    expect(describeConsentReminder({ bank: 'Revolut', validUntil: closed, now: new Date('2026-12-03T07:15:00Z') })).toBeNull();
    expect(describeConsentReminder({ bank: 'Revolut', validUntil: closed, now: new Date('2026-12-02T07:15:00Z') })).toContain('закінчилась');
  });
});

describe('mapTransaction', () => {
  const transaction: BankTransaction = {
    entry_reference: 'ref-1',
    transaction_amount: { amount: 12.5, currency: 'EUR' },
    credit_debit_indicator: 'DBIT',
    status: 'BOOK',
    booking_date: '2026-11-12',
    creditor: { name: 'Mercadona' },
  };

  it('keys the line on the ledger account, so a renewed consent with new bank uids finds the same rows', () => {
    expect(mapTransaction({ transaction, accountId: 'revolut-eur' })?.externalId).toBe('revolut-eur:ref-1');
  });
});

describe('parseConsentRedirect', () => {
  it('takes the code and state from the address the bank redirected to', () => {
    expect(parseConsentRedirect(' https://localhost/?state=s-1&code=c-1 ')).toEqual({ code: 'c-1', state: 's-1' });
  });

  it('ignores anything else', () => {
    expect(parseConsentRedirect('заплатив 20 € за каву')).toBeUndefined();
    expect(parseConsentRedirect('https://localhost/?error=access_denied&state=s-1')).toBeUndefined();
  });
});

describe('describeMonoFailure', () => {
  it('asks for a new token when Monobank itself refuses it', () => {
    expect(describeMonoFailure({ path: '/personal/client-info', status: 403, body: '{"errorDescription":"Unknown \'X-Token\'"}' })).toContain(
      'new one at api.monobank.ua',
    );
  });

  it('waits out the CDN blocking the IP', () => {
    expect(describeMonoFailure({ path: '/personal/client-info', status: 403, body: '<html><body>glory to Ukraine!</body></html>' })).toContain(
      'blocking this IP',
    );
  });
});
