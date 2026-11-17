import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';

import { Resvg } from '@resvg/resvg-js';
import type { ReactElement } from 'react';
import satori from 'satori';

/** Satori adds padding outside the given size, so the canvas is sized to the space inside it. */
export const PADDING = 48;

/** The app's dark palette, so every picture reads as the same product. */
export const COLORS = {
  bg: '#0a0e0d',
  surface: '#1a2421',
  line: '#34433e',
  fg: '#ecf2ef',
  muted: '#93a39c',
  accent: '#5cc3a2',
  up: '#f4917e',
  down: '#86d896',
  warn: '#e2b357',
  bar: '#3987e5',
};

export type Style = Record<string, string | number>;
export type Child = ReactElement | string | null;

/** Manrope has no ʼ, the apostrophe Ukrainian text often comes with; ’ looks the same. */
const fitFont = (child: Child) => (typeof child === 'string' ? child.replaceAll('ʼ', '’') : child);

/** Satori takes React-shaped objects; the server has no JSX, so elements are built by hand. */
export const h = (style: Style, ...children: Child[]): ReactElement => ({
  type: 'div',
  key: null,
  props: { style: { display: 'flex', ...style }, children: children.filter((child) => child !== null).map(fitFont) },
});

/** Whole units with the thousands set apart and a true minus: «11 100», «−120». */
export const formatWhole = (value: number) =>
  (Math.round(value) || 0).toLocaleString('uk-UA').replace(/\s/g, ' ').replace('-', '−');

export const truncate = (text: string, length: number) => (text.length > length ? `${text.slice(0, length - 1).trimEnd()}…` : text);

/** A titled card on the canvas, the building block every picture is laid out from. */
export const renderSection = (title: string, ...rows: Child[]) =>
  h(
    { flex: 1, flexDirection: 'column', gap: 16, padding: '24px 30px', background: COLORS.surface, borderRadius: 24, border: `1px solid ${COLORS.line}` },
    h({ fontSize: 22, letterSpacing: 2, color: COLORS.muted, textTransform: 'uppercase' }, title),
    ...rows,
  );

const loadFonts = async () => {
  const require = createRequire(import.meta.url);
  const files = ['latin', 'cyrillic'].flatMap((subset) =>
    ([400, 700] as const).map((weight) => ({
      weight,
      subset,
      path: require.resolve(`@fontsource/manrope/files/manrope-${subset}-${weight}-normal.woff`),
    })),
  );
  // One family per subset: satori falls back between families, not between files of one family.
  return Promise.all(
    files.map(async ({ weight, path, subset }) => ({
      name: subset === 'latin' ? 'Manrope' : 'Manrope Cyrillic',
      data: await readFile(path),
      weight,
      style: 'normal' as const,
    })),
  );
};

/** A dark canvas in the app's font, its children in a column, rendered to PNG. */
export const renderPicture = async ({ width, height, gap, children }: { width: number; height: number; gap: number; children: Child[] }) => {
  const tree = h(
    {
      flexDirection: 'column',
      gap,
      width: width - 2 * PADDING,
      height: height - 2 * PADDING,
      padding: PADDING,
      background: COLORS.bg,
      color: COLORS.fg,
      fontFamily: 'Manrope, Manrope Cyrillic',
      overflow: 'hidden',
    },
    ...children,
  );
  const svg = await satori(tree, { width, height, fonts: await loadFonts() });
  return new Resvg(svg, { fitTo: { mode: 'width', value: width } }).render().asPng();
};
