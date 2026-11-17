import { computeBalances, roundAmount, shiftDate } from '@hroshi/domain';
import type { AccountKind, Currency } from '@hroshi/schema';

import { findToday } from '../../clock.ts';
import type { Db } from '../../db.ts';
import { loadLedger } from '../../ledger.ts';
import { fromIsoDate } from '../../mappers.ts';
import { describeBalanceMismatch } from '../reconciliation.ts';
import type { MonoAccount } from './client.ts';

export const CURRENCY_BY_ISO_CODE: Readonly<Record<number, Currency>> = {
  980: 'UAH',
  840: 'USD',
  978: 'EUR',
  826: 'GBP',
};

/** Mono account type and ISO currency → tracker account. ФОП UAH is the pass-through for selling FX. */
const ACCOUNT_IDS: Readonly<Record<string, string>> = {
  'fop:980': 'fop-uah',
  'fop:840': 'fop-usd',
  'fop:978': 'fop-eur',
  'white:980': 'mono-uah',
  'platinum:980': 'mono-credit',
  'black:840': 'mono-usd',
  'black:978': 'mono-eur',
  'madeInUkraine:980': 'mono-miu',
};

const NEW_ACCOUNTS: Readonly<Record<string, { name: string; kind: AccountKind; order: number }>> = {
  'mono-miu': { name: 'Mono «Зроблено в Україні» ₴', kind: 'everyday', order: 7 },
};

export const resolveMonoAccountId = (account: Pick<MonoAccount, 'type' | 'currencyCode'>): string | undefined =>
  ACCOUNT_IDS[`${account.type}:${account.currencyCode}`];

/** Mono reports a credit card's balance with the limit included. */
const findOwnBalance = (account: MonoAccount): number => (account.balance - account.creditLimit) / 100;

/**
 * Attaches Mono ids and IBANs to tracker accounts; IBANs are how own-account transfers are recognised.
 * A Mono account the tracker has never seen opens tomorrow at today's bank balance, so lines already
 * inside that balance never count twice.
 */
export const linkMonoAccounts = async ({
  db,
  monoAccounts,
  log,
}: {
  db: Db;
  monoAccounts: readonly MonoAccount[];
  log: (message: string) => void;
}): Promise<Map<MonoAccount['id'], string>> => {
  const linked = new Map<MonoAccount['id'], string>();

  for (const monoAccount of monoAccounts) {
    const id = resolveMonoAccountId(monoAccount);
    const currency = CURRENCY_BY_ISO_CODE[monoAccount.currencyCode];
    if (id === undefined || currency === undefined) {
      log(`skipping Mono account ${monoAccount.type}/${monoAccount.currencyCode}`);
      continue;
    }
    const sync = { iban: monoAccount.iban, syncSource: 'mono' as const, syncAccountId: monoAccount.id };
    const existing = await db.account.findUnique({ where: { id } });
    if (existing !== null) {
      await db.account.update({ where: { id }, data: sync });
    } else {
      const template = NEW_ACCOUNTS[id] ?? { name: id, kind: 'everyday', order: 50 };
      await db.account.create({
        data: {
          id,
          ...template,
          ...sync,
          currency,
          bank: 'Monobank',
          openingBalance: findOwnBalance(monoAccount),
          openingDate: fromIsoDate(shiftDate(findToday(), 1)),
          creditLimit: monoAccount.creditLimit > 0 ? monoAccount.creditLimit / 100 : null,
        },
      });
      log(`created account ${id}`);
    }
    linked.set(monoAccount.id, id);
  }
  return linked;
};

/** Differences between computed and bank balances, as one line each. */
export const reconcileMonoBalances = async ({
  db,
  monoAccounts,
}: {
  db: Db;
  monoAccounts: readonly MonoAccount[];
}): Promise<string[]> => {
  const ledger = await loadLedger(db);
  const balances = computeBalances({ accounts: ledger.accounts, transactions: ledger.transactions });
  const names = new Map(ledger.accounts.map((account) => [account.id, account.name]));

  return monoAccounts.flatMap((monoAccount) => {
    const id = resolveMonoAccountId(monoAccount);
    const computed = id === undefined ? undefined : balances.get(id);
    if (id === undefined || computed === undefined) return [];
    const bank = findOwnBalance(monoAccount);
    const difference = roundAmount(computed - bank);
    return Math.abs(difference) < 0.01
      ? []
      : [describeBalanceMismatch({ name: names.get(id) ?? id, tracker: computed, bank })];
  });
};
