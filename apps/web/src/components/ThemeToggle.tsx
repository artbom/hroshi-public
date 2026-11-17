import { useState } from 'react';

import { readStoredTheme, storeTheme, type Theme, THEMES } from './theme.ts';

const LABELS: Readonly<Record<Theme, string>> = { system: 'як у системі', light: 'світла', dark: 'темна' };

const ICON_PATHS: Readonly<Record<Theme, string>> = {
  system: 'M12 3a9 9 0 0 1 0 18a9 9 0 0 1 0-18z',
  light: 'M12 8a4 4 0 1 0 0 8 4 4 0 0 0 0-8zM12 2v2M12 20v2M4.9 4.9l1.4 1.4M17.7 17.7l1.4 1.4M2 12h2M20 12h2M4.9 19.1l1.4-1.4M17.7 6.3l1.4-1.4',
  dark: 'M20 14.5A8 8 0 0 1 9.5 4 8 8 0 1 0 20 14.5z',
};

/** «Follows the system» reads as a half-dark disc. */
const SYSTEM_HALF = 'M12 3a9 9 0 0 0 0 18z';

const findNextTheme = (theme: Theme): Theme => THEMES[(THEMES.indexOf(theme) + 1) % THEMES.length] ?? 'system';

/** One button that steps through system → light → dark; the icon shows the current choice. */
export const ThemeToggle = () => {
  const [theme, setTheme] = useState(readStoredTheme);
  const next = findNextTheme(theme);
  return (
    <button
      type="button"
      className="btn theme-toggle"
      title={`Тема: ${LABELS[theme]}. Натисни — ${LABELS[next]}`}
      aria-label={`Тема: ${LABELS[theme]}. Змінити на: ${LABELS[next]}`}
      onClick={() => {
        storeTheme(next);
        setTheme(next);
      }}
    >
      <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth={1.8} strokeLinecap="round" strokeLinejoin="round" aria-hidden="true">
        <path d={ICON_PATHS[theme]} />
        {theme === 'system' && <path d={SYSTEM_HALF} fill="currentColor" stroke="none" />}
      </svg>
    </button>
  );
};
