import type { Account, Category, IsoDate, Rule, Transaction } from '@hroshi/schema';

import type {
  Account as AccountRow,
  Category as CategoryRow,
  Prisma,
  Rule as RuleRow,
  Transaction as TransactionRow,
} from './generated/prisma/client.ts';

type Decimal = Prisma.Decimal;

export const toNumber = (value: Decimal): number => value.toNumber();

export const toNullableNumber = (value: Decimal | null): number | null => (value === null ? null : value.toNumber());

export const toIsoDate = (value: Date): IsoDate => value.toISOString().slice(0, 10);

/** Postgres `date` columns round-trip through UTC midnight. */
export const fromIsoDate = (value: IsoDate): Date => new Date(`${value}T00:00:00Z`);

export const mapAccount = (row: AccountRow): Account => ({
  id: row.id,
  name: row.name,
  currency: row.currency,
  kind: row.kind,
  bank: row.bank,
  openingBalance: toNumber(row.openingBalance),
  openingDate: toIsoDate(row.openingDate),
  creditLimit: toNullableNumber(row.creditLimit),
  order: row.order,
  note: row.note,
  archived: row.archived,
  passThrough: row.passThrough,
  syncSource: row.syncSource,
  counterparty: row.counterparty,
  dueDate: row.dueDate === null ? null : toIsoDate(row.dueDate),
});

const EUR_ISO_CODE = 978;

const readField = (raw: unknown, key: string): unknown =>
  typeof raw === 'object' && raw !== null && !Array.isArray(raw) && Object.hasOwn(raw, key) ? Reflect.get(raw, key) : undefined;

const readText = (raw: unknown, key: string): string | null => {
  const value = readField(raw, key);
  return typeof value === 'string' && value.trim() !== '' ? value.trim() : null;
};

/** Below this two amounts are the same money: float noise, never a cent. */
const AMOUNT_TOLERANCE = 0.005;

/**
 * The line's own amount when the row departs from it: someone changed what the bank booked.
 * A cash withdrawal books the cash and the fee as two rows of one line (the fee's id ends in
 * «:fee», the cash equals the operation amount), so neither of them departs from it.
 */
const readBankAmount = (row: TransactionRow): number | null => {
  if ((row.type !== 'expense' && row.type !== 'income') || row.externalId?.endsWith(':fee') === true) return null;
  const { raw } = row;
  const mono = readField(raw, 'time') === undefined ? undefined : readField(raw, 'amount');
  const line =
    typeof mono === 'number' ? Math.abs(mono) / 100 : Math.abs(Number(readField(readField(raw, 'transaction_amount'), 'amount')));
  if (!Number.isFinite(line) || line === 0) return null;
  const amount = row.amount.toNumber();
  const operation = Number(readField(raw, 'operationAmount'));
  const agrees = (value: number) => Math.abs(value - amount) < AMOUNT_TOLERANCE;
  return agrees(line) || (Number.isFinite(operation) && agrees(Math.abs(operation) / 100)) ? null : line;
};

/**
 * What the stored bank line says beyond the row itself: the payee as the bank names it
 * (Mono description, Enable Banking counterparty), and the euros a hryvnia card was charged.
 */
const readBankFacts = (row: TransactionRow): Pick<Transaction, 'bankText' | 'operationEur' | 'mcc' | 'bankAmount'> => {
  const { raw } = row;
  const party = readField(raw, row.type === 'income' ? 'debtor' : 'creditor');
  const remittance = readField(raw, 'remittance_information');
  const bankText =
    readText(raw, 'description') ??
    readText(party, 'name') ??
    (Array.isArray(remittance) && typeof remittance[0] === 'string' ? remittance[0] : null);
  const code = readField(raw, 'currencyCode');
  const operation = readField(raw, 'operationAmount');
  const spends = row.type === 'expense' || row.type === 'income';
  const operationEur =
    spends && row.currency !== 'EUR' && code === EUR_ISO_CODE && typeof operation === 'number' && operation !== 0
      ? Math.abs(operation) / 100
      : null;
  const mcc = Number(readField(raw, 'mcc') ?? readField(raw, 'merchant_category_code'));
  return { bankText, operationEur, mcc: Number.isInteger(mcc) && mcc > 0 ? mcc : null, bankAmount: readBankAmount(row) };
};

export const mapTransaction = (row: TransactionRow): Transaction => ({
  id: row.id,
  type: row.type,
  date: toIsoDate(row.date),
  accountId: row.accountId,
  amount: toNumber(row.amount),
  currency: row.currency,
  toAccountId: row.toAccountId,
  toAmount: toNullableNumber(row.toAmount),
  toCurrency: row.toCurrency,
  category: row.category,
  note: row.note,
  tags: row.tags,
  source: row.source,
  needsReview: row.needsReview,
  reviewReason: row.reviewReason,
  duplicateOfId: row.duplicateOfId,
  splitOfId: row.splitOfId,
  synced: row.externalId !== null || row.toExternalId !== null,
  createdAt: row.createdAt.toISOString(),
  ...readBankFacts(row),
});

export const mapCategory = (row: CategoryRow): Category => ({
  name: row.name,
  forExpense: row.forExpense,
  forIncome: row.forIncome,
  incomeRole: row.incomeRole,
  countsAsSpending: row.countsAsSpending,
  monthlyLimitEur: toNullableNumber(row.monthlyLimitEur),
  order: row.order,
  archived: row.archived,
  parent: row.parent,
});

export const mapRule = (row: RuleRow): Rule => ({
  id: row.id,
  pattern: row.pattern,
  mcc: row.mcc,
  accountId: row.accountId,
  category: row.category,
  transferToAccountId: row.transferToAccountId,
  priority: row.priority,
  note: row.note,
});
