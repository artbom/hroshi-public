import type { Category } from '@hroshi/schema';

type Nested = Pick<Category, 'name' | 'parent'>;

/** «Подорожі / Транспорт»: a subcategory always shows with its parent, so it never reads as a top-level one. */
export const formatCategoryLabel = ({ name, parent }: Nested): string => (parent === null ? name : `${parent} / ${name}`);

/** The list order with each subcategory right after its parent; one whose parent is not in the list keeps its own place. */
export const orderCategoryTree = <T extends Nested>(categories: readonly T[]): T[] => {
  const names = new Set(categories.map((category) => category.name));
  const isNested = (category: T) => category.parent !== null && names.has(category.parent);
  const children = Map.groupBy(categories.filter(isNested), (category) => category.parent ?? '');
  return categories
    .filter((category) => !isNested(category))
    .flatMap((category) => [category, ...(children.get(category.name) ?? [])]);
};
