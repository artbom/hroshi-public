import type { Ledger } from '../ledger.ts';

/** Every row as a rule sees it: the owner's note and the bank's own text, the MCC, the account. */
export const listRuleSubjects = (ledger: Pick<Ledger, 'transactions'>) =>
  ledger.transactions.map((transaction) => ({
    id: transaction.id,
    accountId: transaction.accountId,
    mcc: transaction.mcc,
    texts: [transaction.note, transaction.bankText],
    date: transaction.date,
    category: transaction.category,
    needsReview: transaction.needsReview,
  }));
