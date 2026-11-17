import { type ReactNode, useCallback, useRef, useState } from 'react';

/**
 * A table too wide for a phone: the first column stays put, the right edge fades while more columns
 * wait off-screen, and «гортай →» says so until the reader scrolls.
 */
/** Two pixels of slack: subpixel layout leaves a fraction even when nothing is hidden. */
const measureOverflow = (element: HTMLDivElement) => ({
  more: element.scrollLeft + element.clientWidth < element.scrollWidth - 2,
  scrolled: element.scrollLeft > 2,
});

export const ScrollTable = ({ children, className }: { children: ReactNode; className?: string }) => {
  const [overflow, setOverflow] = useState({ more: false, scrolled: false });
  const observer = useRef<ResizeObserver | null>(null);
  const ref = useCallback((element: HTMLDivElement | null) => {
    observer.current?.disconnect();
    if (element === null) return;
    setOverflow(measureOverflow(element));
    observer.current = new ResizeObserver(() => setOverflow(measureOverflow(element)));
    observer.current.observe(element);
  }, []);
  return (
    <div className={['scroll-table', overflow.more ? 'more' : '', className ?? ''].join(' ').trim()}>
      {overflow.more && !overflow.scrolled && (
        <span className="scroll-hint" aria-hidden="true">
          гортай →
        </span>
      )}
      <div className="scroll-table-body" ref={ref} onScroll={(event) => setOverflow(measureOverflow(event.currentTarget))}>
        {children}
      </div>
    </div>
  );
};
