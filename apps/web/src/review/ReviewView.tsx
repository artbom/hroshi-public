import { type AccountBalance, type Category, type CategoryUsage, type ReviewGroup, type ReviewKind, ReviewKindSchema } from '@hroshi/schema';
import { useEffect, useState } from 'react';

import { describeError } from '../api.ts';
import { CategorySelect } from '../components/CategorySelect.tsx';
import { SectionHead } from '../components/InfoTip.tsx';
import { MonthPicker } from '../components/MonthPicker.tsx';
import { formatAccountName, formatDay, formatEur, keepTogether, pluralize } from '../format.ts';
import { findToday } from '../months.ts';
import { useAccounts, useAnswerReview, useCategories, useCategoryUsage, useReviewInbox } from '../queries.ts';
import {
  buildAnswer,
  CONFIDENCE_LABELS,
  createDraft,
  type Direction,
  type Draft,
  describeImpact,
  findDirection,
  describeKindHint,
  isAcceptable,
  KIND_LABELS,
  orderByDependencies,
  shiftDay,
  TRANSFER_KINDS,
} from './answers.ts';
import { describeGroupMeta, GroupCard } from './GroupCard.tsx';
import { OwnCardQuestion, SNOOZE_DAYS, SnoozeButton } from './GroupControls.tsx';
import { useSnoozeReview } from './queries.ts';

const SORTS = [
  { value: 'date', label: 'спершу нові' },
  { value: 'amount', label: 'спершу більші' },
  { value: 'count', label: 'спершу частіші' },
] as const;
type Sort = (typeof SORTS)[number]['value'];
type Mode = 'compact' | 'full';
/** Which groups the list shows: all waiting ones, those new since the last visit, or the parked ones. */
type Show = 'waiting' | 'new' | 'snoozed';

const PAGE_SIZE: Readonly<Record<Mode, number>> = { compact: 50, full: 15 };
const QUICK_KEYS = 9;
const MODE_KEY = 'hroshi.review.mode';
const SORT_KEY = 'hroshi.review.sort';
const LAST_VISIT_KEY = 'hroshi.review.lastVisit';
/** A long backlog is cleared biggest first; once it is short, the newest rows matter most. */
const SHORT_BACKLOG_GROUPS = 50;

const readStored = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeStored = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Private windows refuse storage; the inbox simply forgets the preference.
  }
};

/** The previous visit's time, read once; this visit becomes the next one's «since». */
const useLastVisit = (): string | null => {
  const [previous] = useState(() => readStored(LAST_VISIT_KEY));
  useEffect(() => writeStored(LAST_VISIT_KEY, new Date().toISOString()), []);
  return previous;
};

const sortGroups = (groups: readonly ReviewGroup[], sort: Sort) =>
  groups.toSorted((left, right) => {
    if (sort === 'amount') return right.totalEur - left.totalEur;
    if (sort === 'date') return right.latestDate.localeCompare(left.latestDate);
    return right.rows.length - left.rows.length;
  });

const parseSort = (value: string | null): Sort | null => SORTS.find((option) => option.value === value)?.value ?? null;

const isTyping = (target: EventTarget | null) =>
  target instanceof HTMLInputElement || target instanceof HTMLSelectElement || target instanceof HTMLTextAreaElement;

const findGroupElement = (key: string) => document.querySelector<HTMLElement>(`[data-group="${CSS.escape(key)}"]`);

/** The categories digits 1–9 pick, the most used first: income ones on an income group, spending ones otherwise. */
const rankQuickCategories = ({
  usage,
  categories,
  direction,
}: {
  usage: readonly CategoryUsage[];
  categories: readonly Category[];
  direction: Direction;
}): string[] => {
  const fits = new Set(
    categories
      .filter((category) => !category.archived && (direction === 'income' ? category.forIncome : category.forExpense))
      .map((category) => category.name),
  );
  return usage
    .filter((entry) => !entry.locked && fits.has(entry.name))
    .toSorted((left, right) => right.rows - left.rows)
    .slice(0, QUICK_KEYS)
    .map((entry) => entry.name);
};

const Shortcuts = ({ quick, direction }: { quick: readonly string[]; direction: Direction }) => (
  <div className="kbd-legend" aria-label="Клавіші">
    <span>
      <kbd>j</kbd>/<kbd>k</kbd> група
    </span>
    <span>
      <kbd>1</kbd>–<kbd>9</kbd> категорія
    </span>
    <span>
      <kbd>Enter</kbd> зберегти
    </span>
    <span>
      <kbd>r</kbd> правило
    </span>
    <span>
      <kbd>t</kbd> переказ
    </span>
    <span>
      <kbd>x</kbd> залишити як є
    </span>
    <span>
      <kbd>s</kbd> відкласти
    </span>
    <span>
      <kbd>e</kbd> розгорнути
    </span>
    <span>
      <kbd>Esc</kbd> назад до списку
    </span>
    {quick.length > 0 && (
      <span className="kbd-quick">
        <span className="kbd-quick-label">{direction === 'income' ? 'для надходжень:' : 'для витрат:'}</span>
        {quick.map((category, index) => (
          <span key={category}>
            <kbd>{index + 1}</kbd> {category}
          </span>
        ))}
      </span>
    )}
  </div>
);

const stopClick = (event: { stopPropagation: () => void }) => event.stopPropagation();

/**
 * What the row offers when it has no confident guess: the likeliest categories in one click, a
 * transfer, or leaving it as it is. A transfer-like payee (own money, cash) leads with the transfer.
 */
const QuickPicks = ({
  group,
  categories,
  saving,
  onPick,
  onChoose,
  onTransfer,
  onLeave,
}: {
  group: ReviewGroup;
  categories: readonly Category[];
  saving: boolean;
  onPick: (category: string) => void;
  /** Picks a category from the full list without saving yet: there was no guess to confirm. */
  onChoose: (category: string) => void;
  onTransfer: () => void;
  onLeave: () => void;
}) => {
  const transferFirst = TRANSFER_KINDS.has(group.kind);
  const transfer = (
    <button type="button" className={transferFirst ? 'btn small primary' : 'btn small quiet'} disabled={saving} onClick={onTransfer}>
      переказ…
    </button>
  );
  return (
    <div className="pick-chips" onClick={stopClick}>
      {transferFirst && transfer}
      {group.candidates.map((category) => (
        <button key={category} type="button" className="btn small" disabled={saving} title={`Записати в «${category}»`} onClick={() => onPick(category)}>
          {category}
        </button>
      ))}
      {!transferFirst && transfer}
      {group.candidates.length === 0 && (
        <CategorySelect categories={categories} value="" onChange={onChoose} placeholder="категорія…" />
      )}
      <button type="button" className="btn small quiet" disabled={saving} title="Залишити як є (x)" onClick={onLeave}>
        залишити
      </button>
    </div>
  );
};

const CompactRow = ({
  group,
  draft,
  focused,
  expanded,
  isNew,
  waitsFor,
  saving,
  accounts,
  categories,
  onFocus,
  onToggle,
  onSave,
  onPick,
  onChoose,
  onTransfer,
  onLeave,
  onJump,
}: {
  group: ReviewGroup;
  draft: Draft;
  focused: boolean;
  expanded: boolean;
  isNew: boolean;
  /** Names of the groups to answer before this one. */
  waitsFor: readonly { key: string; name: string }[];
  saving: boolean;
  accounts: readonly AccountBalance[];
  categories: readonly Category[];
  onFocus: () => void;
  onToggle: () => void;
  onSave: () => void;
  onPick: (category: string) => void;
  onChoose: (category: string) => void;
  onTransfer: () => void;
  onLeave: () => void;
  onJump: (key: string) => void;
}) => {
  const { suggestion } = group;
  const impact = describeImpact(group.impact);
  const hint = describeKindHint(group.kind);
  const answer = buildAnswer({ group, draft });
  const changed = draft.category !== '' && draft.category !== suggestion?.category;
  const parked = group.snoozedUntil !== null;
  const askCard = group.kind === 'card' && !group.kindByOwner && !parked;
  return (
    <div className="review-row-main" onClick={onFocus}>
      <div className="review-row-what">
        <div className="t">
          <b>{keepTogether(group.name)}</b> <span className="chip muted">{KIND_LABELS[group.kind]}</span>
          {isNew && <span className="chip new">нове</span>}
          {Object.keys(group.twins).length > 0 && <span className="chip warn">можливий дубль</span>}
          {parked && <span className="chip muted">відкладено до {formatDay(group.snoozedUntil ?? '')}</span>}
        </div>
        <div className="s">{describeGroupMeta(group)}</div>
        {impact !== null && <div className="s impact">{impact}</div>}
        {hint !== null && TRANSFER_KINDS.has(group.kind) && <div className="s">{hint}</div>}
        {waitsFor.map((other) => (
          <button
            key={other.key}
            type="button"
            className="chip warn as-button"
            onClick={(event) => {
              event.stopPropagation();
              onJump(other.key);
            }}
          >
            спершу «{keepTogether(other.name)}» ↑
          </button>
        ))}
      </div>
      <div className="review-row-pick">
        {askCard ? (
          <OwnCardQuestion group={group} accounts={accounts} />
        ) : parked ? null : draft.category === '' ? (
          <QuickPicks
            group={group}
            categories={categories}
            saving={saving}
            onPick={onPick}
            onChoose={onChoose}
            onTransfer={onTransfer}
            onLeave={onLeave}
          />
        ) : (
          <>
            {suggestion !== null && !changed && (
              <span className="pick" title={suggestion.reason}>
                <b>{suggestion.category}</b>{' '}
                <span className={`chip confidence ${suggestion.confidence}`}>{CONFIDENCE_LABELS[suggestion.confidence]}</span>
              </span>
            )}
            {changed && (
              <span className="pick">
                <b>{draft.category}</b> <span className="chip muted">твій вибір</span>
              </span>
            )}
            {draft.makeRule && answer?.rule != null && <span className="chip muted">+ правило</span>}
            {answer !== null && !parked && (
              <button
                type="button"
                className="btn small primary"
                disabled={saving}
                onClick={(event) => {
                  event.stopPropagation();
                  onSave();
                }}
              >
                Зберегти
              </button>
            )}
          </>
        )}
        <SnoozeButton group={group} compact />
      </div>
      <div className="review-row-actions">
        <button
          type="button"
          className="btn small"
          aria-expanded={expanded}
          aria-label={`${expanded ? 'Згорнути' : 'Розгорнути'}: ${group.name}`}
          onClick={(event) => {
            event.stopPropagation();
            onToggle();
          }}
        >
          {expanded ? '▴' : '▾'}
        </button>
      </div>
      {focused && <span className="sr-only">вибрано</span>}
    </div>
  );
};

export const ReviewView = () => {
  const accounts = useAccounts();
  const categories = useCategories();
  const usage = useCategoryUsage();
  const inbox = useReviewInbox();
  const answer = useAnswerReview();
  const snooze = useSnoozeReview();
  const lastVisit = useLastVisit();
  const [mode, setModeState] = useState<Mode>(() => (readStored(MODE_KEY) === 'full' ? 'full' : 'compact'));
  const [sortChoice, setSortChoice] = useState<Sort | null>(() => parseSort(readStored(SORT_KEY)));
  const [kind, setKind] = useState<ReviewKind | ''>('');
  const [accountId, setAccountId] = useState('');
  const [from, setFrom] = useState('');
  const [show, setShow] = useState<Show>('waiting');
  const [limit, setLimit] = useState(PAGE_SIZE.compact);
  const [focusKey, setFocusKey] = useState<string | null>(null);
  const [expanded, setExpanded] = useState<ReadonlySet<string>>(new Set());
  const [drafts, setDrafts] = useState<Readonly<Record<string, Draft>>>({});
  const [startTotal, setStartTotal] = useState<number | null>(null);
  const [confirmAll, setConfirmAll] = useState(false);
  const [progress, setProgress] = useState<{ done: number; of: number } | null>(null);

  const total = inbox.data?.total;
  // Remembered from the first load, so the bar shows this sitting's progress.
  if (total !== undefined && startTotal === null) setStartTotal(total);

  const setMode = (next: Mode) => {
    setModeState(next);
    setLimit(PAGE_SIZE[next]);
    writeStored(MODE_KEY, next);
  };
  const setSort = (next: Sort) => {
    setSortChoice(next);
    writeStored(SORT_KEY, next);
  };
  const isNewGroup = (group: ReviewGroup) => lastVisit !== null && group.rows.some((row) => row.createdAt > lastVisit);
  const allGroups = inbox.data?.groups ?? [];
  const waitingGroups = allGroups.filter((group) => group.snoozedUntil === null);
  const sort = sortChoice ?? (waitingGroups.length < SHORT_BACKLOG_GROUPS ? 'date' : 'amount');
  const isShown = (group: ReviewGroup) =>
    show === 'snoozed' ? group.snoozedUntil !== null : group.snoozedUntil === null && (show === 'waiting' || isNewGroup(group));
  const groups = orderByDependencies(
    sortGroups(
      allGroups.filter(
        (group) =>
          isShown(group) &&
          (kind === '' || group.kind === kind) &&
          (accountId === '' || group.rows.some((row) => row.accountId === accountId)) &&
          (from === '' || group.latestDate.slice(0, 7) >= from),
      ),
      sort,
    ),
  );
  const shown = groups.slice(0, limit);
  const focusIndex = Math.max(0, shown.findIndex((group) => group.key === focusKey));
  const focused = shown[focusIndex];
  const draftOf = (group: ReviewGroup): Draft => drafts[group.key] ?? createDraft(group);
  const updateDraft = (group: ReviewGroup, patch: Partial<Draft>) =>
    setDrafts((current) => ({ ...current, [group.key]: { ...(current[group.key] ?? createDraft(group)), ...patch } }));
  const namesByKey = new Map(allGroups.map((group) => [group.key, group.name]));
  const focusedDirection = focused === undefined ? 'expense' : findDirection(focused);
  const quick = rankQuickCategories({ usage: usage.data ?? [], categories: categories.data ?? [], direction: focusedDirection });
  const acceptable = groups.filter(isAcceptable);
  const acceptableRows = acceptable.reduce((sum, group) => sum + (buildAnswer({ group, draft: createDraft(group) })?.ids.length ?? 0), 0);
  const acceptableRules = acceptable.filter((group) => buildAnswer({ group, draft: createDraft(group) })?.rule != null).length;

  const toggleExpanded = (key: string) =>
    setExpanded((current) => {
      const next = new Set(current);
      if (next.has(key)) next.delete(key);
      else next.add(key);
      return next;
    });

  const focusGroup = (key: string, { scroll }: { scroll: boolean }) => {
    setFocusKey(key);
    if (scroll) window.requestAnimationFrame(() => findGroupElement(key)?.scrollIntoView({ block: 'nearest', behavior: 'smooth' }));
  };

  const save = (group: ReviewGroup, { category }: { category?: string } = {}) => {
    const draft = draftOf(group);
    const built = buildAnswer({ group, draft: category === undefined ? draft : { ...draft, category } });
    if (built === null) return;
    const next = shown[shown.indexOf(group) + 1];
    answer.mutate({ answers: [built] }, { onSuccess: () => setFocusKey(next?.key ?? null) });
  };

  /** Opens the group and puts the focus on its transfer picker, as «t» does. */
  const startTransfer = (group: ReviewGroup) => {
    setFocusKey(group.key);
    if (mode === 'compact' && !expanded.has(group.key)) toggleExpanded(group.key);
    window.requestAnimationFrame(() => document.querySelector<HTMLSelectElement>(`[data-transfer="${CSS.escape(group.key)}"]`)?.focus());
  };

  const snoozeGroup = (group: ReviewGroup) =>
    snooze.mutate({
      ids: group.rows.map((row) => row.id),
      until: group.snoozedUntil === null ? shiftDay({ day: findToday(), days: SNOOZE_DAYS }) : null,
    });

  const leaveAsIs = (group: ReviewGroup) => {
    const draft = draftOf(group);
    const ids = group.rows.filter((row) => group.twins[row.id] === undefined && !draft.excluded.has(row.id)).map((row) => row.id);
    if (ids.length > 0) answer.mutate({ answers: [{ ids, patch: { needsReview: false }, rule: null }] });
  };

  const acceptAll = () => {
    const answers = acceptable.flatMap((group) => buildAnswer({ group, draft: createDraft(group) }) ?? []);
    setProgress({ done: 0, of: answers.length });
    answer.mutate(
      { answers, onProgress: (done) => setProgress({ done, of: answers.length }) },
      {
        onSettled: () => {
          setProgress(null);
          setConfirmAll(false);
        },
      },
    );
  };

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      // Escape hands the keys back to the list after «t» put the focus into the transfer picker.
      if (event.key === 'Escape' && isTyping(event.target) && event.target instanceof HTMLElement) event.target.blur();
      if (event.metaKey || event.ctrlKey || event.altKey || isTyping(event.target) || focused === undefined) return;
      const onControl = event.target instanceof HTMLButtonElement || event.target instanceof HTMLAnchorElement;
      if (event.key === 'j' || event.key === 'k') {
        const next = shown[Math.min(shown.length - 1, Math.max(0, focusIndex + (event.key === 'j' ? 1 : -1)))];
        if (next !== undefined) focusGroup(next.key, { scroll: true });
      } else if (/^[1-9]$/u.test(event.key)) {
        const category = quick[Number(event.key) - 1];
        if (category !== undefined) updateDraft(focused, { category });
      } else if (event.key === 'r') {
        updateDraft(focused, { makeRule: !draftOf(focused).makeRule });
      } else if (event.key === 'e') {
        toggleExpanded(focused.key);
      } else if (event.key === 'x') {
        leaveAsIs(focused);
      } else if (event.key === 't') {
        event.preventDefault();
        startTransfer(focused);
      } else if (event.key === 's' && !snooze.isPending) {
        snoozeGroup(focused);
      } else if (event.key === 'Enter' && !onControl && !answer.isPending) {
        save(focused);
      } else {
        return;
      }
      event.preventDefault();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  });

  if (inbox.isError) return <p className="note err">Не вдалося завантажити: {describeError(inbox.error)}</p>;
  if (inbox.data === undefined || accounts.data === undefined || categories.data === undefined) {
    return <p className="note loading">Завантажую…</p>;
  }
  const names = new Map(accounts.data.map((account) => [account.id, formatAccountName(account.name)]));
  const done = startTotal === null ? 0 : Math.max(0, startTotal - inbox.data.total);
  const newCount = waitingGroups.filter(isNewGroup).length;
  const snoozedCount = allGroups.length - waitingGroups.length;
  const waitingRows = inbox.data.total - inbox.data.snoozed;
  const shows: readonly { value: Show; label: string; count: number }[] = [
    { value: 'waiting', label: 'чекають', count: waitingGroups.length },
    { value: 'new', label: 'нові', count: newCount },
    { value: 'snoozed', label: 'відкладені', count: snoozedCount },
  ];
  const visibleShows = shows.filter((option) => option.value === 'waiting' || option.count > 0 || option.value === show);

  const renderCard = (group: ReviewGroup) => (
    <GroupCard
      group={group}
      draft={draftOf(group)}
      onDraft={(patch) => updateDraft(group, patch)}
      onSave={() => save(group)}
      saving={answer.isPending}
      accounts={accounts.data}
      categories={categories.data}
      names={names}
      onJump={(key) => focusGroup(key, { scroll: true })}
      showImpact={mode === 'full'}
    />
  );

  return (
    <div className="view">
      <section>
        <SectionHead
          title={waitingRows === 0 ? 'Усе розібрано' : `Залишилось ${pluralize(waitingRows, ['запис', 'записи', 'записів'])}`}
          info={
            <>
              <p>Записи з синхронізації, які правила не змогли розібрати: нова категорія, можливий дубль, переказ людині.</p>
              <p>
                Записи одного отримувача згруповано: одна відповідь — для всіх позначених. Пропозиція — з того, як ти записував цього
                отримувача раніше, або з MCC. «Впевнено» — щонайменше три записи і майже всі в одній категорії; один запис в історії —
                «слабко».
              </p>
              <p>Групу, від якої залежить інша (покупка, до якої належить повернення), показано перед нею.</p>
              <p>
                «Відкласти» ховає групу на {SNOOZE_DAYS} днів; новий запис того ж отримувача повертає її раніше. Відкладені записи
                й далі рахуються як є.
              </p>
            </>
          }
        >
          <div className="seg" role="group" aria-label="Вигляд">
            <button type="button" aria-pressed={mode === 'compact'} onClick={() => setMode('compact')}>
              Стисло
            </button>
            <button type="button" aria-pressed={mode === 'full'} onClick={() => setMode('full')}>
              Докладно
            </button>
          </div>
        </SectionHead>
        {startTotal !== null && startTotal > 0 && (
          <div
            className="stack"
            style={{ height: 8, marginBottom: 10 }}
            role="progressbar"
            aria-label="Розібрано за цей захід"
            aria-valuemin={0}
            aria-valuemax={startTotal}
            aria-valuenow={done}
          >
            <i style={{ width: `${(done / startTotal) * 100}%`, background: 'var(--accent)' }} />
          </div>
        )}
        {done > 0 && <p className="note">Розібрано за цей захід: {pluralize(done, ['запис', 'записи', 'записів'])}.</p>}
        <div className="review-filters">
          {visibleShows.length > 1 && (
          <div className="seg" role="group" aria-label="Які групи">
            {visibleShows.map((option) => (
                <button key={option.value} type="button" aria-pressed={show === option.value} onClick={() => setShow(option.value)}>
                  {option.label} <span className="num">{option.count}</span>
                </button>
              ))}
          </div>
          )}
          <select aria-label="Порядок" value={sort} onChange={(event) => setSort(parseSort(event.target.value) ?? 'date')}>
            {SORTS.map((option) => (
              <option key={option.value} value={option.value}>
                {option.label}
              </option>
            ))}
          </select>
          <select aria-label="Хто" value={kind} onChange={(event) => setKind(ReviewKindSchema.options.find((entry) => entry === event.target.value) ?? '')}>
            <option value="">усі отримувачі</option>
            {ReviewKindSchema.options.map((entry) => (
              <option key={entry} value={entry}>
                {KIND_LABELS[entry]}
              </option>
            ))}
          </select>
          <select aria-label="Рахунок" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
            <option value="">усі рахунки</option>
            {accounts.data
              .filter((account) => !account.archived)
              .map((account) => (
                <option key={account.id} value={account.id}>
                  {formatAccountName(account.name)}
                </option>
              ))}
          </select>
          <MonthPicker label="Не раніше місяця" placeholder="будь-коли" showLabel={false} value={from} onChange={setFrom} />
        </div>
        {lastVisit !== null && show === 'new' && (
          <p className="note">Групи з записами, що з’явилися після попереднього візиту.</p>
        )}

        {acceptable.length > 0 && (
          <div className="accept-all">
            {confirmAll ? (
              <>
                <span>
                  Записати {pluralize(acceptable.length, ['групу', 'групи', 'груп'])} ({pluralize(acceptableRows, ['запис', 'записи', 'записів'])}) у
                  запропоновані категорії
                  {acceptableRules > 0 && ` і створити ${pluralize(acceptableRules, ['правило', 'правила', 'правил'])} для магазинів`}?
                </span>
                <button type="button" className="btn small primary" disabled={answer.isPending} onClick={acceptAll}>
                  {progress === null ? 'Так, записати' : `Записую ${progress.done} з ${progress.of}…`}
                </button>
                <button type="button" className="btn small" disabled={answer.isPending} onClick={() => setConfirmAll(false)}>
                  Скасувати
                </button>
              </>
            ) : (
              <>
                <button type="button" className="btn small" onClick={() => setConfirmAll(true)}>
                  Прийняти всі пропозиції ({acceptable.length})
                </button>
                <span className="muted small">лише «впевнено»: щонайменше 3 записи отримувача в одній категорії</span>
              </>
            )}
          </div>
        )}
        {answer.isError && <p className="note err">{describeError(answer.error)}</p>}

        <Shortcuts quick={quick} direction={focusedDirection} />

        {groups.length === 0 ? (
          <div className="empty">
            {show === 'snoozed' ? 'Відкладених немає.' : waitingRows === 0 ? 'Усе розібрано.' : 'Під ці фільтри нічого немає.'}
          </div>
        ) : (
          <div className={mode === 'compact' ? 'review-list' : 'card-list'}>
            {shown.map((group, index) => {
              const isFocused = index === focusIndex;
              const waitsFor = group.dependsOn.flatMap((key) => {
                const name = namesByKey.get(key);
                return name === undefined ? [] : [{ key, name }];
              });
              if (mode === 'full') {
                return (
                  <div
                    key={group.key}
                    data-group={group.key}
                    className={isFocused ? 'card focused' : 'card'}
                    onFocus={() => setFocusKey(group.key)}
                    onClick={() => setFocusKey(group.key)}
                  >
                    <div className="head">
                      <div>
                        <div className="t">
                          {keepTogether(group.name)} <span className="chip muted">{KIND_LABELS[group.kind]}</span>
                          {isNewGroup(group) && <span className="chip new">нове</span>}
                        </div>
                        <div className="s">{describeGroupMeta(group)}</div>
                        {waitsFor.map((other) => (
                          <button key={other.key} type="button" className="chip warn as-button" onClick={() => focusGroup(other.key, { scroll: true })}>
                            спершу «{keepTogether(other.name)}» ↑
                          </button>
                        ))}
                      </div>
                    </div>
                    {renderCard(group)}
                  </div>
                );
              }
              const open = expanded.has(group.key);
              return (
                <div
                  key={group.key}
                  data-group={group.key}
                  className={['review-row', isFocused ? 'focused' : '', open ? 'open' : ''].join(' ').trim()}
                  onFocus={() => setFocusKey(group.key)}
                >
                  <CompactRow
                    group={group}
                    draft={draftOf(group)}
                    focused={isFocused}
                    expanded={open}
                    isNew={isNewGroup(group)}
                    waitsFor={waitsFor}
                    saving={answer.isPending}
                    accounts={accounts.data}
                    categories={categories.data}
                    onFocus={() => setFocusKey(group.key)}
                    onToggle={() => toggleExpanded(group.key)}
                    onSave={() => save(group)}
                    onPick={(category) => save(group, { category })}
                    onChoose={(category) => updateDraft(group, { category })}
                    onTransfer={() => startTransfer(group)}
                    onLeave={() => leaveAsIs(group)}
                    onJump={(key) => focusGroup(key, { scroll: true })}
                  />
                  {open && renderCard(group)}
                </div>
              );
            })}
          </div>
        )}
        {groups.length > shown.length && (
          <button type="button" className="btn" style={{ marginTop: 10 }} onClick={() => setLimit(limit + PAGE_SIZE[mode])}>
            Показати ще {pluralize(groups.length - shown.length, ['групу', 'групи', 'груп'])}
          </button>
        )}
        {groups.length > 0 && (
          <p className="note" style={{ marginTop: 8 }}>
            Разом під фільтрами: {pluralize(groups.length, ['група', 'групи', 'груп'])} на ≈ {formatEur(groups.reduce((sum, group) => sum + group.totalEur, 0))}.
          </p>
        )}
      </section>
    </div>
  );
};
