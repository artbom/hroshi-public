import type { Category, CategoryUsage, UpdateCategory } from '@hroshi/schema';
import { type FormEvent, useState } from 'react';

import { describeError } from '../api.ts';
import { formatCategoryLabel } from '../components/categoryTree.ts';
import { ConfirmButton } from '../components/ConfirmButton.tsx';
import { Sheet } from '../components/Sheet.tsx';
import { formatWhole, pluralize } from '../format.ts';
import { useSetCategoryLimit, useUpdateCategory } from '../queries.ts';
import { buildTableHref } from '../route.ts';
import { describeUsage } from './usage.ts';

const parseLimit = (text: string): number | null | undefined => {
  const cleaned = text.replace(/\s/g, '').replace(',', '.');
  if (cleaned === '') return null;
  const value = Number(cleaned);
  return Number.isFinite(value) && value > 0 ? value : undefined;
};

const isSameKind = (left: Category, right: Category) => left.forExpense === right.forExpense && left.forIncome === right.forIncome;

const LimitField = ({ category, usualEur }: { category: Category; usualEur: number | null }) => {
  const save = useSetCategoryLimit();
  const saved = category.monthlyLimitEur === null ? '' : formatWhole(category.monthlyLimitEur);
  const [text, setText] = useState(saved);
  const parsed = parseLimit(text);
  const dirty = parsed !== (category.monthlyLimitEur ?? null) && text !== saved;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (parsed !== undefined) save.mutate({ name: category.name, monthlyLimitEur: parsed });
  };
  return (
    <form className="sheet-block" onSubmit={submit}>
      <h4>Орієнтир на місяць</h4>
      <div className="limit-field">
        <label>
          <span className="sr-only">Орієнтир для «{category.name}», € на місяць</span>
          <input inputMode="decimal" placeholder="—" value={text} aria-invalid={parsed === undefined} onChange={(event) => setText(event.target.value)} />
        </label>
        <span className="muted small">€/міс</span>
        {dirty && (
          <button type="submit" className="btn small primary" disabled={save.isPending || parsed === undefined}>
            {parsed === null ? 'Прибрати' : 'Зберегти'}
          </button>
        )}
      </div>
      <p className="note">
        М’який ліміт: Огляд показує категорію, коли витрати підходять до нього.
        {usualEur !== null && usualEur >= 1 && ` Звично — ${formatWhole(usualEur)} €/міс.`}
      </p>
      {save.isError && <p className="note err">{describeError(save.error)}</p>}
    </form>
  );
};

/** Name and parent are saved together; only what changed is sent. */
const NameForm = ({
  category,
  usage,
  categories,
  subcategories,
  locked,
  onDone,
}: {
  category: Category;
  usage: CategoryUsage | undefined;
  categories: readonly Category[];
  subcategories: readonly Category[];
  /** The sync fallback: nothing nests under it. */
  locked: ReadonlySet<string>;
  onDone: () => void;
}) => {
  const update = useUpdateCategory();
  const [name, setName] = useState(category.name);
  const [parent, setParent] = useState(category.parent ?? '');
  const parents = categories.filter(
    (candidate) =>
      candidate.name === category.parent ||
      (candidate.name !== category.name &&
        !candidate.archived &&
        !locked.has(candidate.name) &&
        candidate.parent === null &&
        isSameKind(candidate, category)),
  );
  const nextName = name.trim();
  const patch: UpdateCategory = {
    ...(nextName !== '' && nextName !== category.name ? { name: nextName } : {}),
    ...(parent !== (category.parent ?? '') ? { parent: parent === '' ? null : parent } : {}),
  };
  const changed = Object.keys(patch).length > 0;
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (changed) update.mutate({ name: category.name, patch }, { onSuccess: onDone });
  };

  return (
    <form className="form sheet-form" onSubmit={submit}>
      <label className="full">
        Назва
        <input value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      </label>
      {patch.name !== undefined && usage !== undefined && (usage.rows > 0 || usage.rules > 0) && (
        <p className="full note">
          Разом із назвою переїдуть {pluralize(usage.rows, ['запис', 'записи', 'записів'])} і{' '}
          {pluralize(usage.rules, ['правило', 'правила', 'правил'])}.
        </p>
      )}
      <label className="full">
        Батьківська категорія
        <select value={parent} disabled={subcategories.length > 0} onChange={(event) => setParent(event.target.value)}>
          <option value="">— немає, це категорія верхнього рівня</option>
          {parents.map((candidate) => (
            <option key={candidate.name} value={candidate.name}>
              {candidate.name}
            </option>
          ))}
        </select>
      </label>
      <p className="full note">
        {subcategories.length > 0
          ? `Уже батьківська для: ${subcategories.map((child) => child.name).join(', ')}. Вкладеність — лише один рівень.`
          : 'Дочірня категорія лишається собою в записах, а в Аналітиці її сума входить у батьківську.'}
      </p>
      <div className="actions">
        <button type="submit" className="btn primary" disabled={!changed || update.isPending}>
          Зберегти
        </button>
        {update.isError && <span className="note err">{describeError(update.error)}</span>}
      </div>
    </form>
  );
};

/** One category in a sheet: name, parent, monthly orientir, archive. */
export const CategorySheet = ({
  category,
  usage,
  usualEur,
  categories,
  locked,
  onClose,
}: {
  category: Category;
  usage: CategoryUsage | undefined;
  usualEur: number | null;
  categories: readonly Category[];
  locked: ReadonlySet<string>;
  onClose: () => void;
}) => {
  const update = useUpdateCategory();
  const isLocked = locked.has(category.name);
  const subcategories = categories.filter((candidate) => candidate.parent === category.name);
  const limited = category.forExpense && !category.archived && category.countsAsSpending;
  const archive = (archived: boolean) => update.mutate({ name: category.name, patch: { archived } }, { onSuccess: onClose });

  return (
    <Sheet
      title={formatCategoryLabel(category)}
      subtitle={
        <>
          {describeUsage(usage)} ·{' '}
          <a className="link" href={buildTableHref({ category: category.name })}>
            записи →
          </a>
        </>
      }
      onClose={onClose}
    >
      {isLocked ? (
        <p className="note">«{category.name}» — запасна категорія синхронізації: її не можна перейменувати, вкласти чи архівувати.</p>
      ) : (
        !category.archived && (
          <NameForm
            key={`${category.name}:${category.parent ?? ''}`}
            category={category}
            usage={usage}
            categories={categories}
            subcategories={subcategories}
            locked={locked}
            onDone={onClose}
          />
        )
      )}
      {limited && <LimitField key={`${category.name}:${category.monthlyLimitEur ?? ''}`} category={category} usualEur={usualEur} />}
      {!isLocked && (
        <div className="sheet-block">
          <h4>Архів</h4>
          <p className="note">Архів лише ховає категорію з виборів; записи й правила лишаються в ній.</p>
          <div className="actions">
            {category.archived ? (
              <button type="button" className="btn" disabled={update.isPending} onClick={() => archive(false)}>
                Повернути з архіву
              </button>
            ) : (
              <ConfirmButton label="В архів" confirmLabel="Точно в архів?" disabled={update.isPending} onConfirm={() => archive(true)} />
            )}
            {update.isError && <span className="note err">{describeError(update.error)}</span>}
          </div>
        </div>
      )}
    </Sheet>
  );
};
