import { type PayeeEntry, type PayeeKind, PayeeKindSchema, PayeeNameSchema } from '@hroshi/schema';
import { useEffect, useRef, useState } from 'react';

import { describeError } from '../api.ts';
import { SectionHead } from '../components/InfoTip.tsx';
import { formatDay, formatEur, formatWhole, keepTogether, pluralize } from '../format.ts';
import { KIND_LABELS } from '../review/answers.ts';
import { buildTableHref } from '../route.ts';
import { usePayeeDirectory, useSavePayeeAliases } from './queries.ts';

const PAGE_SIZE = 60;

/** The bank spellings a payee is made of: listed for a renamed one, its own key otherwise. */
const listKeys = (entry: PayeeEntry): string[] => (entry.members.length === 0 ? [entry.key] : entry.members.map((member) => member.key));

const normalizeSearch = (text: string) => text.toLocaleLowerCase('uk').trim();

const matchesSearch = (entry: PayeeEntry, search: string) =>
  search === '' ||
  [entry.name, entry.alias ?? '', ...entry.members.map((member) => member.name)].some((text) => normalizeSearch(text).includes(search));

const parseKind = (value: string): PayeeKind | null => PayeeKindSchema.options.find((kind) => kind === value) ?? null;

const DISMISSED_KEY = 'hroshi.payees.dismissedSimilar';
/** Groups shown before «показати ще»: the busiest ones are where a merge changes the most. */
const SIMILAR_PAGE = 5;
/** Names a suggestion spells out; the rest of a long group is a count. */
const SIMILAR_NAMES = 4;

const findSignature = (keys: readonly string[]) => keys.toSorted().join('|');

const readDismissed = (): ReadonlySet<string> => {
  try {
    const parsed: unknown = JSON.parse(window.localStorage.getItem(DISMISSED_KEY) ?? '[]');
    return new Set(Array.isArray(parsed) ? parsed.filter((entry): entry is string => typeof entry === 'string') : []);
  } catch {
    return new Set();
  }
};

const writeDismissed = (dismissed: ReadonlySet<string>) => {
  try {
    window.localStorage.setItem(DISMISSED_KEY, JSON.stringify([...dismissed]));
  } catch {
    // Private windows refuse storage: a dismissed suggestion simply comes back after a reload.
  }
};

/**
 * «Схожі назви»: payees the bank spells several ways, offered as one click that ticks them all, so
 * the merge bar opens with the busiest name; «різні» hides a suggestion in this browser.
 */
const SimilarNames = ({
  groups,
  byKey,
  onPick,
}: {
  groups: readonly (readonly string[])[];
  byKey: ReadonlyMap<string, PayeeEntry>;
  onPick: (keys: readonly string[]) => void;
}) => {
  const [dismissed, setDismissed] = useState(readDismissed);
  const [limit, setLimit] = useState(SIMILAR_PAGE);
  const open = groups
    .map((keys) => keys.flatMap((key) => byKey.get(key) ?? []))
    .filter((entries) => entries.length > 1 && !dismissed.has(findSignature(entries.map((entry) => entry.key))));
  if (open.length === 0) return null;
  const dismiss = (entries: readonly PayeeEntry[]) => {
    const next = new Set(dismissed).add(findSignature(entries.map((entry) => entry.key)));
    setDismissed(next);
    writeDismissed(next);
  };
  return (
    <details className="similar-names" open>
      <summary>
        Схожі назви · {pluralize(open.length, ['група', 'групи', 'груп'])}
        <span className="small muted"> — регістр, міста, юридичні форми чи довший варіант тієї ж назви</span>
      </summary>
      <div className="similar-list">
        {open.slice(0, limit).map((entries) => {
          const rows = entries.reduce((sum, entry) => sum + entry.count, 0);
          const rest = entries.length - SIMILAR_NAMES;
          return (
            <div key={findSignature(entries.map((entry) => entry.key))} className="similar-row">
              <div className="similar-names-text">
                {entries.slice(0, SIMILAR_NAMES).map((entry, index) => (
                  <span key={entry.key}>
                    {index > 0 && ' · '}
                    <b>{keepTogether(entry.name)}</b> <span className="muted num">{formatWhole(entry.count)}</span>
                  </span>
                ))}
                {rest > 0 && <span className="muted"> · ще {pluralize(rest, ['назва', 'назви', 'назв'])}</span>}
                <div className="small muted">{pluralize(rows, ['запис', 'записи', 'записів'])} разом</div>
              </div>
              <div className="similar-actions">
                <button type="button" className="btn small" onClick={() => onPick(entries.map((entry) => entry.key))}>
                  Об’єднати?
                </button>
                <button type="button" className="btn small quiet" title="Це різні отримувачі: більше не пропонувати" onClick={() => dismiss(entries)}>
                  різні
                </button>
              </div>
            </div>
          );
        })}
      </div>
      {open.length > limit && (
        <button type="button" className="btn small" onClick={() => setLimit(limit + SIMILAR_PAGE)}>
          Показати ще {pluralize(Math.min(SIMILAR_PAGE, open.length - limit), ['групу', 'групи', 'груп'])}
        </button>
      )}
    </details>
  );
};

/** «Змінити» opens this under the row: a new name (Enter saves, Esc closes), what kind of payee it is, and the way back. */
const PayeeEditor = ({ entry, onDone }: { entry: PayeeEntry; onDone: () => void }) => {
  const save = useSavePayeeAliases();
  const [name, setName] = useState(entry.alias ?? entry.name);
  const input = useRef<HTMLInputElement>(null);
  useEffect(() => input.current?.select(), []);
  const parsed = PayeeNameSchema.safeParse(name);
  const keys = listKeys(entry);
  return (
    <div className="payee-edit">
      <form
        className="payee-rename"
        onSubmit={(event) => {
          event.preventDefault();
          if (parsed.success) save.mutate({ keys, name: parsed.data }, { onSuccess: onDone });
        }}
      >
        <input
          aria-label={`Нова назва для «${entry.name}»`}
          value={name}
          maxLength={40}
          ref={input}
          onChange={(event) => setName(event.target.value)}
          onKeyDown={(event) => {
            if (event.key === 'Escape') onDone();
          }}
        />
        <button type="submit" className="btn small primary" disabled={!parsed.success || save.isPending}>
          Перейменувати
        </button>
      </form>
      <label className="kind-picker small muted">
        Хто це:
        <select
          value={entry.kindByOwner ? entry.kind : ''}
          disabled={save.isPending}
          onChange={(event) => save.mutate({ keys, kind: parseKind(event.target.value) })}
        >
          <option value="">{entry.kindByOwner ? 'визначати автоматично' : `${KIND_LABELS[entry.kind]} (авто)`}</option>
          {PayeeKindSchema.options.map((kind) => (
            <option key={kind} value={kind}>
              {KIND_LABELS[kind]}
            </option>
          ))}
        </select>
      </label>
      {entry.alias !== null && (
        <button
          type="button"
          className="btn small"
          disabled={save.isPending}
          title="Повернути назви з банку й роз’єднати"
          onClick={() => save.mutate({ keys, name: null }, { onSuccess: onDone })}
        >
          Як у банку
        </button>
      )}
      {!parsed.success && name.trim() !== '' && <span className="note err">{parsed.error.issues[0]?.message}</span>}
      {save.isError && <span className="note err">{describeError(save.error)}</span>}
    </div>
  );
};

const PayeeRow = ({
  entry,
  selected,
  onSelect,
}: {
  entry: PayeeEntry;
  selected: boolean;
  onSelect: (selected: boolean) => void;
}) => {
  const [editing, setEditing] = useState(false);
  const others = entry.members.filter((member) => member.name !== entry.name);
  return (
    <div className={selected ? 'payee-row selected' : 'payee-row'}>
      <input
        type="checkbox"
        className="payee-pick"
        checked={selected}
        aria-label={`Вибрати «${entry.name}» для об’єднання`}
        onChange={(event) => onSelect(event.target.checked)}
      />
      <div className="payee-main">
        <div className="t">
          <a href={buildTableHref({ payee: entry.key })}>
            <b>{keepTogether(entry.name)}</b>
          </a>{' '}
          {(entry.kind !== 'merchant' || entry.kindByOwner) && (
            <span className={entry.kindByOwner ? 'chip' : 'chip muted'} title={entry.kindByOwner ? 'Вказано тобою' : 'Визначено з тексту банку'}>
              {KIND_LABELS[entry.kind]}
            </span>
          )}
          {entry.alias !== null && <span className="chip">перейменовано</span>}
        </div>
        <div className="s">
          {pluralize(entry.count, ['запис', 'записи', 'записів'])}
          {entry.category !== null && ` · ${entry.category}`} · востаннє {formatDay(entry.lastDate)}
        </div>
        {others.length > 0 && (
          <div className="s">у банку: {keepTogether(others.map((member) => `${member.name} (${member.count})`).join(', '))}</div>
        )}
      </div>
      <div className="payee-sums num">
        {entry.spentEur !== 0 && <span>{formatEur(entry.spentEur)}</span>}
        {entry.receivedEur !== 0 && <span className="pos">+{formatEur(entry.receivedEur)}</span>}
      </div>
      <button
        type="button"
        className="btn small quiet payee-edit-toggle"
        aria-expanded={editing}
        aria-label={`Змінити «${entry.name}»`}
        onClick={() => setEditing(!editing)}
      >
        {editing ? 'Закрити' : 'Змінити'}
      </button>
      {editing && <PayeeEditor entry={entry} onDone={() => setEditing(false)} />}
    </div>
  );
};

/** Several payees chosen with the checkboxes become one, under the name of the busiest by default. */
const MergeBar = ({ entries, onDone }: { entries: readonly PayeeEntry[]; onDone: () => void }) => {
  const save = useSavePayeeAliases();
  const busiest = entries.toSorted((left, right) => right.count - left.count)[0];
  const [name, setName] = useState(busiest?.alias ?? busiest?.name ?? '');
  const parsed = PayeeNameSchema.safeParse(name);
  return (
    <form
      className="merge-bar"
      onSubmit={(event) => {
        event.preventDefault();
        if (parsed.success) save.mutate({ keys: entries.flatMap(listKeys), name: parsed.data }, { onSuccess: onDone });
      }}
    >
      <span>
        Об’єднати {pluralize(entries.length, ['отримувача', 'отримувачів', 'отримувачів'])} під назвою
      </span>
      <input aria-label="Спільна назва" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      <button type="submit" className="btn small primary" disabled={!parsed.success || save.isPending}>
        Об’єднати
      </button>
      <button type="button" className="btn small" onClick={onDone}>
        Скасувати вибір
      </button>
      {save.isError && <span className="note err">{describeError(save.error)}</span>}
    </form>
  );
};

/**
 * Дані → Отримувачі: the bank spells one shop many ways («Condis», «CONDIS BARCELONA»). A rename
 * here, or a merge under one name, regroups the rows in analytics, payments, review and operations.
 */
export const PayeesView = () => {
  const directory = usePayeeDirectory();
  const [search, setSearch] = useState('');
  const [kind, setKind] = useState<PayeeKind | ''>('');
  const [onlyRenamed, setOnlyRenamed] = useState(false);
  const [selected, setSelected] = useState<ReadonlySet<string>>(new Set());
  const [limit, setLimit] = useState(PAGE_SIZE);

  if (directory.isError) return <p className="note err">Не вдалося завантажити: {describeError(directory.error)}</p>;
  if (directory.data === undefined) return <p className="note loading">Завантажую…</p>;

  const query = normalizeSearch(search);
  const { payees, similar } = directory.data;
  const byKey = new Map(payees.map((entry) => [entry.key, entry]));
  const filtered = payees.filter(
    (entry) => matchesSearch(entry, query) && (kind === '' || entry.kind === kind) && (!onlyRenamed || entry.alias !== null),
  );
  const chosen = payees.filter((entry) => selected.has(entry.key));
  const renamed = payees.filter((entry) => entry.alias !== null).length;
  const toggle = (key: string, on: boolean) =>
    setSelected((current) => {
      const next = new Set(current);
      if (on) next.add(key);
      else next.delete(key);
      return next;
    });

  return (
    <div className="view">
      <section>
        <SectionHead
          title={`Отримувачі · ${pluralize(payees.length, ['назва', 'назви', 'назв'])}`}
          info={
            <>
              <p>Кожна назва — як її пише банк, почищена від номерів терміналів і міст. Тут їх можна перейменувати або звести разом.</p>
              <p>
                Нова назва діє скрізь: «Кому йдуть гроші», регулярні платежі, групи в «Перевірці» й фільтр в «Операціях». Правила
                й далі шукають текст банку, тож перейменування їх не ламає.
              </p>
              <p>«Хто це» підказує «Перевірці», що робити з записами: свій переказ і готівку — записати переказом, податок — правилом.</p>
            </>
          }
        />
        <div className="payee-tools">
          <input
            type="search"
            className="search"
            placeholder="Пошук: назва або як у банку"
            aria-label="Пошук отримувача"
            value={search}
            onChange={(event) => {
              setSearch(event.target.value);
              setLimit(PAGE_SIZE);
            }}
          />
          <select aria-label="Хто" value={kind} onChange={(event) => setKind(parseKind(event.target.value) ?? '')}>
            <option value="">усі</option>
            {PayeeKindSchema.options.map((entry) => (
              <option key={entry} value={entry}>
                {KIND_LABELS[entry]}
              </option>
            ))}
          </select>
          {renamed > 0 && (
            <div className="seg" role="group" aria-label="Перейменовані">
              <button type="button" aria-pressed={onlyRenamed} onClick={() => setOnlyRenamed(!onlyRenamed)}>
                перейменовані <span className="num">{renamed}</span>
              </button>
            </div>
          )}
        </div>
        {chosen.length >= 2 ? (
          <MergeBar key={[...selected].join('|')} entries={chosen} onDone={() => setSelected(new Set())} />
        ) : (
          <p className="note">Познач двох або більше, щоб звести їх під одну назву.</p>
        )}
        <SimilarNames groups={similar} byKey={byKey} onPick={(keys) => setSelected(new Set(keys))} />
        {filtered.length === 0 ? (
          <div className="empty">Нікого не знайдено.</div>
        ) : (
          <div className="payee-list">
            {filtered.slice(0, limit).map((entry) => (
              <PayeeRow key={entry.key} entry={entry} selected={selected.has(entry.key)} onSelect={(on) => toggle(entry.key, on)} />
            ))}
          </div>
        )}
        {filtered.length > limit && (
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setLimit(limit + PAGE_SIZE)}>
            Показати ще {pluralize(Math.min(PAGE_SIZE, filtered.length - limit), ['назву', 'назви', 'назв'])} (залишилось{' '}
            {formatWhole(filtered.length - limit)})
          </button>
        )}
      </section>
    </div>
  );
};
