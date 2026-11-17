import { type AccountBalance, UpdateLoanSchema } from '@hroshi/schema';
import { type FormEvent, useState } from 'react';

import { describeError } from '../api.ts';
import { SectionHead } from '../components/InfoTip.tsx';
import { formatDay, formatMoney, pluralize } from '../format.ts';
import { useInvestments } from '../queries.ts';
import { DateInput } from '../components/DateInput.tsx';
import { findDue, findLastRepayment } from './loans.ts';
import { useUpdateLoan } from './queries.ts';

/** A loan's who and when, what went out and what came back, with a form to set the first two. */
export const LoanTerms = ({ account }: { account: AccountBalance }) => {
  const investments = useInvestments();
  const update = useUpdateLoan();
  const [counterparty, setCounterparty] = useState(account.counterparty ?? '');
  const [dueDate, setDueDate] = useState(account.dueDate ?? '');
  const loan = [...(investments.data?.loans ?? []), ...(investments.data?.debts ?? [])].find(
    (candidate) => candidate.account.id === account.id,
  );
  const due = findDue(account);
  const lastRepayment = loan === undefined ? undefined : findLastRepayment(loan);
  const owe = account.balance < 0;
  const changed = counterparty.trim() !== (account.counterparty ?? '') || dueDate !== (account.dueDate ?? '');
  const parsed = UpdateLoanSchema.safeParse({ counterparty, dueDate: dueDate === '' ? null : dueDate });
  const [touched, setTouched] = useState(false);
  const problem = parsed.success ? null : (parsed.error.issues[0]?.message ?? 'Перевір поля');

  const submit = (event: FormEvent) => {
    event.preventDefault();
    setTouched(true);
    if (parsed.success) update.mutate({ id: account.id, patch: parsed.data });
  };

  return (
    <section>
      <SectionHead
        title={owe ? 'Борг' : 'Позика'}
        info={
          <p>
            {owe
              ? 'Мінус — ти винен. Платіж на цей рахунок гасить борг.'
              : 'Гроші, які винні тобі. Повернення — переказ з цього рахунку на твій, його видно в записах нижче.'}
          </p>
        }
      />
      <dl className="facts">
        <dt>{owe ? 'Кому' : 'Хто винен'}</dt>
        <dd>{account.counterparty ?? <span className="chip warn">не вказано — впиши нижче</span>}</dd>
        <dt>Повернути до</dt>
        <dd>
          {account.dueDate === null ? (
            <span className="muted">без строку</span>
          ) : (
            <>
              {formatDay(account.dueDate)}
              {due !== null && due.overdueDays > 0 && (
                <span className="chip warn"> прострочено {pluralize(due.overdueDays, ['день', 'дні', 'днів'])}</span>
              )}
            </>
          )}
        </dd>
        {loan !== undefined && (
          <>
            <dt>{owe ? 'Винен усього' : 'Позичено'}</dt>
            <dd className="num">{formatMoney(loan.lent, account.currency)}</dd>
            <dt>Повернуто</dt>
            <dd className="num">
              {formatMoney(loan.repaid, account.currency)}
              {lastRepayment === undefined ? (
                <span className="muted"> · повернень ще не було</span>
              ) : (
                <span className="muted"> · востаннє {formatDay(lastRepayment.date)}</span>
              )}
            </dd>
          </>
        )}
      </dl>
      <form className="loan-form" onSubmit={submit}>
        <label>
          <span className="small muted">{owe ? 'Кому' : 'Хто винен'}</span>
          <input
            value={counterparty}
            maxLength={80}
            required
            placeholder="Ім’я"
            aria-invalid={touched && problem !== null ? true : undefined}
            onChange={(event) => setCounterparty(event.target.value)}
            onBlur={() => setTouched(true)}
          />
        </label>
        <label>
          <span className="small muted">Повернути до</span>
          <DateInput label="Повернути до" value={dueDate} onChange={setDueDate} />
        </label>
        <button type="submit" className="btn small primary" disabled={!changed || !parsed.success || update.isPending}>
          Зберегти
        </button>
      </form>
      {touched && problem !== null && <p className="note err">{problem}</p>}
      {update.isError && <p className="note err">{describeError(update.error)}</p>}
    </section>
  );
};
