import type { AccountBalance, Category, ReviewGroup, TransactionRow } from '@hroshi/schema';
import { useState } from 'react';

import { describeError } from '../api.ts';
import { CategorySelect } from '../components/CategorySelect.tsx';
import { useDrawer } from '../components/DrawerContext.tsx';
import { formatAccountName, formatDay, formatMoney, keepTogether, pluralize } from '../format.ts';
import { useMergeTransaction, useRulePreview, useUpdateTransactions } from '../queries.ts';
import { TransactionLine } from '../transactions/TransactionLine.tsx';
import {
  CONFIDENCE_LABELS,
  type Draft,
  describeGroupFlow,
  describeImpact,
  describeKindHint,
  describeRuleDefault,
  listCategorisable,
  listPlainRows,
} from './answers.ts';
import { KindPicker, OwnCardQuestion, SnoozeButton } from './GroupControls.tsx';

const parseAmount = (value: string): number => Number(value.replace(',', '.').replace(/\s/g, ''));

/** A long run of one payee shows its first rows; the rest fold away. */
const VISIBLE_ROWS = 3;

const TwinPanel = ({ row, label }: { row: TransactionRow; label: string }) => {
  const { openTransaction } = useDrawer();
  return (
    <div>
      <div className="small muted">{label}</div>
      <button type="button" className="cell-link" onClick={() => openTransaction(row.id)}>
        <b>{keepTogether(row.note ?? row.category ?? 'Без опису')}</b>
      </button>
      <div className="num">{formatMoney(row.amount, row.currency)}</div>
      <div className="small muted">
        {formatDay(row.date)} · {row.category ?? row.type}
      </div>
    </div>
  );
};

const DuplicatePair = ({ row, twin }: { row: TransactionRow; twin: TransactionRow }) => {
  const merge = useMergeTransaction();
  const update = useUpdateTransactions();
  return (
    <div className="card" style={{ background: 'var(--bg)' }}>
      <span className="note">Схоже на один запис двічі: рядок банку і запис, внесений вручну.</span>
      <div className="twin">
        <TwinPanel row={row} label="З банку" />
        <TwinPanel row={twin} label="Вручну" />
      </div>
      <div className="inline-form">
        <button type="button" className="btn small primary" disabled={merge.isPending} onClick={() => merge.mutate({ id: row.id, intoId: twin.id })}>
          Об’єднати (залишити ручний, прив’язати банк)
        </button>
        <button type="button" className="btn small" disabled={update.isPending} onClick={() => update.mutate({ ids: [row.id], patch: { needsReview: false } })}>
          Це різні записи
        </button>
      </div>
      {merge.isError && <p className="note err">{describeError(merge.error)}</p>}
    </div>
  );
};

/**
 * A refund or cancellation nets out only in its purchase's category. While the purchase itself
 * waits for an answer there is no category to send it to, so the hint points there first.
 */
const PairHint = ({ row, pair, onJump }: { row: TransactionRow; pair: TransactionRow; onJump: (() => void) | null }) => {
  const update = useUpdateTransactions();
  if (pair.needsReview) {
    return (
      <div className="inline-form small">
        <span className="note">
          Це повернення за покупку «{keepTogether(pair.note ?? '—')}» {formatMoney(pair.amount, pair.currency)} від {formatDay(pair.date)}, яка
          сама ще без категорії. Спершу розбери покупку.
        </span>
        {onJump !== null && (
          <button type="button" className="btn small" onClick={onJump}>
            До покупки ↑
          </button>
        )}
      </div>
    );
  }
  const category = pair.category ?? 'Інше';
  return (
    <div className="inline-form small">
      <span className="note">
        Повернення за покупку «{keepTogether(pair.note ?? '—')}» {formatMoney(pair.amount, pair.currency)} від {formatDay(pair.date)}: віднести до «
        {category}», щоб вони погасили одна одну.
      </span>
      <button
        type="button"
        className="btn small"
        disabled={update.isPending}
        onClick={() => update.mutate({ ids: [row.id], patch: { type: 'income', category } })}
      >
        Так, до «{category}»
      </button>
    </div>
  );
};

const TransferForm = ({ group, accounts, ids }: { group: ReviewGroup; accounts: readonly AccountBalance[]; ids: readonly string[] }) => {
  const update = useUpdateTransactions();
  // An ATM withdrawal goes to the cash account in the row's currency, so it is picked already.
  const [toAccountId, setToAccountId] = useState(() =>
    group.kind === 'cash'
      ? (accounts.find((account) => account.kind === 'cash' && !account.archived && account.currency === group.rows[0]?.currency)?.id ?? '')
      : '',
  );
  const [toAmount, setToAmount] = useState('');
  const [first] = listPlainRows(group);
  const target = accounts.find((account) => account.id === toAccountId);
  const crossCurrency = first !== undefined && target !== undefined && target.currency !== first.currency;
  const active = accounts.filter((account) => !account.archived && account.id !== first?.accountId);
  return (
    <div className="inline-form">
      <select
        aria-label="Переказ на свій рахунок (t)"
        data-transfer={group.key}
        value={toAccountId}
        onChange={(event) => setToAccountId(event.target.value)}
      >
        <option value="" disabled>
          Це переказ на свій рахунок…
        </option>
        {active.map((account) => (
          <option key={account.id} value={account.id}>
            {formatAccountName(account.name)} ({account.currency})
          </option>
        ))}
      </select>
      {crossCurrency && (
        <input
          type="text"
          inputMode="decimal"
          aria-label="Сума зарахування"
          placeholder={`${target.currency}, 0 якщо невідомо`}
          value={toAmount}
          onChange={(event) => setToAmount(event.target.value)}
        />
      )}
      <button
        type="button"
        className="btn small"
        disabled={update.isPending || toAccountId === '' || ids.length === 0}
        onClick={() =>
          update.mutate({
            ids,
            patch: { type: 'transfer', toAccountId, toAmount: crossCurrency && toAmount.trim() !== '' ? parseAmount(toAmount) : null },
          })
        }
      >
        Записати як переказ
      </button>
      <button type="button" className="btn small" disabled={update.isPending || ids.length === 0} onClick={() => update.mutate({ ids, patch: { needsReview: false } })}>
        Залишити як є (x)
      </button>
      {update.isError && <p className="note err">{describeError(update.error)}</p>}
    </div>
  );
};

/** Everything about one payee's rows: each row, duplicates, refund pairs, the category and an optional rule. */
export const GroupCard = ({
  group,
  draft,
  onDraft,
  onSave,
  saving,
  accounts,
  categories,
  names,
  onJump,
  showImpact,
}: {
  group: ReviewGroup;
  draft: Draft;
  onDraft: (patch: Partial<Draft>) => void;
  onSave: () => void;
  saving: boolean;
  accounts: readonly AccountBalance[];
  categories: readonly Category[];
  names: ReadonlyMap<string, string>;
  /** Moves the focus to the group another one waits for. */
  onJump: (key: string) => void;
  /** The compact row above already says what leaving the group costs. */
  showImpact: boolean;
}) => {
  const [showAll, setShowAll] = useState(false);
  const pairs = group.rows.filter((row) => group.twins[row.id] !== undefined);
  const plain = listPlainRows(group);
  const chosen = plain.filter((row) => !draft.excluded.has(row.id));
  const categorisable = listCategorisable({ group, draft });
  const reasons = new Set(plain.map((row) => row.reviewReason));
  const [onlyReason] = reasons;
  const sharedReason = plain.length > 1 && reasons.size === 1 && onlyReason != null ? onlyReason : null;
  const pattern = draft.pattern.trim();
  const preview = useRulePreview(draft.makeRule && pattern.length >= 2 ? { pattern, mcc: null, accountId: null } : null);
  const ruleDefault = describeRuleDefault(group);
  const impact = showImpact ? describeImpact(group.impact) : null;
  const hint = describeKindHint(group.kind);
  const [jumpTo] = group.dependsOn;
  const askCard = group.kind === 'card' && !group.kindByOwner;
  // In «Докладно» the card is the only place with «Відкласти», so it sits beside «Зберегти»; in the
  // compact list the row above already has it.
  const snoozeBesideSave = showImpact && plain.length > 0 && categorisable.length > 0;

  const toggle = (id: string) => {
    const excluded = new Set(draft.excluded);
    if (excluded.has(id)) excluded.delete(id);
    else excluded.add(id);
    onDraft({ excluded });
  };

  return (
    <div className="group-body">
      {impact !== null && <p className="note impact">{impact}</p>}
      {showImpact && hint !== null && <p className="note">{hint}</p>}
      {askCard && <OwnCardQuestion group={group} accounts={accounts} />}
      {pairs.map((row) => {
        const twin = group.twins[row.id];
        return twin === undefined ? null : <DuplicatePair key={row.id} row={row} twin={twin} />;
      })}
      {plain.length > 0 && (
        <>
          {sharedReason !== null && <p className="note">{keepTogether(sharedReason)}</p>}
          <div>
            {(showAll ? plain : plain.slice(0, VISIBLE_ROWS)).map((row) => {
              const pair = group.pairs[row.id];
              return (
                <div key={row.id}>
                  <label className="small muted row-pick">
                    <input
                      type="checkbox"
                      checked={!draft.excluded.has(row.id)}
                      onChange={() => toggle(row.id)}
                      aria-label={`Застосувати відповідь до запису від ${formatDay(row.date)}`}
                    />
                    {formatDay(row.date)}
                    {sharedReason === null && row.reviewReason !== null && ` · ${keepTogether(row.reviewReason)}`}
                  </label>
                  <TransactionLine transaction={row} accountNames={names} />
                  {pair !== undefined && (
                    <PairHint row={row} pair={pair} onJump={jumpTo === undefined ? null : () => onJump(jumpTo)} />
                  )}
                </div>
              );
            })}
            {plain.length > VISIBLE_ROWS && !showAll && (
              <button type="button" className="btn small" style={{ marginTop: 6 }} onClick={() => setShowAll(true)}>
                Показати ще {pluralize(plain.length - VISIBLE_ROWS, ['запис', 'записи', 'записів'])}
              </button>
            )}
          </div>
          {categorisable.length > 0 && (
            <>
              {group.suggestion !== null && (
                <p className="note">
                  Пропозиція: <b>{group.suggestion.category}</b>{' '}
                  <span className={`chip confidence ${group.suggestion.confidence}`}>{CONFIDENCE_LABELS[group.suggestion.confidence]}</span>{' '}
                  — {keepTogether(group.suggestion.reason)}.
                </p>
              )}
              {draft.category === '' && group.candidates.length > 0 && (
                <div className="pick-chips" aria-label="Часті категорії">
                  <span className="pick-chips-label">часто:</span>
                  {group.candidates.map((category) => (
                    <button key={category} type="button" className="btn small" onClick={() => onDraft({ category })}>
                      {category}
                    </button>
                  ))}
                </div>
              )}
              <div className="inline-form">
                <CategorySelect categories={categories} value={draft.category} onChange={(category) => onDraft({ category })} />
                <button type="button" className="btn small primary" disabled={saving || draft.category === ''} onClick={onSave}>
                  Зберегти{categorisable.length > 1 ? ` для ${categorisable.length}` : ''} (Enter)
                </button>
                {snoozeBesideSave && <SnoozeButton group={group} />}
              </div>
              <div className="inline-form small">
                <label className="row-pick">
                  <input type="checkbox" checked={draft.makeRule} onChange={(event) => onDraft({ makeRule: event.target.checked })} />
                  Правило для наступних (r):
                </label>
                <input
                  aria-label="Текст правила"
                  value={draft.pattern}
                  disabled={!draft.makeRule}
                  onChange={(event) => onDraft({ pattern: event.target.value })}
                />
                {draft.makeRule && preview.data !== undefined && (
                  <span className={preview.data.matches > group.rows.length * 3 ? 'check-bad' : 'muted'}>
                    зачепить {pluralize(preview.data.matches, ['запис', 'записи', 'записів'])} в історії
                    {preview.data.categories.length > 1 && ` (зараз у ${preview.data.categories.length} категоріях)`}
                  </span>
                )}
                {ruleDefault !== null && !draft.makeRule && <span className="muted">{ruleDefault}</span>}
              </div>
            </>
          )}
          <TransferForm group={group} accounts={accounts} ids={chosen.map((row) => row.id)} />
        </>
      )}
      <div className="group-foot">
        <KindPicker group={group} />
        {!snoozeBesideSave && <SnoozeButton group={group} />}
      </div>
    </div>
  );
};

export const describeGroupMeta = (group: ReviewGroup) =>
  `${pluralize(group.rows.length, ['запис', 'записи', 'записів'])} · ${describeGroupFlow(group)} · останній ${formatDay(group.latestDate)}`;
