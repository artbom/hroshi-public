import type { TransactionRow } from '@hroshi/schema';
import { useState } from 'react';

import { useDrawer } from '../components/DrawerContext.tsx';
import { AccountIdMark } from '../components/SourceMark.tsx';
import { formatDecimal, formatDayShort, formatExchangeRate, formatMoney, formatMoneyWhole, formatWhole, pluralize } from '../format.ts';
import {
  AmountBlock,
  describeChain,
  describeLine,
  type Entry,
  findAmountTone,
  findChainKind,
  SourceChips,
  TypeChip,
} from '../transactions/TransactionLine.tsx';

/** A valuation is signed like the market move it records, the same way Огляд shows it. */
const signOf = (row: Pick<TransactionRow, 'type' | 'amount'>) =>
  row.type === 'expense' ? -1 : row.type === 'income' ? 1 : row.type === 'valuation' ? Math.sign(row.amount) : 0;

const toneOf = (sign: number) => (sign < 0 ? 'neg' : sign > 0 ? 'pos' : '');

const AccountName = ({ id, names }: { id: string; names: ReadonlyMap<string, string> }) => (
  <span className="with-mark tight">
    <AccountIdMark accountId={id} size="sm" />
    {names.get(id) ?? id}
  </span>
);

/** The account column: each side of a transfer with its bank's mark. */
const AccountCell = ({ from, to, names }: { from: string | undefined; to: string | null | undefined; names: ReadonlyMap<string, string> }) =>
  from === undefined ? null : (
    <span className="account-cell">
      <AccountName id={from} names={names} />
      {to != null && (
        <>
          {' → '}
          <AccountName id={to} names={names} />
        </>
      )}
    </span>
  );

/** Below ten euros the cents stay, or «−13,02 грн» would read «0» in the € column. */
const CENTS_BELOW_EUR = 10;

const formatEurCell = (eur: number | null, sign: number) => {
  if (eur === null) return '—';
  const size = Math.abs(eur);
  return `${sign < 0 ? '−' : sign > 0 ? '+' : ''}${size < CENTS_BELOW_EUR ? formatDecimal(size, 2) : formatWhole(size)}`;
};

/** «→ 2 727 грн · 45,45 грн/$» under a transfer between currencies, so the column never wraps into three lines. */
const describeExchange = (row: TransactionRow): string | null => {
  const { toAmount, toCurrency, currency, amount } = row;
  if (row.type !== 'transfer' || toCurrency === null || toCurrency === currency || toAmount === null || toAmount <= 0) return null;
  return `→ ${formatMoneyWhole(toAmount, toCurrency)} · ${formatExchangeRate({ amount, currency, toAmount, toCurrency })}`;
};

type SelectionProps = {
  selected: ReadonlySet<string>;
  onToggle: (ids: readonly string[]) => void;
  bankSince: Readonly<Record<string, string>> | undefined;
};

const OperationRow = ({
  row,
  names,
  selected,
  onToggle,
  member = false,
  bankSince,
}: SelectionProps & { row: TransactionRow; names: ReadonlyMap<string, string>; member?: boolean }) => {
  const { openTransaction } = useDrawer();
  const sign = signOf(row);
  const { title } = describeLine({ transaction: row, accountNames: names });
  return (
    <tr className={member ? 'clickable chain-member' : 'clickable'} onClick={() => openTransaction(row.id)}>
      <td className="sel-col" onClick={(event) => event.stopPropagation()}>
        <input type="checkbox" aria-label="Позначити запис" checked={selected.has(row.id)} onChange={() => onToggle([row.id])} />
      </td>
      <td className="num date-col">{formatDayShort(row.date)}</td>
      <td className="desc-col">
        <button type="button" className={row.note ? 'cell-link' : 'cell-link muted'} onClick={() => openTransaction(row.id)}>
          {title || 'Без опису'}
        </button>{' '}
        <SourceChips transaction={row} bankSince={bankSince} />
      </td>
      <td>{row.type === 'expense' || row.type === 'income' ? row.category : <TypeChip type={row.type} />}</td>
      <td>
        <AccountCell from={row.accountId} to={row.toAccountId} names={names} />
      </td>
      <td className="r">
        <AmountBlock
          amount={`${sign < 0 ? '−' : sign > 0 ? '+' : ''}${formatMoney(Math.abs(row.amount), row.currency)}`}
          sub={describeExchange(row)}
          tone={findAmountTone(row)}
        />
      </td>
      <td className={`r num ${row.type === 'transfer' ? 'muted' : findAmountTone(row)}`}>{formatEurCell(row.eur, sign)}</td>
    </tr>
  );
};

/** A money move of several rows as one line that opens to its members. */
const ChainRows = ({
  rows,
  names,
  selected,
  onToggle,
  bankSince,
}: SelectionProps & { rows: readonly TransactionRow[]; names: ReadonlyMap<string, string> }) => {
  const [open, setOpen] = useState(false);
  const { title, detail, amount, sub, tone } = describeChain({ rows, accountNames: names });
  const kind = findChainKind(rows);
  const ids = rows.map((row) => row.id);
  const allSelected = ids.every((id) => selected.has(id));
  const netEur = rows.reduce((sum, row) => sum + signOf(row) * (row.eur ?? 0), 0);
  // A hold fully released nets to zero in its own currency; FX dates must not print a stray «0,31» beside it.
  const netsToZero = Math.round(rows.reduce((sum, row) => sum + signOf(row) * row.amount, 0) * 100) === 0;
  const last = rows.at(-1) ?? rows[0];
  const first = rows[0];
  const count = pluralize(rows.length, kind === 'split' ? ['частина', 'частини', 'частин'] : ['запис', 'записи', 'записів']);
  return (
    <>
      <tr className="clickable chain-row" onClick={() => setOpen(!open)}>
        <td className="sel-col" onClick={(event) => event.stopPropagation()}>
          <input
            type="checkbox"
            aria-label={`Позначити всі ${count}`}
            checked={allSelected}
            onChange={() => onToggle(allSelected ? ids : ids.filter((id) => !selected.has(id)))}
          />
        </td>
        <td className="num date-col">{last === undefined ? '' : formatDayShort(last.date)}</td>
        <td className="desc-col">
          <button
            type="button"
            className="cell-link"
            aria-expanded={open}
            aria-label={`${title}: ${open ? 'згорнути' : 'показати'} ${count}`}
            onClick={(event) => {
              event.stopPropagation();
              setOpen(!open);
            }}
          >
            {title}
          </button>{' '}
          <span className="chip muted" aria-hidden="true">
            {rows.length} {open ? '▴' : '▾'}
          </span>
          <div className="small muted">{detail}</div>
        </td>
        <td>
          {kind === 'sale' ? (
            <TypeChip type="transfer" />
          ) : kind === 'split' ? (
            [...new Set(rows.map((row) => row.category ?? 'Інше'))].join(', ')
          ) : (
            (first?.category ?? '')
          )}
        </td>
        <td>
          <AccountCell from={first?.accountId} to={kind === 'sale' ? last?.toAccountId : null} names={names} />
        </td>
        <td className="r">
          <AmountBlock amount={amount} sub={kind === 'sale' ? sub : null} tone={tone} />
        </td>
        <td className={`r num ${kind === 'sale' ? 'muted' : toneOf(Math.sign(netEur))}`}>
          {kind === 'sale' ? formatWhole(Math.abs(first?.eur ?? 0)) : netsToZero ? '' : formatEurCell(netEur, Math.sign(netEur))}
        </td>
      </tr>
      {open &&
        rows.map((row) => (
          <OperationRow key={row.id} row={row} names={names} selected={selected} onToggle={onToggle} bankSince={bankSince} member />
        ))}
    </>
  );
};

export const OperationEntry = ({
  entry,
  names,
  selected,
  onToggle,
  bankSince,
}: SelectionProps & { entry: Entry; names: ReadonlyMap<string, string> }) =>
  entry.kind === 'row' ? (
    <OperationRow row={entry.row} names={names} selected={selected} onToggle={onToggle} bankSince={bankSince} />
  ) : (
    <ChainRows rows={entry.rows} names={names} selected={selected} onToggle={onToggle} bankSince={bankSince} />
  );
