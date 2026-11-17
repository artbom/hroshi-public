import { type AccountBalance, PayeeKindSchema, type ReviewGroup } from '@hroshi/schema';
import { useState } from 'react';

import { describeError } from '../api.ts';
import { formatAccountName, formatDay } from '../format.ts';
import { findToday } from '../months.ts';
import { useSavePayeeAliases } from '../payees/queries.ts';
import { useAnswerReview } from '../queries.ts';
import { buildOwnCardAnswers, KIND_LABELS, listPlainRows, shiftDay } from './answers.ts';
import { useSnoozeReview } from './queries.ts';

/** Long enough to clear the backlog first; a new row from the payee brings the group back earlier. */
export const SNOOZE_DAYS = 30;

/** «Відкласти» parks a group for a month; on a parked one it brings it back. */
export const SnoozeButton = ({ group, compact = false }: { group: ReviewGroup; compact?: boolean }) => {
  const snooze = useSnoozeReview();
  const ids = group.rows.map((row) => row.id);
  const parked = group.snoozedUntil !== null;
  return (
    <button
      type="button"
      className={compact ? 'btn small quiet' : 'btn small'}
      disabled={snooze.isPending}
      title={parked ? `Відкладено до ${formatDay(group.snoozedUntil ?? '')}` : `Сховати на ${SNOOZE_DAYS} днів (s)`}
      onClick={(event) => {
        event.stopPropagation();
        snooze.mutate({ ids, until: parked ? null : shiftDay({ day: findToday(), days: SNOOZE_DAYS }) });
      }}
    >
      {parked ? 'Повернути' : 'Відкласти'}
    </button>
  );
};

/** Accounts a card of the owner's could belong to, the row's own currency first. */
const listCardAccounts = ({ group, accounts }: { group: ReviewGroup; accounts: readonly AccountBalance[] }) => {
  const [first] = listPlainRows(group);
  return accounts
    .filter((account) => !account.archived && account.kind !== 'investment' && account.kind !== 'receivable' && account.id !== first?.accountId)
    .toSorted((left, right) => Number(right.currency === first?.currency) - Number(left.currency === first?.currency));
};

/**
 * A masked card number may be one of the owner's own cards. Asked once: «так» books the rows as
 * transfers to that account and adds a rule for the mask; «ні» remembers the payee as a person.
 */
export const OwnCardQuestion = ({ group, accounts }: { group: ReviewGroup; accounts: readonly AccountBalance[] }) => {
  const answer = useAnswerReview();
  const save = useSavePayeeAliases();
  const [accountId, setAccountId] = useState('');
  const options = listCardAccounts({ group, accounts });
  const account = options.find((option) => option.id === accountId);
  return (
    <div className="own-card" onClick={(event) => event.stopPropagation()}>
      <span className="own-card-q">Це твоя картка?</span>
      <select aria-label="Рахунок, до якого належить картка" value={accountId} onChange={(event) => setAccountId(event.target.value)}>
        <option value="" disabled>
          так, рахунок…
        </option>
        {options.map((option) => (
          <option key={option.id} value={option.id}>
            {formatAccountName(option.name)} ({option.currency})
          </option>
        ))}
      </select>
      <button
        type="button"
        className="btn small primary"
        disabled={account === undefined || answer.isPending}
        onClick={() => {
          if (account !== undefined) answer.mutate({ answers: buildOwnCardAnswers({ group, account }) });
        }}
      >
        Так, переказ
      </button>
      <button
        type="button"
        className="btn small"
        disabled={save.isPending}
        onClick={() => save.mutate({ keys: group.bankKeys, kind: 'person' })}
      >
        Ні, не моя
      </button>
      {(answer.isError || save.isError) && <span className="note err">{describeError(answer.error ?? save.error)}</span>}
    </div>
  );
};

const OWNER_KINDS = PayeeKindSchema.options;

/** Detection reads the bank text; when it guessed wrong, the owner's word is kept on the payee. */
export const KindPicker = ({ group }: { group: ReviewGroup }) => {
  const save = useSavePayeeAliases();
  return (
    <label className="kind-picker small muted">
      Хто це:
      <select
        value={OWNER_KINDS.find((kind) => kind === group.kind) ?? ''}
        disabled={save.isPending}
        onChange={(event) => {
          const kind = OWNER_KINDS.find((entry) => entry === event.target.value);
          if (kind !== undefined) save.mutate({ keys: group.bankKeys, kind });
        }}
      >
        {!OWNER_KINDS.some((kind) => kind === group.kind) && <option value="">{KIND_LABELS[group.kind]}</option>}
        {OWNER_KINDS.map((kind) => (
          <option key={kind} value={kind}>
            {KIND_LABELS[kind]}
          </option>
        ))}
      </select>
    </label>
  );
};
