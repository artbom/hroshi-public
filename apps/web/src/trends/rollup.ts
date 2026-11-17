import type { Category } from '@hroshi/schema';

/** A top-level category with its subcategories rolled into it; `members` are every name whose figures it sums. */
export type CategoryGroup = { name: string; children: readonly string[]; members: readonly string[] };

/** Subcategory → parent, for the categories that have one. */
export const indexParents = (categories: readonly Category[] | undefined): ReadonlyMap<string, string> =>
  new Map((categories ?? []).flatMap((category): [string, string][] => (category.parent === null ? [] : [[category.name, category.parent]])));

/** The names that carry figures, grouped under their parents: analytics show one level, children fold into it. */
export const groupCategories = ({
  names,
  parents,
}: {
  names: Iterable<string>;
  parents: ReadonlyMap<string, string>;
}): CategoryGroup[] => {
  const groups = new Map<string, string[]>();
  for (const name of new Set(names)) {
    const parent = parents.get(name);
    const children = groups.get(parent ?? name) ?? [];
    if (parent !== undefined) children.push(name);
    groups.set(parent ?? name, children);
  }
  return [...groups].map(([name, children]) => ({ name, children, members: [name, ...children] }));
};

export const sumMembers = ({ values, members }: { values: Readonly<Record<string, number>>; members: readonly string[] }) =>
  members.reduce((sum, member) => sum + (values[member] ?? 0), 0);

/** Where refunds booked to no category live; spending tables show them as their own negative row. */
const REFUND_FALLBACK = 'Повернення';

export const findRefundCategory = (categories: readonly Category[] | undefined): string =>
  categories?.find((category) => category.incomeRole === 'refund')?.name ?? REFUND_FALLBACK;
