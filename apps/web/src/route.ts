import { type Month, MonthSchema } from '@hroshi/schema';
import { useSyncExternalStore } from 'react';

import { findCurrentMonth } from './months.ts';

export const VIEWS = [
  'overview',
  'accounts',
  'investments',
  'trends',
  'table',
  'review',
  'rules',
  'categories',
  'payees',
  'sync',
  'more',
] as const;
export type View = (typeof VIEWS)[number];

/** Screens that keep the ledger itself in shape; they share one tab. */
export const DATA_VIEWS: ReadonlySet<View> = new Set(['review', 'rules', 'categories', 'payees', 'sync']);

export type Route = { view: View; param: string | null; query: URLSearchParams };

/** `#view`, `#view/param` or `#view?key=value`, so every screen and filter has an address. */
const parseHash = (hash: string): Route => {
  const [path = '', search = ''] = hash.replace(/^#/, '').split('?');
  const [name = '', ...rest] = path.split('/');
  const view = VIEWS.find((candidate) => candidate === name) ?? 'overview';
  const param = rest.length === 0 ? null : decodeURIComponent(rest.join('/'));
  return { view, param, query: new URLSearchParams(search) };
};

export const buildHref = ({
  view,
  param = null,
  query = {},
}: {
  view: View;
  param?: string | null;
  query?: Readonly<Record<string, string | null | undefined>>;
}): string => {
  const search = new URLSearchParams();
  for (const [key, value] of Object.entries(query)) if (value) search.set(key, value);
  const suffix = search.toString();
  return `#${view}${param === null ? '' : `/${encodeURIComponent(param)}`}${suffix === '' ? '' : `?${suffix}`}`;
};

/** Operations filtered to what an aggregate is made of. */
export const buildTableHref = (filter: Readonly<Record<string, string | null | undefined>>) =>
  buildHref({ view: 'table', query: filter });

const subscribeToHash = (onChange: () => void) => {
  window.addEventListener('hashchange', onChange);
  return () => window.removeEventListener('hashchange', onChange);
};

const readHash = () => window.location.hash;

export const useRoute = (): Route => parseHash(useSyncExternalStore(subscribeToHash, readHash));

/** `?m=2026-11` on month-scoped screens, so Back after a drill-down lands on the same month. */
export const MONTH_PARAM = 'm';

/** The month a route is scoped to; without `?m=` it is the running month. */
export const readRouteMonth = (route: Route): Month => MonthSchema.safeParse(route.query.get(MONTH_PARAM)).data ?? findCurrentMonth();

/** The running month stays out of the address, so a plain `#overview` always means «now». */
export const buildMonthQuery = (month: Month): Readonly<Record<string, string | null>> => ({
  [MONTH_PARAM]: month === findCurrentMonth() ? null : month,
});

/** The same screen in another month; it replaces the history entry, so Back skips the browsing. */
export const replaceRouteMonth = ({ route, month }: { route: Route; month: Month }) => {
  const query = { ...Object.fromEntries(route.query), ...buildMonthQuery(month) };
  window.location.replace(buildHref({ view: route.view, param: route.param, query }));
};
