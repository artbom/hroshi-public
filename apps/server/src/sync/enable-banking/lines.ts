import type { Account } from '@hroshi/schema';

import type { StatementItem } from '../statement.ts';
import type { BankTransaction } from './client.ts';

const describeTransaction = (transaction: BankTransaction): string => {
  const party = transaction.credit_debit_indicator === 'DBIT' ? transaction.creditor : transaction.debtor;
  return party?.name ?? transaction.remittance_information?.join(' ') ?? 'Revolut';
};

export const mapTransaction = ({ transaction, accountId }: { transaction: BankTransaction; accountId: string }): StatementItem | undefined => {
  const date = transaction.booking_date ?? transaction.transaction_date ?? transaction.value_date;
  const reference = transaction.entry_reference ?? transaction.transaction_id;
  if (date == null || reference == null) return undefined;
  const outgoing = transaction.credit_debit_indicator === 'DBIT';
  const counterAccount = outgoing ? transaction.creditor_account : transaction.debtor_account;
  const mcc = Number(transaction.merchant_category_code);

  return {
    // entry_reference is unique per account only. The ledger account, not the bank's uid, names it:
    // every new consent reissues the uids, and the history pull after it must find the rows it already brought.
    externalId: `${accountId}:${reference}`,
    accountId,
    date,
    amount: (outgoing ? -1 : 1) * Math.abs(transaction.transaction_amount.amount),
    operationAmount: null,
    operationCurrency: null,
    description: describeTransaction(transaction),
    counterparty: (outgoing ? transaction.creditor : transaction.debtor)?.name ?? null,
    counterIban: counterAccount?.iban ?? null,
    mcc: Number.isInteger(mcc) && mcc > 0 ? mcc : null,
    comment: transaction.remittance_information?.join(' ') ?? null,
    raw: transaction,
  };
};

const EXCHANGE = /^Exchanged to ([A-Z]{3})\b/;

/**
 * A currency exchange shows up as two lines, "Exchanged to EUR" leaving the USD pocket and
 * "Exchanged to EUR" arriving in the EUR pocket. Pairing them makes one transfer between pockets.
 */
export const pairPocketExchanges = ({
  items,
  accounts,
}: {
  items: readonly StatementItem[];
  accounts: readonly Pick<Account, 'id' | 'currency'>[];
}): StatementItem[] => {
  const currencyOf = new Map(accounts.map((account) => [account.id, account.currency]));
  const counters = new Map<string, string>();
  const legs = items.filter((item) => EXCHANGE.test(item.description));

  for (const outgoing of legs.filter((item) => item.amount < 0)) {
    const target = outgoing.description.match(EXCHANGE)?.[1];
    const incoming = legs.find(
      (candidate) =>
        candidate.amount > 0 &&
        candidate.date === outgoing.date &&
        candidate.description === outgoing.description &&
        currencyOf.get(candidate.accountId) === target &&
        !counters.has(candidate.externalId),
    );
    if (incoming === undefined) continue;
    counters.set(outgoing.externalId, incoming.accountId);
    counters.set(incoming.externalId, outgoing.accountId);
  }
  return items.map((item) => {
    const counterAccountId = counters.get(item.externalId);
    return counterAccountId === undefined ? item : { ...item, counterAccountId };
  });
};
