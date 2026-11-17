import { type FormEvent, type ReactNode, useState } from 'react';

import { buildHref } from '../route.ts';
import { readSavedViews, type SavedView, writeSavedViews } from './storage.ts';

/** Named filter sets: «Кафе за рік», «Оля», «Великі покупки». Clicking one applies it. */
export const SavedViews = ({ query, canSave, children }: { query: string; canSave: boolean; children?: ReactNode }) => {
  const [views, setViews] = useState(readSavedViews);
  const [naming, setNaming] = useState(false);
  const [name, setName] = useState('');
  const update = (next: SavedView[]) => {
    setViews(next);
    writeSavedViews(next);
  };

  const save = (event: FormEvent) => {
    event.preventDefault();
    const trimmed = name.trim();
    if (trimmed === '') return;
    update([...views.filter((view) => view.name !== trimmed), { name: trimmed, query }]);
    setName('');
    setNaming(false);
  };

  // Children are the reset and filter chips, which only exist while a filter is on, so canSave covers them.
  if (views.length === 0 && !canSave) return null;
  return (
    <div className="saved-views" role="group" aria-label="Збережені вигляди">
      {views.map((view) => (
        <span key={view.name} className={view.query === query ? 'view-chip active' : 'view-chip'}>
          <a href={`${buildHref({ view: 'table' })}${view.query === '' ? '' : `?${view.query}`}`} aria-current={view.query === query ? 'true' : undefined}>
            {view.name}
          </a>
          <button
            type="button"
            aria-label={`Видалити вигляд «${view.name}»`}
            onClick={() => update(views.filter((other) => other.name !== view.name))}
          >
            ✕
          </button>
        </span>
      ))}
      {canSave &&
        (naming ? (
          <form className="inline-form" onSubmit={save}>
            <input aria-label="Назва вигляду" placeholder="Назва, напр. Кафе за рік" value={name} onChange={(event) => setName(event.target.value)} />
            <button type="submit" className="btn small primary" disabled={name.trim() === ''}>
              Зберегти
            </button>
            <button type="button" className="btn small" onClick={() => setNaming(false)}>
              Скасувати
            </button>
          </form>
        ) : (
          <button type="button" className="btn small" onClick={() => setNaming(true)}>
            ☆ Зберегти вигляд
          </button>
        ))}
      {children}
    </div>
  );
};
