import type { Category, CategoryUsage, CreateCategory } from '@hroshi/schema';
import { type FormEvent, useState } from 'react';

import { describeError } from '../api.ts';
import { orderCategoryTree } from '../components/categoryTree.ts';
import { SectionHead } from '../components/InfoTip.tsx';
import { formatEur, formatWhole, pluralize } from '../format.ts';
import { findCurrentMonth } from '../months.ts';
import { useCategories, useCategoryUsage, useComparison, useCreateCategory } from '../queries.ts';
import { buildHref, useRoute } from '../route.ts';
import { BudgetCard } from './BudgetCard.tsx';
import { CategorySheet } from './CategorySheet.tsx';
import { describeUsage } from './usage.ts';

/** One tappable row: the name and its marks, how much it is used, and its orientir against the usual month. */
const CategoryRow = ({
  category,
  usage,
  usualEur,
  nested,
  onOpen,
}: {
  category: Category;
  usage: CategoryUsage | undefined;
  usualEur: number | null;
  nested: boolean;
  onOpen: (name: string) => void;
}) => (
  <button type="button" className={nested ? 'cat-item nested' : 'cat-item'} onClick={() => onOpen(category.name)}>
    <span className="cat-item-name">
      <b>{category.name}</b>
      {usage?.locked === true && <span className="chip muted">запасна</span>}
      {category.forExpense && category.forIncome && <span className="chip muted">і доходи</span>}
      {!category.countsAsSpending && <span className="chip muted">не витрата</span>}
      {category.archived && category.parent !== null && <span className="muted small">у «{category.parent}»</span>}
    </span>
    <span className="cat-item-limit num">
      {category.monthlyLimitEur === null ? '' : `орієнтир ${formatEur(category.monthlyLimitEur)}`}
    </span>
    <span className="cat-item-meta">
      {[usualEur !== null && usualEur >= 1 ? `звично ${formatEur(usualEur)}/міс` : null, describeUsage(usage)]
        .filter((part) => part !== null && part !== '')
        .join(' · ')}
    </span>
  </button>
);

const NewCategoryForm = () => {
  const create = useCreateCategory();
  const [name, setName] = useState('');
  const [kind, setKind] = useState<CreateCategory['kind']>('expense');
  const submit = (event: FormEvent) => {
    event.preventDefault();
    if (name.trim() === '') return;
    create.mutate({ name: name.trim(), kind }, { onSuccess: () => setName('') });
  };
  return (
    <form className="inline-form new-category" onSubmit={submit}>
      <input aria-label="Назва нової категорії" placeholder="Нова категорія" value={name} maxLength={40} onChange={(event) => setName(event.target.value)} />
      <select aria-label="Вид нової категорії" value={kind} onChange={(event) => setKind(event.target.value === 'income' ? 'income' : 'expense')}>
        <option value="expense">витрати</option>
        <option value="income">доходи</option>
      </select>
      <button type="submit" className="btn small primary" disabled={create.isPending || name.trim() === ''}>
        Додати
      </button>
      {create.isError && <span className="note err">{describeError(create.error)}</span>}
    </form>
  );
};

const GROUPS: readonly { title: string; test: (category: Category) => boolean }[] = [
  { title: 'Витрати', test: (category) => !category.archived && category.forExpense },
  { title: 'Лише доходи', test: (category) => !category.archived && !category.forExpense },
];

/** Names, subcategories, soft monthly limits and the archive: the vocabulary every other screen uses. */
export const CategoriesView = () => {
  const categories = useCategories();
  const usage = useCategoryUsage();
  const comparison = useComparison(findCurrentMonth());
  const linked = useRoute().query.get('category');
  const [openName, setOpenName] = useState<string | null>(linked);
  const [seenLinked, setSeenLinked] = useState(linked);

  // A new #categories?category=<name> link while the screen is already open opens that category.
  if (linked !== seenLinked) {
    setSeenLinked(linked);
    if (linked !== null) setOpenName(linked);
  }
  const close = () => {
    setOpenName(null);
    // Closing a deep-linked category drops it from the address, so Back does not reopen it.
    if (linked !== null) window.location.replace(buildHref({ view: 'categories' }));
  };

  if (categories.isError) return <p className="note err">Не вдалося завантажити категорії: {describeError(categories.error)}</p>;
  if (categories.data === undefined) return <p className="note loading">Завантажую…</p>;
  const usageBy = new Map((usage.data ?? []).map((entry) => [entry.name, entry]));
  const locked = new Set((usage.data ?? []).filter((entry) => entry.locked).map((entry) => entry.name));
  const usual = comparison.data?.average.categories;
  const findUsual = (category: Category) => (category.forExpense && usual !== undefined ? (usual[category.name] ?? 0) : null);
  const limited = categories.data.filter((category) => !category.archived && category.monthlyLimitEur !== null);
  const archived = categories.data.filter((category) => category.archived);
  const opened = categories.data.find((category) => category.name === openName);

  const renderRows = (rows: readonly Category[]) => {
    const shown = new Set(rows.map((category) => category.name));
    return orderCategoryTree(rows).map((category) => (
      <CategoryRow
        key={category.name}
        category={category}
        usage={usageBy.get(category.name)}
        usualEur={findUsual(category)}
        nested={category.parent !== null && shown.has(category.parent)}
        onOpen={setOpenName}
      />
    ));
  };

  return (
    <div className="view categories-view">
      <BudgetCard />
      <section>
        <SectionHead
          title="Категорії й орієнтири"
          info={
            <>
              <p>Натисни категорію, щоб перейменувати її, вкласти в іншу, задати орієнтир чи прибрати в архів.</p>
              <p>Орієнтир — м’який місячний ліміт у євро. Огляд показує категорію, лише коли витрати підходять до орієнтира або випереджають темп місяця.</p>
              <p>«Звично» — середнє за 6 повних місяців перед поточним, з урахуванням повернень.</p>
              <p>Дочірня категорія (наприклад, «Подорожі / Транспорт») лишається собою в записах, а в Аналітиці її сума входить у батьківську. Вкладеність — один рівень.</p>
              <p>«Інше» — запасна категорія синхронізації, її не можна змінити.</p>
            </>
          }
        >
          {limited.length > 0 && (
            <span className="muted small">
              {pluralize(limited.length, ['орієнтир', 'орієнтири', 'орієнтирів'])} на{' '}
              {formatEur(limited.reduce((sum, category) => sum + (category.monthlyLimitEur ?? 0), 0))}/міс
            </span>
          )}
        </SectionHead>
        <NewCategoryForm />
      </section>
      {GROUPS.map(({ title, test }) => {
        const rows = categories.data.filter(test);
        if (rows.length === 0) return null;
        return (
          <section key={title}>
            <h2>
              {title} <span className="muted">({formatWhole(rows.length)})</span>
            </h2>
            <div className="cat-list">{renderRows(rows)}</div>
          </section>
        );
      })}
      {archived.length > 0 && (
        <section>
          <details className="fold">
            <summary>Архів ({formatWhole(archived.length)})</summary>
            <div className="cat-list" style={{ marginTop: 8 }}>
              {renderRows(archived)}
            </div>
          </details>
        </section>
      )}
      {opened !== undefined && (
        <CategorySheet
          key={opened.name}
          category={opened}
          usage={usageBy.get(opened.name)}
          usualEur={findUsual(opened)}
          categories={categories.data}
          locked={locked}
          onClose={close}
        />
      )}
    </div>
  );
};
