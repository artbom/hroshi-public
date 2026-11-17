import { z } from 'zod';

export const THEMES = ['system', 'light', 'dark'] as const;
const ThemeSchema = z.enum(THEMES);
export type Theme = z.infer<typeof ThemeSchema>;

const STORAGE_KEY = 'theme';

export const readStoredTheme = (): Theme => {
  try {
    return ThemeSchema.safeParse(window.localStorage.getItem(STORAGE_KEY)).data ?? 'system';
  } catch {
    // Blocked site data: the page simply follows the system.
    return 'system';
  }
};

/** «system» drops the attribute, so the stylesheet's prefers-color-scheme rule decides. */
export const applyTheme = (theme: Theme) => {
  if (theme === 'system') document.documentElement.removeAttribute('data-theme');
  else document.documentElement.dataset['theme'] = theme;
};

export const storeTheme = (theme: Theme) => {
  applyTheme(theme);
  try {
    window.localStorage.setItem(STORAGE_KEY, theme);
  } catch {
    // Private windows: the choice lasts until reload.
  }
};
