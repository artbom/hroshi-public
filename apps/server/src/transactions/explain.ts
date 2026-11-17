import {
  classifyTransaction,
  convertToEur,
  explainClassification,
  findBankText,
  findPayeeText,
  listBalanceEffects,
  normalizeMerchant,
  suggestRulePattern,
} from '@hroshi/domain';
import { type BankCheck, type BankLine, ESTIMATE_MARKER, type Transaction, type TransactionExplain } from '@hroshi/schema';

import type { Db } from '../db.ts';
import { notFound } from '../http-errors.ts';
import { type Ledger, loadLedger, toTransactionRow } from '../ledger.ts';
import { mapRule } from '../mappers.ts';
import { readBankLine } from './bank-line.ts';

/** Below this two amounts are the same money. */
const AMOUNT_TOLERANCE = 0.005;

const HAND_SOURCES: ReadonlySet<Transaction['source']> = new Set(['claude', 'page']);

const findDelta = (transaction: Transaction, accountId: string) =>
  listBalanceEffects(transaction).find((effect) => effect.accountId === accountId)?.delta ?? 0;

/**
 * The record against the bank's line. Silent while they agree; otherwise it lists what may make up
 * the difference — the other rows booked from the same line (an ATM fee) and hand rows on that
 * account and day without a line of their own — and names the one that does.
 */
const checkAgainstBank = async ({
  db,
  ledger,
  transaction,
  lineId,
  bankLine,
}: {
  db: Db;
  ledger: Ledger;
  transaction: Transaction;
  lineId: string;
  bankLine: BankLine | null;
}): Promise<BankCheck | null> => {
  const accountId = bankLine?.accountId ?? transaction.accountId;
  const account = ledger.accounts.find((candidate) => candidate.id === accountId);
  if (account === undefined) return null;
  const recordAmount = findDelta(transaction, accountId);
  const bankAmount = bankLine?.amount ?? null;
  const baseLineId = lineId.replace(/:fee$/u, '');
  const siblingIds = new Set(
    (
      await db.transaction.findMany({
        where: { OR: [{ externalId: baseLineId }, { externalId: { startsWith: `${baseLineId}:` } }] },
        select: { id: true },
      })
    ).map((row) => row.id),
  );
  const companions = ledger.transactions.filter(
    (candidate) =>
      candidate.id !== transaction.id &&
      (siblingIds.has(candidate.id) ||
        (!candidate.synced &&
          HAND_SOURCES.has(candidate.source) &&
          candidate.date === transaction.date &&
          findDelta(candidate, accountId) !== 0)),
  );
  const agrees = bankAmount !== null && Math.abs(bankAmount - recordAmount) < AMOUNT_TOLERANCE;
  if (agrees) return null;

  const difference = bankAmount === null ? null : bankAmount - recordAmount;
  const opposite = companions.filter((candidate) => Math.sign(findDelta(candidate, accountId)) === -Math.sign(recordAmount));
  const compensating =
    difference === null
      ? opposite.length === 1
        ? opposite[0]
        : undefined
      : companions.find((candidate) => Math.abs(findDelta(candidate, accountId) - difference) < AMOUNT_TOLERANCE);
  return {
    accountId,
    currency: account.currency,
    bankAmount,
    recordAmount,
    companions: companions.map((candidate) => toTransactionRow(ledger, candidate)),
    compensatedById: compensating?.id ?? null,
  };
};

/** Everything behind one row: the bank's own line, why it is booked this way, the rate, its siblings. */
export const explainTransaction = async ({ db, id }: { db: Db; id: string }): Promise<TransactionExplain> => {
  const [row, rules, ledger] = await Promise.all([
    db.transaction.findUnique({ where: { id } }),
    db.rule.findMany(),
    loadLedger(db),
  ]);
  const transaction = [...ledger.transactions, ...ledger.splitParents].find((candidate) => candidate.id === id);
  if (row === null || transaction === undefined) throw notFound(`Transaction "${id}" not found`);

  const accounts = new Map(ledger.accounts.map((account) => [account.id, account]));
  const toRef = (accountId: string | null) => {
    const account = accountId === null ? undefined : accounts.get(accountId);
    return account === undefined ? null : { id: account.id, name: account.name, currency: account.currency, kind: account.kind };
  };
  const account = toRef(transaction.accountId);
  if (account === null) throw notFound(`Account "${transaction.accountId}" not found`);

  // A part has no line of its own: the bank's line stays on the row it was split from.
  const lineRow = row.splitOfId === null ? row : ((await db.transaction.findUnique({ where: { id: row.splitOfId } })) ?? row);
  const bankLine = readBankLine({ raw: lineRow.raw, transaction, accounts });
  const classified = explainClassification({
    transaction,
    rules: rules.map(mapRule),
    policies: ledger.policies,
    mcc: bankLine?.mcc ?? null,
    texts: [transaction.note, bankLine?.description ?? null, bankLine?.counterparty ?? null, bankLine?.comment ?? null],
    toLineId: lineRow.toExternalId,
  });
  // A part's category is the owner's choice in the split, whatever a rule would say about the line.
  const classification = transaction.splitOfId === null ? classified : { ...classified, verdict: 'manual' as const, overridden: false };
  const splitParentId = transaction.splitOfId ?? (ledger.splitParents.includes(transaction) ? transaction.id : null);
  const splitParent = splitParentId === null ? undefined : ledger.splitParents.find((candidate) => candidate.id === splitParentId);
  const parts = splitParentId === null ? [] : ledger.transactions.filter((candidate) => candidate.splitOfId === splitParentId);
  const chainId = ledger.chains.get(id) ?? splitParentId ?? undefined;
  const members = chainId === undefined ? [] : ledger.transactions.filter((candidate) => ledger.chains.get(candidate.id) === chainId);
  const chain =
    members.length < 2
      ? null
      : {
          kind: members.every((member) => member.splitOfId !== null && member.splitOfId === splitParentId)
            ? ('split' as const)
            : members.every((member) => member.type === 'transfer')
              ? ('sale' as const)
              : members.some((member) => /розстрочка на картку/iu.test(member.bankText ?? member.note ?? ''))
                ? ('instalment' as const)
                : ('hold' as const),
          netEur: members.reduce((sum, member) => {
            const effect = classifyTransaction(member, ledger.policies);
            const eur = convertToEur({ transaction: member, fx: ledger.fx }) ?? 0;
            return effect.kind === 'spend' ? sum + effect.sign * eur : sum;
          }, 0),
          rows: members.length,
        };
  const byId = new Map(ledger.transactions.map((candidate) => [candidate.id, candidate]));
  const twinOf = transaction.duplicateOfId === null ? undefined : byId.get(transaction.duplicateOfId);
  const twinBy = ledger.transactions.find((candidate) => candidate.duplicateOfId === id);
  const { toAmount, toCurrency, currency, amount } = transaction;
  const lineId = lineRow.externalId ?? lineRow.toExternalId;

  return {
    transaction: toTransactionRow(ledger, transaction),
    account,
    target: toRef(transaction.toAccountId),
    origin: {
      source: transaction.source,
      linked: lineRow.externalId !== null || lineRow.toExternalId !== null,
      externalId: lineRow.externalId,
      toExternalId: lineRow.toExternalId,
      bankLine,
      estimated: transaction.note?.includes(ESTIMATE_MARKER) === true,
      createdAt: transaction.createdAt,
    },
    classification,
    payee: { ...normalizeMerchant(findPayeeText(transaction)), pattern: suggestRulePattern(findBankText(transaction)) },
    fx: ledger.fx.describeRate(currency, transaction.date),
    transferRate: toCurrency !== null && toCurrency !== currency && toAmount !== null && toAmount > 0 ? toAmount / amount : null,
    related: members.filter((candidate) => candidate.id !== id).map((candidate) => toTransactionRow(ledger, candidate)),
    chain,
    split:
      splitParent === undefined
        ? null
        : { parent: toTransactionRow(ledger, splitParent), parts: parts.map((part) => toTransactionRow(ledger, part)) },
    twin:
      twinOf !== undefined
        ? { relation: 'duplicates', transaction: toTransactionRow(ledger, twinOf) }
        : twinBy !== undefined
          ? { relation: 'duplicatedBy', transaction: toTransactionRow(ledger, twinBy) }
          : null,
    bankCheck:
      lineId === null || transaction.splitOfId !== null
        ? null
        : await checkAgainstBank({ db, ledger, transaction, lineId, bankLine }),
  };
};
