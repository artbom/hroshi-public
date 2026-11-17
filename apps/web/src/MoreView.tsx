import { useEffect } from 'react';

import { pluralize } from './format.ts';
import { useReviewCount } from './queries.ts';
import { buildHref, type View } from './route.ts';

type MoreLink = { view: View; label: string; detail: string };

const PLACES: readonly MoreLink[] = [
  { view: 'accounts', label: 'Рахунки', detail: 'баланси, звірка з банком, позики й борги' },
  { view: 'review', label: 'Перевірка', detail: 'записи, які правила не розібрали' },
];

const DATA: readonly MoreLink[] = [
  { view: 'rules', label: 'Правила', detail: 'як синхронізація обирає категорію' },
  { view: 'categories', label: 'Категорії', detail: 'назви, підкатегорії, місячні орієнтири' },
  { view: 'payees', label: 'Отримувачі', detail: 'перейменувати й об’єднати отримувачів' },
  { view: 'sync', label: 'Синхронізація', detail: 'банки, біржі, довіра до даних' },
];

/** Wider than this the top tabs show every section, so «Ще» has nothing to add. */
const DESKTOP_QUERY = '(min-width: 641px)';

/** A «Ще» link opened on a wide screen (shared, bookmarked) lands on Огляд, the app's front page. */
const useDesktopRedirect = () => {
  useEffect(() => {
    const media = window.matchMedia(DESKTOP_QUERY);
    const redirect = () => {
      if (media.matches) window.location.replace(buildHref({ view: 'overview' }));
    };
    redirect();
    media.addEventListener('change', redirect);
    return () => media.removeEventListener('change', redirect);
  }, []);
};

const MoreList = ({ links, reviewCount }: { links: readonly MoreLink[]; reviewCount: number | undefined }) => (
  <div className="card">
    <div className="list">
      {links.map((link) => (
        <a key={link.view} className="row" href={buildHref({ view: link.view })}>
          <span>
            <b>{link.label}</b>
          </span>
          <span className="r">
            {link.view === 'review' && reviewCount !== undefined && reviewCount > 0 && (
              <span className="badge">{pluralize(reviewCount, ['запис', 'записи', 'записів'])}</span>
            )}{' '}
            →
          </span>
          <span className="s">{link.detail}</span>
        </a>
      ))}
    </div>
  </div>
);

/** The phone's fifth tab: everything that does not fit the bottom bar. */
export const MoreView = () => {
  const review = useReviewCount();
  useDesktopRedirect();
  return (
    <div className="view">
      <MoreList links={PLACES} reviewCount={review.data} />
      <h2 className="more-group">Дані</h2>
      <MoreList links={DATA} reviewCount={review.data} />
    </div>
  );
};
