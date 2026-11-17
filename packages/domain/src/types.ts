import type { Account, Category, Rule, Transaction } from '@hroshi/schema';

export type LedgerAccount = Pick<Account, 'id' | 'currency' | 'kind' | 'openingBalance' | 'openingDate'>;

export type LedgerTransaction = Pick<
  Transaction,
  | 'type'
  | 'date'
  | 'accountId'
  | 'amount'
  | 'currency'
  | 'toAccountId'
  | 'toAmount'
  | 'toCurrency'
  | 'category'
  | 'note'
> &
  Partial<Pick<Transaction, 'bankText' | 'operationEur' | 'payee'>>;

export type CategoryPolicy = Pick<Category, 'name' | 'incomeRole' | 'countsAsSpending'>;

export type MatchableRule = Pick<
  Rule,
  'id' | 'pattern' | 'mcc' | 'accountId' | 'category' | 'transferToAccountId' | 'priority'
>;
