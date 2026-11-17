import { useCallback, useRef, useState } from 'react';

/** Width of an element, kept current with a ResizeObserver; 0 until it mounts. */
export const useElementWidth = <TElement extends HTMLElement>() => {
  const [width, setWidth] = useState(0);
  const observer = useRef<ResizeObserver | null>(null);

  const ref = useCallback((element: TElement | null) => {
    observer.current?.disconnect();
    if (element === null) return;
    setWidth(element.clientWidth);
    observer.current = new ResizeObserver(([entry]) => {
      if (entry !== undefined) setWidth(entry.contentRect.width);
    });
    observer.current.observe(element);
  }, []);

  return [ref, width] as const;
};
