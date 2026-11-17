import {
  type AccountBalance,
  type Category,
  type CreateTransaction,
  CreateTransactionSchema,
  type QuickAdd,
  type QuickAddPayee,
  type TransactionType,
} from '@hroshi/schema';
import { type FormEvent, useRef, useState } from 'react';

import { describeError } from '../api.ts';
import { DateInput } from '../components/DateInput.tsx';
import { formatAccountName, formatDecimal, formatMoney } from '../format.ts';
import { findToday } from '../months.ts';
import { useCreateTransaction } from '../queries.ts';

const TYPE_LABELS: Readonly<Record<TransactionType, string>> = {
  expense: 'Витрата',
  income: 'Дохід',
  transfer: 'Переказ',
  valuation: 'Переоцінка',
};

const TYPE_OPTIONS: readonly TransactionType[] = ['expense', 'income', 'transfer', 'valuation'];

export type AddDraft = Draft;

type Draft = {
  type: TransactionType;
  date: string;
  accountId: string;
  amount: string;
  category: string;
  toAccountId: string;
  toAmount: string;
  note: string;
};

const parseAmount = (value: string): number => Number(value.replace(',', '.').replace(/\s/g, ''));

/** The form keeps strings; the shared schema decides what is valid. */
const buildInput = (draft: Draft): unknown => {
  const base = { date: draft.date, accountId: draft.accountId, note: draft.note.trim() || undefined };
  switch (draft.type) {
    case 'expense':
    case 'income':
      return { ...base, type: draft.type, amount: Math.abs(parseAmount(draft.amount)), category: draft.category };
    case 'transfer':
      return {
        ...base,
        type: 'transfer',
        amount: Math.abs(parseAmount(draft.amount)),
        toAccountId: draft.toAccountId,
        toAmount: draft.toAmount.trim() === '' ? undefined : parseAmount(draft.toAmount),
      };
    case 'valuation':
      return { ...base, type: 'valuation', amount: parseAmount(draft.amount) };
  }
};

const CategoryOptions = ({ type, categories }: { type: TransactionType; categories: readonly Category[] }) => {
  const active = categories.filter((category) => !category.archived);
  if (type === 'expense') {
    return active
      .filter((category) => category.forExpense)
      .map((category) => <option key={category.name}>{category.name}</option>);
  }
  // A refund or a friend paying back goes into the category of the original expense.
  return (
    <>
      {active
        .filter((category) => category.forIncome)
        .map((category) => (
          <option key={category.name}>{category.name}</option>
        ))}
      <optgroup label="Повернення в категорію витрат">
        {active
          .filter((category) => category.forExpense && !category.forIncome)
          .map((category) => (
            <option key={`refund-${category.name}`} value={category.name}>
              {category.name}
            </option>
          ))}
      </optgroup>
    </>
  );
};

const findDefaultCategory = (type: TransactionType, categories: readonly Category[]) =>
  categories.find((category) => !category.archived && (type === 'expense' ? category.forExpense : category.forIncome))
    ?.name ?? '';

const toPayeeKey = (name: string) => name.trim().toLocaleLowerCase('uk');

/** Where a new entry starts: the account and category of the latest hand entry, if both are still in use. */
const buildInitialDraft = ({
  active,
  categories,
  quickAdd,
}: {
  active: readonly AccountBalance[];
  categories: readonly Category[];
  quickAdd: QuickAdd | undefined;
}): Draft => {
  const lastAccount = active.find((account) => account.id === quickAdd?.accountId);
  const lastCategory = categories.find((category) => category.name === quickAdd?.category && !category.archived && category.forExpense);
  const accountId = lastAccount?.id ?? active[0]?.id ?? '';
  return {
    type: 'expense',
    date: findToday(),
    accountId,
    amount: '',
    category: lastCategory?.name ?? findDefaultCategory('expense', categories),
    toAccountId: active.find((account) => account.id !== accountId)?.id ?? '',
    toAmount: '',
    note: '',
  };
};

/** One tap repeats an entry the owner keeps making: a coffee in cash, the rent. */
const TemplateRow = ({ templates, onPick }: { templates: readonly QuickAddPayee[]; onPick: (template: QuickAddPayee) => void }) => (
  <div className="full">
    <div className="qa-hint">Повторити</div>
    <div className="qa-templates">
      {templates.map((template) => (
        <button
          key={`${template.name}|${template.category}|${template.accountId}`}
          type="button"
          className="qa-template"
          onClick={() => onPick(template)}
        >
          <b>{template.name}</b>
          <span className="s num">
            {formatMoney(template.amount, template.currency)} · {template.category}
          </span>
        </button>
      ))}
    </div>
  </div>
);

export const AddTransactionForm = ({
  accounts,
  categories,
  prefill,
  quickAdd,
  onSaved,
}: {
  accounts: readonly AccountBalance[];
  categories: readonly Category[];
  /** Fields to start from, e.g. an expected rent payment. */
  prefill?: Partial<Draft>;
  /** History-based defaults, payees for autocomplete and recent templates. */
  quickAdd?: QuickAdd;
  onSaved?: () => void;
}) => {
  const active = accounts.filter((account) => !account.archived);
  const [draft, setDraft] = useState<Draft>(() => ({ ...buildInitialDraft({ active, categories, quickAdd }), ...prefill }));
  /** Once the owner picks an account himself, a payee from history no longer moves it. */
  const [accountChosen, setAccountChosen] = useState(prefill?.accountId !== undefined);
  const [message, setMessage] = useState<{ text: string; error: boolean } | null>(null);
  const create = useCreateTransaction();
  const amountRef = useRef<HTMLInputElement>(null);
  const payees = new Map((quickAdd?.payees ?? []).map((payee) => [toPayeeKey(payee.name), payee]));
  const isActive = (accountId: string) => active.some((account) => account.id === accountId);

  const update = (patch: Partial<Draft>) => setDraft((current) => ({ ...current, ...patch }));
  const changeType = (type: TransactionType) => update({ type, category: findDefaultCategory(type, categories) });
  const chooseAccount = (accountId: string) => {
    setAccountChosen(true);
    update({ accountId });
  };

  /** A payee typed before fills its usual category (and account, and amount when still empty). */
  const changeNote = (note: string) => {
    const payee = draft.type === 'expense' ? payees.get(toPayeeKey(note)) : undefined;
    if (payee === undefined) {
      update({ note });
      return;
    }
    update({
      note,
      category: payee.category,
      ...(!accountChosen && isActive(payee.accountId) ? { accountId: payee.accountId } : {}),
      ...(draft.amount.trim() === '' ? { amount: formatDecimal(payee.amount, 2) } : {}),
    });
  };

  const applyTemplate = (template: QuickAddPayee) => {
    update({
      type: 'expense',
      note: template.name,
      category: template.category,
      amount: formatDecimal(template.amount, 2),
      ...(isActive(template.accountId) ? { accountId: template.accountId } : {}),
    });
    setAccountChosen(true);
    amountRef.current?.focus();
  };

  const source = active.find((account) => account.id === draft.accountId);
  const target = active.find((account) => account.id === draft.toAccountId);
  const crossCurrency = source !== undefined && target !== undefined && source.currency !== target.currency;

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = CreateTransactionSchema.safeParse(buildInput(draft));
    if (!parsed.success) {
      setMessage({ text: parsed.error.issues[0]?.message ?? 'Перевір поля', error: true });
      return;
    }
    const input: CreateTransaction = parsed.data;
    create.mutate(input, {
      onSuccess: ({ notice }) => {
        setMessage({ text: notice === null ? 'Збережено' : `Збережено. ${notice}`, error: false });
        update({ amount: '', toAmount: '', note: '' });
        amountRef.current?.focus();
        onSaved?.();
      },
      onError: (error) => setMessage({ text: `Не вдалося зберегти: ${describeError(error)}`, error: true }),
    });
  };

  const spends = draft.type === 'expense' || draft.type === 'income';
  const templates = quickAdd?.templates ?? [];

  return (
    <form className="form qa-form" onSubmit={submit}>
      {templates.length > 0 && <TemplateRow templates={templates} onPick={applyTemplate} />}
      <div className="seg" role="group" aria-label="Тип">
        {TYPE_OPTIONS.map((type) => (
          <button key={type} type="button" aria-pressed={draft.type === type} onClick={() => changeType(type)}>
            {TYPE_LABELS[type]}
          </button>
        ))}
      </div>
      <label className="qa-amount">
        {draft.type === 'valuation' ? 'Зміна оцінки (±)' : 'Сума'}
        <input
          ref={amountRef}
          // The amount is what changes every time; everything else starts from the last entry.
          autoFocus
          type="text"
          inputMode="decimal"
          required
          placeholder={source?.currency ?? ''}
          value={draft.amount}
          onChange={(event) => update({ amount: event.target.value })}
        />
      </label>
      <label>
        Дата
        <DateInput label="Дата" required value={draft.date} onChange={(date) => update({ date })} />
      </label>
      <label className="full">
        {spends ? 'Отримувач або коментар' : 'Коментар'}
        <input
          type="text"
          list={draft.type === 'expense' ? 'qa-payees' : undefined}
          autoComplete="off"
          placeholder="Кава, Mercadona, Netflix…"
          value={draft.note}
          onChange={(event) => changeNote(event.target.value)}
        />
        <span className="qa-hint">Слово «орієнтовно» в тексті позначить суму як приблизну.</span>
      </label>
      {draft.type === 'expense' && (
        <datalist id="qa-payees">
          {[...payees.values()].map((payee) => (
            <option key={payee.name} value={payee.name}>
              {payee.category}
            </option>
          ))}
        </datalist>
      )}
      {spends && (
        <label>
          Категорія
          <select value={draft.category} onChange={(event) => update({ category: event.target.value })}>
            <CategoryOptions type={draft.type} categories={categories} />
          </select>
        </label>
      )}
      <label>
        {draft.type === 'transfer' ? 'З рахунку' : 'Рахунок'}
        <select required value={draft.accountId} onChange={(event) => chooseAccount(event.target.value)}>
          {active.map((account) => (
            <option key={account.id} value={account.id}>
              {formatAccountName(account.name)} ({account.currency})
            </option>
          ))}
        </select>
      </label>
      {draft.type === 'transfer' && (
        <>
          <label>
            На рахунок
            <select value={draft.toAccountId} onChange={(event) => update({ toAccountId: event.target.value })}>
              {active.map((account) => (
                <option key={account.id} value={account.id}>
                  {formatAccountName(account.name)} ({account.currency})
                </option>
              ))}
            </select>
          </label>
          <label>
            Сума зарахування
            <input
              type="text"
              inputMode="decimal"
              required={crossCurrency}
              placeholder={crossCurrency ? `${target.currency}, 0 якщо невідомо` : 'якщо інша валюта'}
              value={draft.toAmount}
              onChange={(event) => update({ toAmount: event.target.value })}
            />
          </label>
        </>
      )}
      <div className="actions">
        <button className="btn primary" type="submit" disabled={create.isPending}>
          Зберегти
        </button>
        {message !== null && <span className={message.error ? 'note err' : 'note'}>{message.text}</span>}
      </div>
    </form>
  );
};
