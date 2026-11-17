import { type Currency, CurrencySchema, type MonthBudget, type SavingsGoal } from '@hroshi/schema';
import { type FormEvent, useState } from 'react';

import { describeError } from '../api.ts';
import { SectionHead } from '../components/InfoTip.tsx';
import { LimitBar } from '../components/LimitBar.tsx';
import { formatEur, formatMoneyWhole, formatWhole } from '../format.ts';
import { useBudget, useSetSavingsGoal } from '../queries.ts';

/** Spaces and a decimal comma are how the owner types amounts. */
const parseAmount = (text: string): number | undefined => {
  const value = Number(text.replace(/\s/g, '').replace(',', '.'));
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const GoalForm = ({ goal }: { goal: SavingsGoal | null }) => {
  const save = useSetSavingsGoal();
  const saved = goal === null ? '' : formatWhole(goal.amount);
  const [text, setText] = useState(saved);
  const [currency, setCurrency] = useState<Currency>(goal?.currency ?? 'USD');
  const amount = parseAmount(text);
  const dirty = text !== saved || currency !== (goal?.currency ?? 'USD');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (amount !== undefined) save.mutate({ amount, currency });
  };
  return (
    <form className="budget-goal" onSubmit={submit}>
      <div className="limit-field">
        <label htmlFor="savings-goal">Відкладати щомісяця</label>
        <input
          id="savings-goal"
          inputMode="decimal"
          placeholder="3 000"
          value={text}
          aria-invalid={text !== '' && amount === undefined}
          onChange={(event) => setText(event.target.value)}
        />
        <select aria-label="Валюта цілі" value={currency} onChange={(event) => setCurrency(CurrencySchema.parse(event.target.value))}>
          {CurrencySchema.options.map((option) => (
            <option key={option} value={option}>
              {option}
            </option>
          ))}
        </select>
        {dirty && (
          <button type="submit" className="btn small primary" disabled={save.isPending || amount === undefined}>
            Зберегти
          </button>
        )}
      </div>
      {save.isError && <p className="note err">{describeError(save.error)}</p>}
    </form>
  );
};

/** What is left of the month's budget leads; how the budget is made sits under the bar. */
const BudgetFigures = ({ budget }: { budget: MonthBudget }) => {
  const { total, rest } = budget;
  const limitsEur = total.limitEur - rest.limitEur;
  const left = total.limitEur - total.spentEur;
  return (
    <>
      <div className="budget-head">
        <div>
          <div className="small muted">{left >= 0 ? 'Залишилось цього місяця' : 'Понад бюджет'}</div>
          <div className={left >= 0 ? 'budget-left num' : 'budget-left num neg'}>{formatEur(Math.abs(left))}</div>
        </div>
        <div className="budget-spent small muted">
          витрачено <b className="num">{formatEur(total.spentEur)}</b> з {formatEur(total.limitEur)}
          {total.projectedEur !== null && (
            <span className={total.projectedEur > total.limitEur ? 'neg' : undefined}> · прогноз {formatEur(total.projectedEur)}</span>
          )}
        </div>
      </div>
      <LimitBar share={total.limitEur > 0 ? total.spentEur / total.limitEur : 1} pace={budget.daysElapsed / budget.daysInMonth} />
      <dl className="kv">
        <dt>Бюджет на місяць</dt>
        <dd>
          {formatEur(total.limitEur)} = звичний дохід {formatEur(budget.usualIncomeEur)} − ціль {formatEur(budget.goalEur)}
        </dd>
        <dt>З нього</dt>
        <dd>
          орієнтири {formatEur(limitsEur)} · решта категорій {formatEur(rest.limitEur)}
        </dd>
      </dl>
    </>
  );
};

/** The savings goal and the month's budget it leaves; every morning's Telegram report counts against it. */
export const BudgetCard = () => {
  const budget = useBudget();
  if (budget.isError) return <p className="note err">Не вдалося завантажити бюджет: {describeError(budget.error)}</p>;
  if (budget.data === undefined) return null;
  const { goal } = budget.data;
  return (
    <section>
      <SectionHead
        title="Ціль і бюджет"
        info={
          <>
            <p>Бюджет місяця — це звичний дохід (середній за 3 повні місяці перед поточним) мінус ціль заощаджень.</p>
            <p>Категорії з орієнтиром рахуються кожна проти свого орієнтира, усе інше — проти того, що бюджет лишає після них.</p>
            <p>Щоранку о 8:00 бот надсилає в Telegram картинку бюджету на вчорашній день.</p>
          </>
        }
      >
        {goal !== null && <span className="muted small">{formatMoneyWhole(goal.amount, goal.currency)}/міс</span>}
      </SectionHead>
      <div className="card budget-card">
        {budget.data.budget === null ? (
          <p className="note">Задай ціль, і тут з’явиться бюджет місяця.</p>
        ) : (
          <BudgetFigures budget={budget.data.budget} />
        )}
        <GoalForm key={goal === null ? 'none' : `${goal.amount}${goal.currency}`} goal={goal} />
      </div>
    </section>
  );
};
