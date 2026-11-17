import type { Category } from '@hroshi/schema';

import { formatCategoryLabel, orderCategoryTree } from './categoryTree.ts';

/**
 * Categories split the way the owner thinks of them: what money goes to, and where income comes
 * from. A subcategory follows its parent as «Подорожі / Транспорт»; the value is always the name.
 */
export const CategorySelect = ({
  categories,
  value,
  onChange,
  label = 'Категорія',
  placeholder = 'Вибери категорію',
}: {
  categories: readonly Category[];
  value: string;
  onChange: (value: string) => void;
  label?: string;
  placeholder?: string;
}) => {
  // An archived category leaves the list, except on a row that is already in it: the value must stay readable.
  const active = orderCategoryTree(categories.filter((category) => !category.archived || category.name === value));
  const renderOptions = (test: (category: Category) => boolean) =>
    active.filter(test).map((category) => (
      <option key={category.name} value={category.name}>
        {formatCategoryLabel(category)}
      </option>
    ));
  return (
    <select aria-label={label} value={value} onChange={(event) => onChange(event.target.value)}>
      <option value="" disabled>
        {placeholder}
      </option>
      <optgroup label="Витрати (і повернення в них)">{renderOptions((category) => category.forExpense)}</optgroup>
      <optgroup label="Доходи">{renderOptions((category) => category.forIncome && !category.forExpense)}</optgroup>
    </select>
  );
};
