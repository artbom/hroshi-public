import type { AccountBalance, PlannedOverride, Recurring, RecurringPayment } from '@hroshi/schema';
import { useState } from 'react';

import { describeError } from '../api.ts';
import { SectionHead } from '../components/InfoTip.tsx';
import { formatAccountName, formatDay, formatEur, formatMoney, keepTogether, pluralize } from '../format.ts';
import { PlannedSheet } from '../planned/PlannedSheet.tsx';
import { useResetPlanned, useSavePlanned } from '../planned/queries.ts';
import { buildConfirmedTerms, sortPayments } from '../planned/terms.ts';
import { useAccounts, useCategories } from '../queries.ts';

const describeCadence = (payment: RecurringPayment) =>
  keepTogether(
    payment.status === 'confirmed' && payment.dayOfMonth !== null
      ? `щомісяця ${payment.dayOfMonth} числа`
      : `кожні ~${pluralize(Math.round(payment.cadenceDays), ['день', 'дні', 'днів'])}`,
  );

const describeNext = (payment: RecurringPayment) =>
  payment.overdueDays > 0 ? `мав бути ${formatDay(payment.nextDate)}` : `далі ${formatDay(payment.nextDate)}`;

const StateChip = ({ payment }: { payment: RecurringPayment }) => {
  if (payment.late) return <span className="chip warn">пропущено?</span>;
  if (payment.overdueDays > 0) return <span className="chip warn">{keepTogether(`прострочено ${payment.overdueDays} дн.`)}</span>;
  return null;
};

const PaymentRow = ({
  payment,
  accountName,
  onOpen,
  onConfirm,
  onIgnore,
  pending,
}: {
  payment: RecurringPayment;
  accountName: string | null;
  onOpen: () => void;
  onConfirm: () => void;
  onIgnore: () => void;
  pending: boolean;
}) => (
  <div className={payment.late ? 'planned-row late' : 'planned-row'}>
    <button type="button" className="planned-open" onClick={onOpen} aria-label={`Змінити: ${payment.name}`}>
      <span className="planned-name">
        {keepTogether(payment.name)} {payment.status === 'confirmed' && <span className="chip">підтверджено</span>} <StateChip payment={payment} />
      </span>
      <span className="s">
        {payment.category} · {describeCadence(payment)}
        {accountName !== null && payment.status === 'confirmed' && ` · ${accountName}`} · {describeNext(payment)}
        <span className="planned-last">
          {payment.occurrences > 0 ? ` · востаннє ${formatDay(payment.lastDate)}` : ' · у записах ще не було'}
        </span>
      </span>
    </button>
    <span className="num planned-amt">{formatMoney(payment.amount, payment.currency)}</span>
    <span className="planned-acts">
      {payment.status === 'detected' && (
        <>
          <button type="button" className="icon-btn" title="Підтвердити як є" aria-label={`Підтвердити: ${payment.name}`} disabled={pending} onClick={onConfirm}>
            ✓
          </button>
          <button type="button" className="icon-btn" title="Не регулярний" aria-label={`Не регулярний: ${payment.name}`} disabled={pending} onClick={onIgnore}>
            ✕
          </button>
        </>
      )}
    </span>
  </div>
);

const IgnoredList = ({ ignored, onRestore, pending }: { ignored: readonly PlannedOverride[]; onRestore: (key: string) => void; pending: boolean }) => (
  <details className="planned-ignored">
    <summary>Не регулярні ({ignored.length})</summary>
    <div className="list">
      {ignored.map((entry) => (
        <div key={entry.key} className="row">
          <span>{keepTogether(entry.name ?? entry.key)}</span>
          <span className="r">
            <button type="button" className="btn small" disabled={pending} onClick={() => onRestore(entry.key)}>
              Повернути
            </button>
          </span>
          <span className="s">
            {[entry.category, entry.amount !== null && entry.currency !== null ? formatMoney(entry.amount, entry.currency) : null]
              .filter((part) => part !== null)
              .join(' · ') || 'більше не чекається'}
          </span>
        </div>
      ))}
    </div>
  </details>
);

const findAccountName = (accounts: readonly AccountBalance[] | undefined, id: string) => {
  const account = accounts?.find((candidate) => candidate.id === id);
  return account === undefined ? null : formatAccountName(account.name);
};

export const RecurringSection = ({ recurring }: { recurring: Recurring }) => {
  const accounts = useAccounts();
  const categories = useCategories();
  const save = useSavePlanned();
  const reset = useResetPlanned();
  const [editing, setEditing] = useState<string | null>(null);
  const payments = sortPayments(recurring.payments);
  const active = payments.filter((payment) => !payment.late);
  const confirmedCount = active.filter((payment) => payment.status === 'confirmed').length;
  const overdueCount = active.filter((payment) => payment.overdueDays > 0).length;
  const edited = payments.find((payment) => payment.key === editing);
  const pending = save.isPending || reset.isPending;
  const error = save.error ?? reset.error;

  const confirmAsDetected = (payment: RecurringPayment) => {
    const terms = buildConfirmedTerms(payment);
    if (terms === null) setEditing(payment.key);
    else save.mutate(terms);
  };

  return (
    <section>
      <SectionHead
        title="Регулярні платежі"
        info={
          <>
            <p>
              З них «Огляд» рахує прогноз місяця: платіж, якого цього місяця ще немає в записах, додається як «очікується».
            </p>
            <p>
              Знайдені автоматично — витрати, що за останні пів року повторились ≥ 3 рази приблизно щомісяця (медіана 25–35 днів) і на
              схожу суму, з {formatDay(recurring.since)}. ✓ підтверджує платіж як є, ✕ — «не регулярний»: він більше не чекається.
            </p>
            <p>
              Підтверджений чекається щомісяця до свого числа; прострочені потрапляють у тижневий звіт у Telegram. «Пропущено?» —
              автоматично знайдений платіж запізнюється більш ніж на пів інтервалу: скасовано, перенесено або ще не внесено.
            </p>
          </>
        }
      />
      <div className="tiles planned-tiles">
        <div className="tile">
          <span className="k">На місяць</span>
          <span className="v num">≈ {formatEur(recurring.monthlyEur)}</span>
        </div>
        <div className="tile">
          <span className="k">Активних платежів</span>
          <span className="v num">{active.length}</span>
          <span className="small muted">{confirmedCount > 0 ? `підтверджено ${confirmedCount}` : 'ще не підтверджено'}</span>
        </div>
        {overdueCount > 0 && (
          <div className="tile">
            <span className="k">Прострочено</span>
            <span className="v num warn-text">{overdueCount}</span>
          </div>
        )}
      </div>
      {error !== null && <p className="note err">Не вдалося зберегти: {describeError(error)}</p>}
      <div className="planned-list">
        {payments.map((payment) => (
          <PaymentRow
            key={payment.key}
            payment={payment}
            accountName={findAccountName(accounts.data, payment.accountId)}
            pending={pending}
            onOpen={() => setEditing(payment.key)}
            onConfirm={() => confirmAsDetected(payment)}
            onIgnore={() => save.mutate({ key: payment.key, status: 'ignored', name: payment.name })}
          />
        ))}
      </div>
      {recurring.ignored.length > 0 && <IgnoredList ignored={recurring.ignored} pending={pending} onRestore={(key) => reset.mutate(key)} />}
      {edited !== undefined && accounts.data !== undefined && categories.data !== undefined && (
        <PlannedSheet payment={edited} accounts={accounts.data} categories={categories.data} onClose={() => setEditing(null)} />
      )}
    </section>
  );
};
