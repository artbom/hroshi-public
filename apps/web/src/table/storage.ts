import { z } from 'zod';

/** A filter set the owner named, kept per browser: the query part of `#table?…`. */
const SavedViewSchema = z.object({ name: z.string().min(1), query: z.string() });
export type SavedView = z.infer<typeof SavedViewSchema>;

const VIEWS_KEY = 'hroshi.operations.views';
const CHAINS_KEY = 'hroshi.operations.chains';

/** Private windows and blocked site data throw on access; the page must work without storage. */
const readItem = (key: string): string | null => {
  try {
    return window.localStorage.getItem(key);
  } catch {
    return null;
  }
};

const writeItem = (key: string, value: string) => {
  try {
    window.localStorage.setItem(key, value);
  } catch {
    // Nothing to keep the value in; it lasts until the page reloads.
  }
};

const parseJson = (text: string | null): unknown => {
  if (text === null) return null;
  try {
    return JSON.parse(text);
  } catch {
    return null;
  }
};

export const readSavedViews = (): SavedView[] => {
  const parsed = z.array(SavedViewSchema).safeParse(parseJson(readItem(VIEWS_KEY)));
  return parsed.success ? parsed.data : [];
};

export const writeSavedViews = (views: readonly SavedView[]) => writeItem(VIEWS_KEY, JSON.stringify(views));

/** Grouping is on unless the owner turned it off. */
export const readGroupChains = (): boolean => readItem(CHAINS_KEY) !== '0';

export const writeGroupChains = (grouped: boolean) => writeItem(CHAINS_KEY, grouped ? '1' : '0');
