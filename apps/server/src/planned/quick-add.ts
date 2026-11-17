import { describePayee, findMedian, findPayeeText, shiftDate } from '@hroshi/domain';
import type { Account, IsoDate, QuickAdd, QuickAddPayee, Transaction } from '@hroshi/schema';

const HISTORY_DAYS = 365;
const MAX_PAYEES = 200;
const MAX_TEMPLATES = 6;
/** The typical amount is the median of this many latest payments, so last year's price fades out. */
const RECENT_AMOUNTS = 5;
/** Rows the owner typed in himself and no bank line confirmed later: what a quick add repeats. */
const HAND_SOURCES: ReadonlySet<Transaction['source']> = new Set(['page', 'claude']);
const isHandEntry = (row: Transaction) => HAND_SOURCES.has(row.source) && !row.synced;
const PERSONAL_KINDS: ReadonlySet<Account['kind']> = new Set(['everyday', 'cash', 'credit']);
/** The business accounts only pass client money through; a personal purchase never starts there. */
const BUSINESS_ACCOUNT = /ФОП/u;

const isPersonal = (account: Account) =>
  !account.archived && !account.passThrough && PERSONAL_KINDS.has(account.kind) && !BUSINESS_ACCOUNT.test(account.name);

type Entry = { key: string; name: string; rows: Transaction[] };

const describeEntry = ({ name, rows }: Entry): QuickAddPayee | null => {
  const latest = rows.at(-1);
  if (latest === undefined || latest.category === null) return null;
  const amounts = rows
    .filter((row) => row.currency === latest.currency)
    .slice(-RECENT_AMOUNTS)
    .map((row) => row.amount);
  return {
    name,
    category: latest.category,
    accountId: latest.accountId,
    amount: Math.round(findMedian(amounts) * 100) / 100,
    currency: latest.currency,
    count: rows.length,
    lastDate: latest.date,
  };
};

/** Groups rows (oldest first) by `describeKey`, skipping rows the bank left unnamed. */
const groupRows = ({ rows, describeKey }: { rows: readonly Transaction[]; describeKey: (row: Transaction, payeeKey: string) => string }) => {
  const groups = new Map<string, Entry>();
  for (const row of rows) {
    const payee = describePayee({ text: findPayeeText(row), category: row.category ?? '' });
    if (payee.unnamed) continue;
    const key = describeKey(row, payee.key);
    const group = groups.get(key) ?? { key, name: payee.name, rows: [] };
    group.rows.push(row);
    groups.set(key, group);
  }
  return [...groups.values()];
};

/**
 * What «Новий запис» starts from: the account and category of the latest hand entry on a
 * personal account, the payees seen in the last year for autocomplete, and the latest distinct
 * hand entries to repeat in one tap.
 */
export const describeQuickAdd = ({
  accounts,
  transactions,
  today,
}: {
  accounts: readonly Account[];
  transactions: readonly Transaction[];
  today: IsoDate;
}): QuickAdd => {
  const personal = new Set(accounts.filter(isPersonal).map((account) => account.id));
  const since = shiftDate(today, -HISTORY_DAYS);
  const expenses = transactions.filter(
    (row) => row.type === 'expense' && row.category !== null && row.splitOfId === null && row.date >= since && row.date <= today,
  );
  const handEntries = expenses.filter((row) => isHandEntry(row) && personal.has(row.accountId));
  const latest = handEntries.at(-1) ?? expenses.findLast((row) => personal.has(row.accountId));

  const payees = groupRows({ rows: expenses, describeKey: (_row, payeeKey) => payeeKey })
    .toSorted((left, right) => right.rows.length - left.rows.length)
    .slice(0, MAX_PAYEES)
    .flatMap((entry) => describeEntry(entry) ?? []);
  const templates = groupRows({
    rows: handEntries,
    describeKey: (row, payeeKey) => `${payeeKey}|${row.category ?? ''}|${row.accountId}`,
  })
    .toSorted((left, right) => (right.rows.at(-1)?.date ?? '').localeCompare(left.rows.at(-1)?.date ?? ''))
    .slice(0, MAX_TEMPLATES)
    .flatMap((entry) => describeEntry(entry) ?? []);

  return { accountId: latest?.accountId ?? null, category: latest?.category ?? null, payees, templates };
};
