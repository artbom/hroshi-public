import { ESTIMATE_MARKER, type Transaction, type TransactionRow } from '@hroshi/schema';
import { type ReactNode, useEffect, useState } from 'react';

import { useDrawer } from '../components/DrawerContext.tsx';
import { AccountIdMark, SourceMark } from '../components/SourceMark.tsx';
import { formatEurApprox, formatExchangeRate, formatMoney, formatMoneyWhole, keepTogether, pluralize } from '../format.ts';

/** How long the "Видалити?" confirmation stays armed. */
const CONFIRM_MS = 3000;

export const DeleteButton = ({
  onConfirm,
  disabled,
  label = 'Видалити',
}: {
  onConfirm: () => void;
  disabled: boolean;
  label?: string;
}) => {
  const [armed, setArmed] = useState(false);

  useEffect(() => {
    if (!armed) return undefined;
    const timer = window.setTimeout(() => setArmed(false), CONFIRM_MS);
    return () => window.clearTimeout(timer);
  }, [armed]);

  return (
    <button
      type="button"
      className={armed ? 'btn small del confirm' : 'btn small del'}
      disabled={disabled}
      onClick={() => (armed ? onConfirm() : setArmed(true))}
    >
      {armed ? 'Точно видалити?' : label}
    </button>
  );
};

/** A row as any list hands it over; only lists built from the ledger know its euro value. */
type LineTransaction = Transaction & Partial<Pick<TransactionRow, 'eur'>>;

/** «→ 2 727 грн · 45,45 грн/$»: what arrived, and the rate it implies. */
const describeArrival = ({
  amount,
  currency,
  toAmount,
  toCurrency,
}: {
  amount: number;
  currency: string;
  toAmount: number;
  toCurrency: string;
}) => `→ ${formatMoneyWhole(toAmount, toCurrency)} · ${formatExchangeRate({ amount, currency, toAmount, toCurrency })}`;

/** The euro figure under a foreign-currency amount, so every line can be compared at a glance. */
const describeEur = ({ eur, currency }: { eur: number | null | undefined; currency: string }) =>
  currency === 'EUR' || eur === null || eur === undefined ? null : `≈\u00a0${formatEurApprox(Math.abs(eur))}`;

/** A transfer the bank left without words: its accounts already say where the money went. */
export const UNNAMED_TRANSFER = 'Переказ між своїми рахунками';

/** Spending and income carry the money colours; transfers and market moves get their own, quieter ones, since neither is spending. */
export type AmountTone = '' | 'neg' | 'pos' | 'xfer' | 'val';

type LineParts = {
  title: string;
  detail: ReactNode;
  amount: string;
  /** A second, smaller line under the amount: the credited side of an exchange, or the euros. */
  sub: string | null;
  tone: AmountTone;
};

const TYPE_CHIPS: Readonly<Record<'transfer' | 'valuation', { label: string; tone: AmountTone }>> = {
  transfer: { label: 'переказ', tone: 'xfer' },
  valuation: { label: 'переоцінка', tone: 'val' },
};

export const TypeChip = ({ type }: { type: keyof typeof TYPE_CHIPS }) => (
  <span className={`chip ${TYPE_CHIPS[type].tone}`}>{TYPE_CHIPS[type].label}</span>
);

export const findAmountTone = (row: Pick<Transaction, 'type'>): AmountTone =>
  row.type === 'expense' ? 'neg' : row.type === 'income' ? 'pos' : TYPE_CHIPS[row.type].tone;

export const describeLine = ({
  transaction,
  accountNames,
}: {
  transaction: LineTransaction;
  accountNames: ReadonlyMap<string, string>;
}): LineParts => {
  const account = accountNames.get(transaction.accountId) ?? transaction.accountId;
  const money = formatMoney(Math.abs(transaction.amount), transaction.currency);
  const sub = describeEur({ eur: transaction.eur, currency: transaction.currency });

  switch (transaction.type) {
    case 'expense':
      return {
        title: keepTogether(transaction.note || transaction.category || ''),
        detail: `${transaction.category ?? 'Інше'} · ${account}`,
        amount: `−${money}`,
        sub,
        tone: 'neg',
      };
    case 'income':
      return {
        title: keepTogether(transaction.note || transaction.category || ''),
        detail: `${transaction.category ?? 'Дохід'} · ${account}`,
        amount: `+${money}`,
        sub,
        tone: 'pos',
      };
    case 'valuation':
      return {
        title: keepTogether(transaction.note || 'Переоцінка портфеля'),
        detail: (
          <>
            <TypeChip type="valuation" /> {account}
          </>
        ),
        amount: `${transaction.amount < 0 ? '−' : '+'}${money}`,
        sub,
        tone: 'val',
      };
    case 'transfer': {
      const target =
        transaction.toAccountId === null ? '?' : (accountNames.get(transaction.toAccountId) ?? transaction.toAccountId);
      const { toAmount, toCurrency, currency, amount } = transaction;
      const exchanged = toCurrency !== null && toCurrency !== currency && toAmount !== null && toAmount > 0;
      return {
        title: keepTogether(transaction.note || UNNAMED_TRANSFER),
        detail: (
          <>
            <TypeChip type="transfer" /> {account} → {target}
          </>
        ),
        amount: money,
        sub: exchanged ? describeArrival({ amount, currency, toAmount, toCurrency }) : sub,
        tone: 'xfer',
      };
    }
  }
};

/** Amount on top, the smaller second line under it, both flush right. */
export const AmountBlock = ({ amount, sub, tone }: Pick<LineParts, 'amount' | 'sub' | 'tone'>) => (
  <span className="amt">
    <span className={`num ${tone}`.trim()}>{amount}</span>
    {sub !== null && <span className="amt-sub num">{sub}</span>}
  </span>
);

export const isEstimated = (transaction: Pick<Transaction, 'note' | 'synced'>) =>
  !transaction.synced && transaction.note?.includes(ESTIMATE_MARKER) === true;

/** A hand-kept origin is worth a chip only when the bank never confirmed the row. */
const ORIGIN_CHIPS: Readonly<Partial<Record<Transaction['source'], string>>> = {
  page: 'вручну',
};

const OriginChip = ({ source, label }: { source: Transaction['source']; label: string }) => (
  <span className="chip muted marked">
    <SourceMark source={source} size="sm" />
    {label}
  </span>
);

/**
 * Chips mark exceptions only; an ordinary bank row carries none. A ZenMoney import counts as one
 * only on a bank-synced account after its statement starts (`bankSince`): before that it is simply
 * the history, and lists that do not know the date leave it out.
 */
export const SourceChips = ({
  transaction,
  bankSince,
}: {
  transaction: Transaction;
  bankSince?: Readonly<Record<string, string>> | undefined;
}) => {
  const since = bankSince?.[transaction.accountId];
  const origin = transaction.synced
    ? undefined
    : transaction.source === 'zenmoney'
      ? since !== undefined && transaction.date >= since
        ? 'ZenMoney'
        : undefined
      : ORIGIN_CHIPS[transaction.source];
  return (
    <>
      {/* Rows Claude entered are many and ordinary: a quiet mark, the drawer's «Звідки запис» says the rest. */}
      {!transaction.synced && transaction.source === 'claude' && (
        <SourceMark source="claude" size="sm" title="Внесено через Claude — подробиці в «Звідки запис»" label />
      )}
      {origin !== undefined && <OriginChip source={transaction.source} label={origin} />}{' '}
      {transaction.splitOfId !== null && <span className="chip muted">частина</span>}{' '}
      {isEstimated(transaction) && <span className="chip warn">орієнтовно</span>}{' '}
      {transaction.bankAmount !== null && (
        <span className="chip warn" title={`У банку ${formatMoney(transaction.bankAmount, transaction.currency)}`}>
          змінено проти банку
        </span>
      )}{' '}
      {transaction.needsReview && <span className="chip warn">уточнити</span>}
    </>
  );
};

/** One row; the whole line opens «Чому так?». */
export const TransactionLine = ({
  transaction,
  accountNames,
}: {
  transaction: LineTransaction;
  accountNames: ReadonlyMap<string, string>;
}) => {
  const { openTransaction } = useDrawer();
  const { title, detail, amount, sub, tone } = describeLine({ transaction, accountNames });
  return (
    <button type="button" className="tx open has-mark" onClick={() => openTransaction(transaction.id)}>
      <AccountIdMark accountId={transaction.accountId} size="lg" />
      <div className="what">
        <div className="t">
          {/* The first mark travels with the title's last word; alone on a line it reads as noise. */}
          {title}
          {'\u00a0'}
          <SourceChips transaction={transaction} />
        </div>
        <div className="s">{detail}</div>
      </div>
      <AmountBlock amount={amount} sub={sub} tone={tone} />
    </button>
  );
};

const SIGN_BY_TYPE: Readonly<Record<Transaction['type'], number>> = { expense: -1, income: 1, transfer: 0, valuation: 1 };

const signedSum = (rows: readonly TransactionRow[], pick: (row: TransactionRow) => number) =>
  Math.round(rows.reduce((sum, row) => sum + SIGN_BY_TYPE[row.type] * pick(row), 0) * 100) / 100;

const formatSigned = (value: number, currency: string) =>
  `${value < 0 ? '−' : value > 0 ? '+' : ''}${formatMoney(Math.abs(value), currency)}`;

export type ChainKind = 'sale' | 'split' | 'instalment' | 'hold';

/** What kind of money move a group of rows is; the same reading the drawer explains. */
export const findChainKind = (rows: readonly TransactionRow[]): ChainKind => {
  const [first] = rows;
  if (first !== undefined && first.splitOfId !== null && rows.every((row) => row.splitOfId === first.splitOfId)) return 'split';
  if (rows.every((row) => row.type === 'transfer')) return 'sale';
  return rows.some((row) => /розстрочка на картку/iu.test(row.bankText ?? row.note ?? '')) ? 'instalment' : 'hold';
};

const CHAIN_LABELS: Readonly<Record<ChainKind, string>> = {
  sale: 'продаж валюти',
  split: 'розділено',
  instalment: 'покупка в розстрочку',
  hold: 'холд і скасування',
};

/** The headline of a money move made of several rows: a ФОП sale end to end, a hold net of its release, a split line. */
export const describeChain = ({
  rows,
  accountNames,
}: {
  rows: readonly TransactionRow[];
  accountNames: ReadonlyMap<string, string>;
}): LineParts => {
  const [first] = rows;
  const last = rows.at(-1);
  const kind = findChainKind(rows);
  if (kind === 'sale' && first !== undefined && last !== undefined) {
    const to = last.toAccountId === null ? '?' : (accountNames.get(last.toAccountId) ?? last.toAccountId);
    return {
      title: `Продаж ${first.currency} з ${accountNames.get(first.accountId) ?? first.accountId} → ${to}`,
      detail: (
        <>
          <TypeChip type="transfer" /> через {accountNames.get(first.toAccountId ?? '') ?? 'транзитний рахунок'}
        </>
      ),
      amount: formatMoney(first.amount, first.currency),
      sub: describeArrival({ amount: first.amount, currency: first.currency, toAmount: last.amount, toCurrency: last.currency }),
      tone: 'xfer',
    };
  }
  const net = signedSum(rows, (row) => row.amount);
  const netEur = signedSum(rows, (row) => row.eur ?? 0);
  const currency = first?.currency ?? 'EUR';
  const lead = rows.find((row) => row.type === 'expense') ?? first;
  const categories = [...new Set(rows.map((row) => row.category ?? 'Інше'))];
  const what = kind === 'split' ? categories.join(', ') : (lead?.category ?? 'Інше');
  return {
    title: keepTogether(lead?.note ?? CHAIN_LABELS[kind]),
    detail: `${what} · ${CHAIN_LABELS[kind]} · ${pluralize(rows.length, kind === 'split' ? ['частина', 'частини', 'частин'] : ['запис', 'записи', 'записів'])}`,
    amount: formatSigned(net, currency),
    // A hold fully released nets to zero; a «≈ 0,00 €» line under it would only add noise.
    sub: net === 0 ? null : describeEur({ eur: netEur, currency }),
    tone: net < 0 ? 'neg' : net > 0 ? 'pos' : '',
  };
};

export const ChainLine = ({
  rows,
  accountNames,
}: {
  rows: readonly TransactionRow[];
  accountNames: ReadonlyMap<string, string>;
}) => {
  const { title, detail, amount, sub, tone } = describeChain({ rows, accountNames });
  return (
    <details className="chain">
      <summary className="tx open has-mark" aria-label={`${title}, ${amount}: показати ${pluralize(rows.length, ['запис', 'записи', 'записів'])}`}>
        <AccountIdMark accountId={rows[0]?.accountId ?? ''} size="lg" />
        <div className="what">
          <div className="t">
            {title}
            {'\u00a0'}
            <span className="chip muted" aria-hidden="true">
              {rows.length} ▾
            </span>
          </div>
          <div className="s">{detail}</div>
        </div>
        <AmountBlock amount={amount} sub={sub} tone={tone} />
      </summary>
      <div className="chain-members">
        {rows.map((row) => (
          <TransactionLine key={row.id} transaction={row} accountNames={accountNames} />
        ))}
      </div>
    </details>
  );
};

export type Entry = { kind: 'row'; row: TransactionRow } | { kind: 'chain'; rows: TransactionRow[] };

/**
 * Rows of one money move shown as one line, placed where its newest row is; a chain with
 * only one row on screen stays a plain row.
 */
export type PlacedEntry = { date: string; entry: Entry };

export const groupChains = (rows: readonly TransactionRow[]): PlacedEntry[] => {
  const chains = Map.groupBy(
    rows.filter((row) => row.chainId !== null),
    (row) => row.chainId ?? '',
  );
  const placed = new Set<string>();
  return rows.flatMap((row): PlacedEntry[] => {
    const members = row.chainId === null ? undefined : chains.get(row.chainId);
    if (members === undefined || members.length < 2) return [{ date: row.date, entry: { kind: 'row', row } }];
    if (row.chainId === null || placed.has(row.chainId)) return [];
    placed.add(row.chainId);
    // The chain id is its first leg's id: the sale before the onward transfer, the hold before its release.
    const ordered = members.toSorted(
      (left, right) =>
        Number(right.id === row.chainId) - Number(left.id === row.chainId) ||
        left.date.localeCompare(right.date) ||
        left.createdAt.localeCompare(right.createdAt),
    );
    return [{ date: ordered.at(-1)?.date ?? row.date, entry: { kind: 'chain', rows: ordered } }];
  });
};

export const TransactionEntry = ({ entry, accountNames }: { entry: Entry; accountNames: ReadonlyMap<string, string> }) =>
  entry.kind === 'row' ? (
    <TransactionLine transaction={entry.row} accountNames={accountNames} />
  ) : (
    <ChainLine rows={entry.rows} accountNames={accountNames} />
  );

export const findEntryKey = (entry: Entry) => (entry.kind === 'row' ? entry.row.id : (entry.rows[0]?.id ?? ''));

export const TransactionEntries = ({
  rows,
  accountNames,
}: {
  rows: readonly TransactionRow[];
  accountNames: ReadonlyMap<string, string>;
}) => (
  <>
    {groupChains(rows).map(({ entry }) => (
      <TransactionEntry key={findEntryKey(entry)} entry={entry} accountNames={accountNames} />
    ))}
  </>
);
