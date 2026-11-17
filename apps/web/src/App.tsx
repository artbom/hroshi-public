import type { Month } from '@hroshi/schema';

import { AccountsView } from './accounts/AccountsView.tsx';
import { useAdd } from './components/AddContext.tsx';
import { MoreView } from './MoreView.tsx';
import { AddTransactionDrawer } from './overview/AddTransactionDrawer.tsx';
import { TransactionDrawer } from './transactions/TransactionDrawer.tsx';
import { formatMonthLong, pluralize } from './format.ts';
import { InvestmentsView } from './investments/InvestmentsView.tsx';
import { shiftMonth } from './months.ts';
import { OverviewView } from './overview/OverviewView.tsx';
import { useReviewCount } from './queries.ts';
import { ReviewView } from './review/ReviewView.tsx';
import { ThemeToggle } from './components/ThemeToggle.tsx';
import { useActiveIntoView } from './components/useActiveIntoView.ts';
import { PayeesView } from './payees/PayeesView.tsx';
import {
  buildHref,
  buildMonthQuery,
  buildTableHref,
  DATA_VIEWS,
  readRouteMonth,
  replaceRouteMonth,
  type Route,
  type View,
  useRoute,
} from './route.ts';
import { CategoriesView } from './categories/CategoriesView.tsx';
import { RulesView } from './rules/RulesView.tsx';
import { SyncView } from './sync/SyncView.tsx';
import { TableView } from './table/TableView.tsx';
import { TrendsView } from './trends/TrendsView.tsx';

const ICON_PATHS: Readonly<Record<string, string>> = {
  overview: 'M3 11l9-7 9 7v9a1 1 0 0 1-1 1h-5v-6h-6v6H4a1 1 0 0 1-1-1z',
  accounts: 'M3 6h18v12H3zM3 10h18M7 15h4',
  investments: 'M4 19l5-6 4 3 7-9M15 7h5v5',
  trends: 'M5 20V10M12 20V4M19 20v-7',
  table: 'M4 6h16M4 12h16M4 18h16',
  add: 'M12 5v14M5 12h14',
  more: 'M5 12h.01M12 12h.01M19 12h.01',
  data: 'M12 3c4.4 0 8 1.3 8 3s-3.6 3-8 3-8-1.3-8-3 3.6-3 8-3zM4 6v6c0 1.7 3.6 3 8 3s8-1.3 8-3V6M4 12v6c0 1.7 3.6 3 8 3s8-1.3 8-3v-6',
};

const SECTIONS: readonly { view: View; key: string; label: string }[] = [
  { view: 'overview', key: 'overview', label: 'Огляд' },
  { view: 'accounts', key: 'accounts', label: 'Рахунки' },
  { view: 'investments', key: 'investments', label: 'Інвестиції' },
  { view: 'trends', key: 'trends', label: 'Аналітика' },
  { view: 'table', key: 'table', label: 'Операції' },
  { view: 'review', key: 'data', label: 'Дані' },
];

/**
 * Five places on the phone bar; «+» floats above it where entries are made, so it never takes a
 * tab's slot. Рахунки and the data screens sit under «Ще», which carries the review badge.
 */
const PHONE_TABS: readonly { view: View; key: string; label: string }[] = [
  { view: 'overview', key: 'overview', label: 'Огляд' },
  { view: 'table', key: 'table', label: 'Операції' },
  { view: 'trends', key: 'trends', label: 'Аналітика' },
  { view: 'investments', key: 'investments', label: 'Інвестиції' },
  { view: 'more', key: 'more', label: 'Ще' },
];

/** Screens where a new entry is the likely next step get the floating «+». */
const ADD_VIEWS: ReadonlySet<View> = new Set(['overview', 'table', 'accounts']);

/** «Ще» stays lit on every screen it leads to, so any view the bar lacks counts as under it. */
const isPhoneTabCurrent = (tab: (typeof PHONE_TABS)[number], view: View) =>
  tab.key === 'more' ? !PHONE_TABS.some((other) => other.key !== 'more' && other.view === view) : tab.view === view;

const DATA_TABS: readonly { view: View; label: string }[] = [
  { view: 'review', label: 'Перевірка' },
  { view: 'rules', label: 'Правила' },
  { view: 'categories', label: 'Категорії' },
  { view: 'payees', label: 'Отримувачі' },
  { view: 'sync', label: 'Синхронізація' },
];

/** Only these screens are scoped to a month. */
const MONTH_VIEWS: ReadonlySet<View> = new Set(['overview', 'trends']);

/** Аналітика has its own clock (the period, which ends at the route month); only Огляд shows the header month. */
const HEADER_MONTH_VIEWS: ReadonlySet<View> = new Set(['overview']);

/**
 * Moving between month-scoped screens keeps the month; Операції opens on that month too, the way
 * Огляд's own links do, with «будь-який місяць» one click away there. Other screens have their own scope.
 */
const buildTabHref = ({ target, view, month }: { target: View; view: View; month: Month }) => {
  if (target === 'table') return buildTableHref({ from: month, to: month });
  return buildHref({ view: target, query: MONTH_VIEWS.has(target) && MONTH_VIEWS.has(view) ? buildMonthQuery(month) : {} });
};

const isCurrent = (section: (typeof SECTIONS)[number], view: View) =>
  section.key === 'data' ? DATA_VIEWS.has(view) : section.view === view;

const Icon = ({ name }: { name: string }) => (
  <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
    <path d={ICON_PATHS[name] ?? ''} />
  </svg>
);

const ReviewBadge = ({ count }: { count: number | undefined }) =>
  count !== undefined && count > 0 ? (
    <span className="badge" aria-label={`${pluralize(count, ['запис', 'записи', 'записів'])} на перевірку`}>
      {count}
    </span>
  ) : null;

const Screen = ({ route, month }: { route: Route; month: Month }) => {
  switch (route.view) {
    case 'overview':
      return <OverviewView month={month} />;
    case 'accounts':
      return <AccountsView accountId={route.param} />;
    case 'investments':
      return <InvestmentsView />;
    case 'trends':
      return <TrendsView month={month} section={route.param} />;
    case 'table':
      return <TableView query={route.query} />;
    case 'review':
      return <ReviewView />;
    case 'rules':
      return <RulesView highlight={route.query.get('rule')} />;
    case 'categories':
      return <CategoriesView />;
    case 'payees':
      return <PayeesView />;
    case 'sync':
      return <SyncView />;
    case 'more':
      return <MoreView />;
  }
};

export const App = () => {
  const route = useRoute();
  const { view } = route;
  const month = readRouteMonth(route);
  const setMonth = (next: Month) => replaceRouteMonth({ route, month: next });
  const reviewCount = useReviewCount();
  const { openAdd } = useAdd();
  const dataNav = useActiveIntoView<HTMLElement>(view);

  return (
    <div className="wrap">
      <header>
        <h1>Гроші</h1>
        <div className="header-actions">
          {HEADER_MONTH_VIEWS.has(view) && (
            <div className="month">
              <button type="button" className="btn" aria-label="Попередній місяць" onClick={() => setMonth(shiftMonth(month, -1))}>
                ‹
              </button>
              <span className="label">{formatMonthLong(month)}</span>
              <button type="button" className="btn" aria-label="Наступний місяць" onClick={() => setMonth(shiftMonth(month, 1))}>
                ›
              </button>
            </div>
          )}
          <ThemeToggle />
          <button type="button" className="btn primary add-top" onClick={() => openAdd()}>
            + Запис
          </button>
        </div>
      </header>

      <nav className="tabs" aria-label="Розділи">
        {SECTIONS.map((section) => (
          <a key={section.key} href={buildTabHref({ target: section.view, view, month })} aria-current={isCurrent(section, view) ? 'page' : undefined}>
            <Icon name={section.key} />
            {section.label}
            {section.key === 'data' && <ReviewBadge count={reviewCount.data} />}
          </a>
        ))}
      </nav>

      {DATA_VIEWS.has(view) && (
        <nav ref={dataNav} className="subnav scroll-row" aria-label="Дані">
          {DATA_TABS.map((tab) => (
            <a key={tab.view} data-chip={tab.view} href={buildHref({ view: tab.view })} aria-current={tab.view === view ? 'page' : undefined}>
              {tab.label}
              {tab.view === 'review' && <ReviewBadge count={reviewCount.data} />}
            </a>
          ))}
        </nav>
      )}

      <Screen route={route} month={month} />

      {ADD_VIEWS.has(view) && (
        <button type="button" className="fab" aria-label="Додати запис" onClick={() => openAdd()}>
          <Icon name="add" />
        </button>
      )}
      <nav className="bottom-nav" aria-label="Розділи">
        {PHONE_TABS.map((tab) => (
          <a
            key={tab.key}
            href={buildTabHref({ target: tab.view, view, month })}
            aria-current={isPhoneTabCurrent(tab, view) ? 'page' : undefined}
          >
            <Icon name={tab.key} />
            {tab.label}
            {tab.key === 'more' && <ReviewBadge count={reviewCount.data} />}
          </a>
        ))}
      </nav>
      <TransactionDrawer />
      <AddTransactionDrawer />
    </div>
  );
};
