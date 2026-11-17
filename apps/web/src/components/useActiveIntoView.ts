import { useEffect, useRef } from 'react';

/**
 * A row of chips that scrolls sideways on a phone: the current one is centred, never left behind the
 * edge. `active` is the current chip's key; the row re-centres whenever it changes.
 */
export const useActiveIntoView = <TElement extends HTMLElement>(active: string) => {
  const ref = useRef<TElement>(null);
  useEffect(() => {
    const row = ref.current;
    const chip = row?.querySelector<HTMLElement>(`[data-chip="${CSS.escape(active)}"]`);
    if (row === null || chip === null || chip === undefined || row.scrollWidth <= row.clientWidth) return;
    const box = row.getBoundingClientRect();
    const target = chip.getBoundingClientRect();
    row.scrollLeft += target.left - box.left - (box.width - target.width) / 2;
  }, [active]);
  return ref;
};
