import { SourceSchema, TransactionTypeSchema, type TransactionType } from '@hroshi/schema';
import { Fragment, useDeferredValue, useEffect, useState } from 'react';

import { describeError } from '../api.ts';
import { CategorySelect } from '../components/CategorySelect.tsx';
import { MonthPicker } from '../components/MonthPicker.tsx';
import { SOURCE_LABELS } from '../components/SourceMark.tsx';
import { formatAccountName, formatDay, formatEur, formatMonthLong, formatMonthShort, formatSignedEur, pluralize } from '../format.ts';
import { findCurrentMonth, shiftMonth } from '../months.ts';
import { RowsByDay } from '../overview/DayList.tsx';
import { type TransactionFilter, useAccounts, useCategories, useTags, useTransactions, useUpdateTransactions } from '../queries.ts';
import { buildTableHref } from '../route.ts';
import { findEntryKey, groupChains, type PlacedEntry, TransactionLine } from '../transactions/TransactionLine.tsx';
import { OperationEntry } from './OperationRows.tsx';
import { SavedViews } from './SavedViews.tsx';
import { readGroupChains, writeGroupChains } from './storage.ts';

const PAGE_SIZE = 200;

const TYPE_FILTERS: readonly { value: TransactionType; label: string }[] = [
  { value: 'expense', label: 'Витрати' },
  { value: 'income', label: 'Доходи' },
  { value: 'transfer', label: 'Перекази' },
  { value: 'valuation', label: 'Переоцінки' },
];

/** Filters live in the address, so every aggregate can link here and a filtered view can be shared. */
const FILTER_KEYS = ['q', 'type', 'category', 'accountId', 'payee', 'tag', 'source', 'minEur', 'maxEur', 'from', 'to', 'sort', 'dir'] as const;
type FilterKey = (typeof FILTER_KEYS)[number];
type Filters = Readonly<Record<FilterKey, string>>;

const readFilters = (query: URLSearchParams): Filters => {
  const read = (key: FilterKey) => query.get(key) ?? '';
  return {
    q: read('q'),
    type: read('type'),
    category: read('category'),
    accountId: read('accountId'),
    payee: read('payee'),
    tag: read('tag'),
    source: read('source'),
    minEur: read('minEur'),
    maxEur: read('maxEur'),
    from: read('from'),
    to: read('to'),
    sort: read('sort'),
    dir: read('dir'),
  };
};

type Sort = { key: 'date' | 'eur'; dir: 'asc' | 'desc' };

const toNumber = (value: string) => (value.trim() === '' || !Number.isFinite(Number(value)) ? undefined : Number(value));

const formatRowCount = (count: number) => pluralize(count, ['запис', 'записи', 'записів']);

/** Filters the phone folds into the «Фільтри» sheet and counts on its button; search and the month bar stay outside. */
const SHEET_KEYS = ['type', 'category', 'accountId', 'tag', 'source', 'minEur', 'maxEur'] as const satisfies readonly FilterKey[];

/** The month scope has its own bar, so «Скинути фільтри» keeps it and clears the rest. */
const SCOPE_KEYS: ReadonlySet<FilterKey> = new Set(['from', 'to', 'sort', 'dir']);

/**
 * Операції opens on the header month, like Огляд's own links; the bar steps through months and
 * «будь-який місяць» drops the scope in one click.
 */
const MonthScope = ({ from, to, onChange }: { from: string; to: string; onChange: (scope: { from: string; to: string }) => void }) => {
  const current = findCurrentMonth();
  if (from === '' && to === '') {
    return (
      <div className="op-scope">
        <b>Будь-який місяць</b>
        <button type="button" className="btn small" onClick={() => onChange({ from: current, to: current })}>
          лише {formatMonthLong(current)}
        </button>
      </div>
    );
  }
  if (from !== '' && from === to) {
    return (
      <div className="op-scope">
        <button type="button" className="btn small" aria-label="Попередній місяць" onClick={() => onChange({ from: shiftMonth(from, -1), to: shiftMonth(from, -1) })}>
          ‹
        </button>
        <b className="op-scope-label">{formatMonthLong(from)}</b>
        <button
          type="button"
          className="btn small"
          aria-label="Наступний місяць"
          disabled={from >= current}
          onClick={() => onChange({ from: shiftMonth(from, 1), to: shiftMonth(from, 1) })}
        >
          ›
        </button>
        <button type="button" className="btn small" onClick={() => onChange({ from: '', to: '' })}>
          будь-який місяць
        </button>
      </div>
    );
  }
  return (
    <div className="op-scope">
      <b className="op-scope-label">
        {from === '' ? 'до' : formatMonthShort(from)} – {to === '' ? 'тепер' : formatMonthShort(to)}
      </b>
      <button type="button" className="btn small" onClick={() => onChange({ from: '', to: '' })}>
        будь-який місяць
      </button>
    </div>
  );
};

const SortHeader = ({
  label,
  column,
  sort,
  onSort,
}: {
  label: string;
  column: Sort['key'];
  sort: Sort;
  onSort: (sort: Sort) => void;
}) => (
  <button
    type="button"
    onClick={() => onSort({ key: column, dir: sort.key === column && sort.dir === 'desc' ? 'asc' : 'desc' })}
  >
    {label}
    {sort.key === column ? (sort.dir === 'desc' ? ' ↓' : ' ↑') : ''}
  </button>
);


export const TableView = ({ query }: { query: URLSearchParams }) => {
  const accounts = useAccounts();
  const categories = useCategories();
  const filters = readFilters(query);
  const [text, setText] = useState(filters.q);
  // A saved view or a link changes the address under a mounted screen; the search box follows it.
  const [addressQ, setAddressQ] = useState(filters.q);
  if (filters.q !== addressQ) {
    setAddressQ(filters.q);
    setText(filters.q);
  }
  const [limit, setLimit] = useState(PAGE_SIZE);
  const [sheetOpen, setSheetOpen] = useState(false);
  const [grouped, setGrouped] = useState(readGroupChains);
  const q = useDeferredValue(text.trim());
  const sort: Sort = {
    key: filters.sort === 'eur' ? 'eur' : 'date',
    dir: filters.dir === 'asc' ? 'asc' : 'desc',
  };

  useEffect(() => {
    if (!sheetOpen) return undefined;
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') setSheetOpen(false);
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [sheetOpen]);

  const setFilter = (patch: Partial<Filters>) => {
    setLimit(PAGE_SIZE);
    window.location.replace(buildTableHref({ ...filters, q: text, ...patch }));
  };

  const parsedType = TransactionTypeSchema.safeParse(filters.type);
  const parsedSource = SourceSchema.safeParse(filters.source);
  const request: TransactionFilter = {
    q: q || undefined,
    type: parsedType.success ? parsedType.data : undefined,
    category: filters.category || undefined,
    accountId: filters.accountId || undefined,
    payee: filters.payee || undefined,
    tag: filters.tag || undefined,
    source: parsedSource.success ? parsedSource.data : undefined,
    minEur: toNumber(filters.minEur),
    maxEur: toNumber(filters.maxEur),
    from: filters.from || undefined,
    to: filters.to || undefined,
    sort: sort.key,
    dir: sort.dir,
    limit,
  };
  const page = useTransactions(request);
  const tags = useTags();
  const bulk = useUpdateTransactions();
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [bulkCategory, setBulkCategory] = useState('');
  const toggle = (ids: readonly string[]) =>
    setSelected((current) => {
      const next = new Set(current);
      for (const id of ids) {
        if (next.has(id)) next.delete(id);
        else next.add(id);
      }
      return next;
    });
  const items = page.data?.items ?? [];
  const visibleIds = items.map((row) => row.id);
  const allSelected = visibleIds.length > 0 && visibleIds.every((id) => selected.has(id));
  const selectedRows = items.filter((row) => selected.has(row.id));
  const names = new Map((accounts.data ?? []).map((account) => [account.id, formatAccountName(account.name)]));
  const hasFilters = FILTER_KEYS.some((key) => key !== 'sort' && key !== 'dir' && filters[key] !== '') || text !== '';
  const hasOtherFilters = FILTER_KEYS.some((key) => !SCOPE_KEYS.has(key) && filters[key] !== '') || text !== '';
  const sheetCount = SHEET_KEYS.filter((key) => filters[key] !== '').length;
  const currentQuery = buildTableHref({ ...filters, q: text }).split('?')[1] ?? '';
  // Chains only make sense in date order: sorted by size, a hold and its release sit far apart.
  const groups = grouped && sort.key === 'date';
  const entries: PlacedEntry[] = groups ? groupChains(items) : items.map((row) => ({ date: row.date, entry: { kind: 'row', row } }));
  const startsMonth = (index: number) =>
    sort.key === 'date' && entries[index]?.date.slice(0, 7) !== entries[index - 1]?.date.slice(0, 7);

  return (
    <div className="view">
      <MonthScope from={filters.from} to={filters.to} onChange={(scope) => setFilter(scope)} />
      <div className="filters">
        <input
          type="search"
          placeholder="Пошук: Glovo, Оля…"
          aria-label="Пошук"
          value={text}
          onChange={(event) => {
            setText(event.target.value);
            setLimit(PAGE_SIZE);
          }}
        />
        <button
          type="button"
          className="btn filters-toggle"
          aria-expanded={sheetOpen}
          aria-controls="filter-sheet"
          onClick={() => setSheetOpen(true)}
        >
          Фільтри{sheetCount > 0 ? ` (${sheetCount})` : ''}
        </button>
        {sheetOpen && <div className="sheet-scrim" aria-hidden="true" onClick={() => setSheetOpen(false)} />}
        <div
          id="filter-sheet"
          className={sheetOpen ? 'filter-sheet open' : 'filter-sheet'}
          {...(sheetOpen ? { role: 'dialog', 'aria-modal': true, 'aria-label': 'Фільтри' } : {})}
        >
          <div className="sheet-head">
            <b>Фільтри</b>
            <button type="button" className="btn small primary" onClick={() => setSheetOpen(false)}>
              Готово
            </button>
          </div>
          <select aria-label="Тип" value={filters.type} onChange={(event) => setFilter({ type: event.target.value })}>
            <option value="">Усі типи</option>
            {TYPE_FILTERS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select aria-label="Категорія" value={filters.category} onChange={(event) => setFilter({ category: event.target.value })}>
            <option value="">Усі категорії</option>
            {(categories.data ?? []).map((entry) => (
              <option key={entry.name}>{entry.name}</option>
            ))}
          </select>
          <select aria-label="Рахунок" value={filters.accountId} onChange={(event) => setFilter({ accountId: event.target.value })}>
            <option value="">Усі рахунки</option>
            {(accounts.data ?? []).map((account) => (
              <option key={account.id} value={account.id}>
                {formatAccountName(account.name)}
                {account.archived ? ' (архів)' : ''}
              </option>
            ))}
          </select>
          <select aria-label="Мітка" value={filters.tag} onChange={(event) => setFilter({ tag: event.target.value })}>
            <option value="">Усі мітки</option>
            {(tags.data ?? []).map((tag) => (
              <option key={tag.tag} value={tag.tag}>
                {tag.tag}
              </option>
            ))}
          </select>
          <select aria-label="Джерело" value={filters.source} onChange={(event) => setFilter({ source: event.target.value })}>
            <option value="">Усі джерела</option>
            {SourceSchema.options.map((source) => (
              <option key={source} value={source}>
                {SOURCE_LABELS[source]}
              </option>
            ))}
          </select>
          <label className="inline-label">
            <span className="small muted">Від, €</span>
            <input inputMode="decimal" value={filters.minEur} onChange={(event) => setFilter({ minEur: event.target.value })} />
          </label>
          <label className="inline-label">
            <span className="small muted">До, €</span>
            <input inputMode="decimal" value={filters.maxEur} onChange={(event) => setFilter({ maxEur: event.target.value })} />
          </label>
          <MonthPicker label="Від місяця" value={filters.from} onChange={(from) => setFilter({ from })} />
          <MonthPicker label="До місяця" value={filters.to} onChange={(to) => setFilter({ to })} />
        </div>
      </div>

      <SavedViews query={currentQuery} canSave={hasFilters}>
        {filters.payee !== '' && (
          <button type="button" className="btn small" onClick={() => setFilter({ payee: '' })} aria-label="Прибрати фільтр отримувача">
            Отримувач: {filters.payee} ✕
          </button>
        )}
        {filters.tag !== '' && (
          <button type="button" className="btn small" onClick={() => setFilter({ tag: '' })} aria-label="Прибрати фільтр мітки">
            Мітка: {filters.tag} ✕
          </button>
        )}
        {hasOtherFilters && (
          <button
            type="button"
            className="btn small"
            onClick={() => {
              setText('');
              window.location.replace(buildTableHref({ from: filters.from, to: filters.to }));
            }}
          >
            Скинути фільтри
          </button>
        )}
      </SavedViews>

      {page.isError && <p className="note err">Не вдалося завантажити записи: {describeError(page.error)}</p>}
      {page.isPending && <p className="note loading">Завантажую записи…</p>}
      <div className="op-toolbar">
        {page.data !== undefined && (
          <p className="note">
            {formatRowCount(page.data.total)} · витрати ≈{'\u00a0'}{formatEur(page.data.expenseEur)} · доходи мінус витрати
            ≈{'\u00a0'}{formatSignedEur(page.data.netEur)}
          </p>
        )}
        <label className="check">
          <input
            type="checkbox"
            checked={grouped}
            onChange={(event) => {
              setGrouped(event.target.checked);
              writeGroupChains(event.target.checked);
            }}
          />
          групувати ланцюжки
          {grouped && sort.key !== 'date' && <span className="small muted"> (лише за датою)</span>}
        </label>
      </div>

      {selected.size > 0 && (
        <div className="card bulk-bar">
          <span>
            <b>Позначено: {formatRowCount(selected.size)}</b>
          </span>
          <div className="inline-form">
            {categories.data !== undefined && <CategorySelect categories={categories.data} value={bulkCategory} onChange={setBulkCategory} />}
            <button
              type="button"
              className="btn small primary"
              disabled={bulk.isPending || bulkCategory === ''}
              onClick={() =>
                bulk.mutate(
                  {
                    ids: selectedRows.filter((row) => row.type === 'expense' || row.type === 'income').map((row) => row.id),
                    patch: { category: bulkCategory },
                  },
                  { onSuccess: () => setSelected(new Set()) },
                )
              }
            >
              Змінити категорію
            </button>
            <button
              type="button"
              className="btn small"
              disabled={bulk.isPending}
              onClick={() => bulk.mutate({ ids: [...selected], patch: { needsReview: false } }, { onSuccess: () => setSelected(new Set()) })}
            >
              Позначити перевіреними
            </button>
            <button type="button" className="btn small" onClick={() => setSelected(new Set())}>
              Зняти позначки
            </button>
          </div>
          {bulk.isError && <p className="note err">{describeError(bulk.error)}</p>}
        </div>
      )}

      <div className="tbl op-table">
        <table>
          <thead>
            <tr>
              <th className="sel-col">
                <input
                  type="checkbox"
                  aria-label="Позначити всі на сторінці"
                  checked={allSelected}
                  onChange={() => setSelected(allSelected ? new Set() : new Set(visibleIds))}
                />
              </th>
              <th className="date-col">
                <SortHeader label="Дата" column="date" sort={sort} onSort={(next) => setFilter({ sort: next.key, dir: next.dir })} />
              </th>
              <th>Опис</th>
              <th>Категорія</th>
              <th>Рахунок</th>
              <th className="r">Сума</th>
              <th className="r">
                <SortHeader label="≈ €" column="eur" sort={sort} onSort={(next) => setFilter({ sort: next.key, dir: next.dir })} />
              </th>
            </tr>
          </thead>
          <tbody>
            {entries.map(({ date, entry }, index) => (
              <Fragment key={findEntryKey(entry)}>
                {startsMonth(index) && (
                  <tr className="month-divider">
                    <td colSpan={7}>{formatMonthLong(date.slice(0, 7))}</td>
                  </tr>
                )}
                <OperationEntry entry={entry} names={names} selected={selected} onToggle={toggle} bankSince={page.data?.bankSince} />
              </Fragment>
            ))}
            {page.data?.items.length === 0 && (
              <tr>
                <td colSpan={7} className="note">
                  Нічого не знайдено.
                </td>
              </tr>
            )}
          </tbody>
        </table>
      </div>

      <div className="op-cards">
        {page.data !== undefined && sort.key === 'date' && (
          <RowsByDay rows={grouped ? items : items.map((row) => ({ ...row, chainId: null }))} accountNames={names} />
        )}
        {sort.key === 'eur' &&
          items.map((row) => (
            <div key={row.id}>
              <div className="small muted" style={{ marginTop: 6 }}>
                {formatDay(row.date)}
              </div>
              <TransactionLine transaction={row} accountNames={names} />
            </div>
          ))}
        {page.data?.items.length === 0 && <div className="empty">Нічого не знайдено.</div>}
      </div>

      {page.data !== undefined && page.data.total > page.data.items.length && (
        <button type="button" className="btn" disabled={page.isFetching} onClick={() => setLimit(limit + PAGE_SIZE)}>
          Показати ще ({formatRowCount(page.data.total - page.data.items.length)})
        </button>
      )}
    </div>
  );
};
