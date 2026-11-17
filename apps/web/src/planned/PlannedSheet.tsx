import {
  type AccountBalance,
  type Category,
  type Currency,
  CurrencySchema,
  PlannedInputSchema,
  type RecurringPayment,
} from '@hroshi/schema';
import { type FormEvent, useEffect, useRef, useState } from 'react';

import { describeError } from '../api.ts';
import { formatAccountName, formatDay, formatDecimal, formatMoney, pluralize } from '../format.ts';
import { buildTableHref } from '../route.ts';
import { useResetPlanned, useSavePlanned } from './queries.ts';
import { findPaymentDay } from './terms.ts';

type Draft = { name: string; amount: string; currency: Currency; dayOfMonth: string; accountId: string; category: string };

const parseAmount = (value: string): number => Number(value.replace(',', '.').replace(/\s/gu, ''));

const describeHistory = (payment: RecurringPayment): string => {
  if (payment.occurrences === 0) return 'За останні пів року в записах його не було.';
  const times = pluralize(payment.occurrences, ['раз', 'рази', 'разів']);
  return payment.status === 'confirmed'
    ? `За пів року в записах ${times}, востаннє ${formatDay(payment.lastDate)}.`
    : `Знайдено в записах ${times}, кожні ~${pluralize(Math.round(payment.cadenceDays), ['день', 'дні', 'днів'])}, востаннє ${formatDay(payment.lastDate)}.`;
};

const describeDue = (payment: RecurringPayment): string =>
  payment.late
    ? `Мав бути ${formatDay(payment.nextDate)} — давно немає: скасовано, на іншій картці чи ще не внесено?`
    : payment.overdueDays > 0
      ? `Прострочено ${pluralize(payment.overdueDays, ['день', 'дні', 'днів'])}: мав бути ${formatDay(payment.nextDate)}.`
      : `Наступний — ${formatDay(payment.nextDate)}.`;

/** The owner's word on one recurring payment: his terms, «не регулярний», or back to detection. */
export const PlannedSheet = ({
  payment,
  accounts,
  categories,
  onClose,
}: {
  payment: RecurringPayment;
  accounts: readonly AccountBalance[];
  categories: readonly Category[];
  onClose: () => void;
}) => {
  const active = accounts.filter((account) => !account.archived);
  const expenseCategories = categories.filter((category) => !category.archived && category.forExpense);
  const [draft, setDraft] = useState<Draft>(() => ({
    name: payment.name,
    amount: formatDecimal(payment.amount, 2),
    currency: payment.currency,
    dayOfMonth: String(findPaymentDay(payment)),
    accountId: active.some((account) => account.id === payment.accountId) ? payment.accountId : (active[0]?.id ?? ''),
    category: expenseCategories.some((category) => category.name === payment.category)
      ? payment.category
      : (expenseCategories[0]?.name ?? ''),
  }));
  const [message, setMessage] = useState<string | null>(null);
  const save = useSavePlanned();
  const reset = useResetPlanned();
  const closeRef = useRef<HTMLButtonElement>(null);
  const confirmed = payment.status === 'confirmed';
  const pending = save.isPending || reset.isPending;

  // The close button, not a field: on a phone a focused field would throw up the keyboard over the facts.
  useEffect(() => closeRef.current?.focus(), []);

  useEffect(() => {
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') onClose();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const fail = (error: unknown) => setMessage(`Не вдалося зберегти: ${describeError(error)}`);

  const confirm = (event: FormEvent) => {
    event.preventDefault();
    const parsed = PlannedInputSchema.safeParse({
      key: payment.key,
      status: 'confirmed',
      name: draft.name.trim() === '' ? undefined : draft.name.trim(),
      amount: parseAmount(draft.amount),
      currency: draft.currency,
      dayOfMonth: Number(draft.dayOfMonth),
      accountId: draft.accountId,
      category: draft.category,
    });
    if (!parsed.success) {
      setMessage('Перевір суму (більше нуля) і день місяця (1–31).');
      return;
    }
    save.mutate(parsed.data, { onSuccess: onClose, onError: fail });
  };

  const ignore = () => save.mutate({ key: payment.key, status: 'ignored', name: payment.name }, { onSuccess: onClose, onError: fail });

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer planned-sheet" role="dialog" aria-modal="true" aria-labelledby="planned-title">
        <div className="drawer-head">
          <h3 id="planned-title">{payment.name}</h3>
          <button type="button" className="close" ref={closeRef} aria-label="Закрити" onClick={onClose}>
            ✕
          </button>
          <div className="small muted planned-sheet-sub">
            {confirmed ? (
              <span className="chip">підтверджено</span>
            ) : (
              <span className="chip muted">знайдено автоматично</span>
            )}{' '}
            {formatMoney(payment.amount, payment.currency)} · {payment.category}
          </div>
        </div>

        <div className="planned-facts">
          <p className={payment.late || payment.overdueDays > 0 ? 'warn-text' : undefined}>{describeDue(payment)}</p>
          <p className="muted">{describeHistory(payment)}</p>
          <a href={buildTableHref({ payee: payment.key })} onClick={onClose}>
            Записи цього отримувача →
          </a>
        </div>

        <form className="form planned-form" onSubmit={confirm}>
          <label className="full">
            Назва
            <input type="text" value={draft.name} onChange={(event) => update({ name: event.target.value })} />
          </label>
          <label>
            Сума
            <input
              type="text"
              inputMode="decimal"
              required
              value={draft.amount}
              onChange={(event) => update({ amount: event.target.value })}
            />
          </label>
          <label>
            Валюта
            <select
              value={draft.currency}
              onChange={(event) => update({ currency: CurrencySchema.catch(draft.currency).parse(event.target.value) })}
            >
              {CurrencySchema.options.map((currency) => (
                <option key={currency}>{currency}</option>
              ))}
            </select>
          </label>
          <label>
            Число місяця
            <input
              type="number"
              inputMode="numeric"
              min={1}
              max={31}
              required
              value={draft.dayOfMonth}
              onChange={(event) => update({ dayOfMonth: event.target.value })}
            />
          </label>
          <label>
            Рахунок
            <select required value={draft.accountId} onChange={(event) => update({ accountId: event.target.value })}>
              {active.map((account) => (
                <option key={account.id} value={account.id}>
                  {formatAccountName(account.name)} ({account.currency})
                </option>
              ))}
            </select>
          </label>
          <label className="full">
            Категорія
            <select required value={draft.category} onChange={(event) => update({ category: event.target.value })}>
              {expenseCategories.map((category) => (
                <option key={category.name}>{category.name}</option>
              ))}
            </select>
          </label>
          <p className="full small muted planned-hint">
            Підтверджений платіж чекається щомісяця до цього числа, поки не з’явиться в записах, і потрапляє в прогноз місяця та в
            тижневий звіт у Telegram, коли прострочений.
          </p>
          <div className="actions">
            <button className="btn primary" type="submit" disabled={pending}>
              {confirmed ? 'Зберегти' : 'Підтвердити'}
            </button>
            <button className="btn" type="button" disabled={pending} onClick={ignore}>
              Не регулярний
            </button>
            {confirmed && (
              <button
                className="btn"
                type="button"
                disabled={pending}
                onClick={() => reset.mutate(payment.key, { onSuccess: onClose, onError: fail })}
              >
                Скинути до автовизначення
              </button>
            )}
          </div>
          {message !== null && <p className="full note err">{message}</p>}
        </form>
      </aside>
    </>
  );
};
