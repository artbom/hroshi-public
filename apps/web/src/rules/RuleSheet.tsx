import { type AccountBalance, type Category, type Rule, RuleInputSchema, type RulePreviewInput } from '@hroshi/schema';
import { type FormEvent, useState } from 'react';

import { describeError } from '../api.ts';
import { CategorySelect } from '../components/CategorySelect.tsx';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { useDrawer } from '../components/DrawerContext.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { formatAccountName, formatDay, formatMoney, pluralize } from '../format.ts';
import { useDeleteRule, useRulePreview, useSaveRule } from '../queries.ts';
import {
  adviseOnIssue,
  describeHits,
  describeRuleCondition,
  findIssueTone,
  ISSUE_LABELS,
  ISSUE_ORDER,
  type RuleStat,
} from './ruleText.ts';

const DEFAULT_PRIORITY = 100;

type Draft = {
  pattern: string;
  mcc: string;
  accountId: string;
  action: 'category' | 'transfer';
  category: string;
  transferToAccountId: string;
  priority: string;
  note: string;
};

const createDraft = ({
  rule,
  categories,
  accounts,
}: {
  rule: Rule | null;
  categories: readonly Category[];
  accounts: readonly AccountBalance[];
}): Draft => ({
  pattern: rule?.pattern ?? '',
  mcc: rule?.mcc === null || rule?.mcc === undefined ? '' : String(rule.mcc),
  accountId: rule?.accountId ?? '',
  action: rule !== null && rule.transferToAccountId !== null ? 'transfer' : 'category',
  category: rule?.category ?? categories.find((category) => !category.archived)?.name ?? '',
  transferToAccountId: rule?.transferToAccountId ?? accounts.find((account) => !account.archived)?.id ?? '',
  priority: String(rule?.priority ?? DEFAULT_PRIORITY),
  note: rule?.note ?? '',
});

const buildRuleInput = (draft: Draft): unknown => ({
  pattern: draft.pattern.trim() || null,
  mcc: draft.mcc.trim() === '' ? null : Number(draft.mcc),
  accountId: draft.accountId || null,
  category: draft.action === 'category' ? draft.category : null,
  transferToAccountId: draft.action === 'transfer' ? draft.transferToAccountId : null,
  priority: Number(draft.priority),
  note: draft.note.trim() || null,
});

const PreviewResult = ({ input }: { input: RulePreviewInput }) => {
  const preview = useRulePreview(input);
  const { openTransaction } = useDrawer();
  if (preview.isPending) return <p className="note">Перевіряю…</p>;
  if (preview.isError) return <p className="note err">{describeError(preview.error)}</p>;
  const { matches, waiting, categories, sample } = preview.data;
  return (
    <div className="full note">
      Зачепить {pluralize(matches, ['запис', 'записи', 'записів'])} в історії{waiting > 0 && `, з них ${waiting} чекають на перевірку`}.
      {categories.length > 0 && ` Зараз вони в: ${categories.slice(0, 5).map((entry) => `${entry.category} (${entry.count})`).join(', ')}.`}
      {sample.length > 0 && (
        <div className="list">
          {sample.map((row) => (
            <button key={row.id} type="button" className="row" onClick={() => openTransaction(row.id)}>
              <span>{row.note ?? row.bankText ?? '—'}</span>
              <span className="r num">{formatMoney(row.amount, row.currency)}</span>
              <span className="s">
                {formatDay(row.date)} · {row.category ?? row.type}
              </span>
            </button>
          ))}
        </div>
      )}
    </div>
  );
};

const IssueList = ({
  rule,
  stat,
  rules,
  onOpenRule,
}: {
  rule: Rule;
  stat: RuleStat;
  rules: ReadonlyMap<string, Rule>;
  onOpenRule: (id: string) => void;
}) => {
  const related = stat.relatedId === null ? undefined : rules.get(stat.relatedId);
  const tone = findIssueTone(stat.issues) ?? 'warn';
  return (
    <div className={`rule-advice ${tone}`}>
      {ISSUE_ORDER.filter((issue) => stat.issues.includes(issue)).map((issue) => (
        <p key={issue}>
          <span className={`chip ${tone}`}>{ISSUE_LABELS[issue]}</span> {adviseOnIssue({ issue, rule, stat, related })}
        </p>
      ))}
      {related !== undefined && (
        <button type="button" className="btn small" onClick={() => onOpenRule(related.id)}>
          Відкрити {describeRuleCondition(related)}
        </button>
      )}
    </div>
  );
};

/**
 * One rule in a sheet: what it catches, what is wrong with it, its fields and its deletion.
 * `rule` null is a new rule.
 */
export const RuleSheet = ({
  rule,
  stat,
  rules,
  accounts,
  categories,
  onOpenRule,
  onClose,
}: {
  rule: Rule | null;
  stat: RuleStat | undefined;
  rules: ReadonlyMap<string, Rule>;
  accounts: readonly AccountBalance[];
  categories: readonly Category[];
  onOpenRule: (id: string) => void;
  onClose: () => void;
}) => {
  const save = useSaveRule();
  const remove = useDeleteRule();
  const [draft, setDraft] = useState(() => createDraft({ rule, categories, accounts }));
  const [error, setError] = useState<string | null>(null);
  const [previewInput, setPreviewInput] = useState<RulePreviewInput | null>(null);
  const active = accounts.filter((account) => !account.archived || account.id === draft.transferToAccountId);
  const change = (patch: Partial<Draft>) => setDraft({ ...draft, ...patch });

  const checkHistory = () =>
    setPreviewInput({
      pattern: draft.pattern.trim().length >= 2 ? draft.pattern.trim() : null,
      mcc: draft.mcc.trim() === '' ? null : Number(draft.mcc),
      accountId: draft.accountId || null,
    });

  const submit = (event: FormEvent) => {
    event.preventDefault();
    const parsed = RuleInputSchema.safeParse(buildRuleInput(draft));
    if (!parsed.success) {
      setError(parsed.error.issues[0]?.message ?? 'Перевір поля');
      return;
    }
    save.mutate({ id: rule?.id ?? null, input: parsed.data }, { onSuccess: onClose, onError: (failure) => setError(describeError(failure)) });
  };

  return (
    <Sheet
      title={rule === null ? 'Нове правило' : describeRuleCondition(rule)}
      subtitle={rule === null ? 'Синхронізація застосує його до нових записів' : describeHits(stat)}
      onClose={onClose}
    >
      {rule !== null && stat !== undefined && stat.issues.length > 0 && (
        <IssueList rule={rule} stat={stat} rules={rules} onOpenRule={onOpenRule} />
      )}
      <form className="form" onSubmit={submit}>
        <label>
          Текст (ціле слово)
          <input value={draft.pattern} placeholder="glovo" onChange={(event) => change({ pattern: event.target.value })} />
        </label>
        <label>
          MCC
          <input inputMode="numeric" value={draft.mcc} placeholder="5411" onChange={(event) => change({ mcc: event.target.value })} />
        </label>
        <label>
          Лише для рахунку
          <select value={draft.accountId} onChange={(event) => change({ accountId: event.target.value })}>
            <option value="">будь-який</option>
            {active.map((account) => (
              <option key={account.id} value={account.id}>
                {formatAccountName(account.name)}
              </option>
            ))}
          </select>
        </label>
        <label>
          Дія
          <select value={draft.action} onChange={(event) => change({ action: event.target.value === 'transfer' ? 'transfer' : 'category' })}>
            <option value="category">категорія</option>
            <option value="transfer">переказ на рахунок</option>
          </select>
        </label>
        {draft.action === 'category' ? (
          <label>
            Категорія
            <CategorySelect categories={categories} value={draft.category} onChange={(category) => change({ category })} />
          </label>
        ) : (
          <label>
            На рахунок
            <select value={draft.transferToAccountId} onChange={(event) => change({ transferToAccountId: event.target.value })}>
              {active.map((account) => (
                <option key={account.id} value={account.id}>
                  {formatAccountName(account.name)}
                </option>
              ))}
            </select>
          </label>
        )}
        <label>
          Пріоритет (менше — раніше)
          <input inputMode="numeric" value={draft.priority} onChange={(event) => change({ priority: event.target.value })} />
        </label>
        <label className="full">
          Нотатка
          <input value={draft.note} onChange={(event) => change({ note: event.target.value })} />
        </label>
        <div className="actions">
          <button type="submit" className="btn primary" disabled={save.isPending}>
            Зберегти
          </button>
          <button type="button" className="btn" onClick={checkHistory}>
            Перевірити на історії
          </button>
          {rule !== null && (
            <ConfirmButton
              label="Видалити"
              confirmLabel="Точно видалити?"
              disabled={remove.isPending}
              onConfirm={() => remove.mutate(rule.id, { onSuccess: onClose, onError: (failure) => setError(describeError(failure)) })}
            />
          )}
          {error !== null && <span className="note err">{error}</span>}
        </div>
        {previewInput !== null && <PreviewResult input={previewInput} />}
      </form>
    </Sheet>
  );
};
