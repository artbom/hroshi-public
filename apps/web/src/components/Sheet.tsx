import { type ReactNode, useEffect, useId, useRef } from 'react';

/** An edit sheet over the page: a side drawer on a wide screen, the whole screen on a phone. */
export const Sheet = ({
  title,
  subtitle,
  onClose,
  children,
}: {
  title: ReactNode;
  subtitle?: ReactNode;
  onClose: () => void;
  children: ReactNode;
}) => {
  const titleId = useId();
  const closeButton = useRef<HTMLButtonElement>(null);
  // The parent re-renders on every keystroke in the sheet; keeping the latest handler in a ref
  // stops the listener (and the focus) from being reset each time.
  const latestOnClose = useRef(onClose);
  useEffect(() => {
    latestOnClose.current = onClose;
  }, [onClose]);

  useEffect(() => {
    closeButton.current?.focus();
    const onKey = (event: KeyboardEvent) => {
      if (event.key === 'Escape') latestOnClose.current();
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, []);

  return (
    <>
      <div className="scrim" onClick={onClose} aria-hidden="true" />
      <aside className="drawer edit-sheet" role="dialog" aria-modal="true" aria-labelledby={titleId}>
        <div className="drawer-head">
          <h3 id={titleId}>{title}</h3>
          <button type="button" className="close" ref={closeButton} aria-label="Закрити" onClick={onClose}>
            ✕
          </button>
          {subtitle !== undefined && <div className="small muted sheet-sub">{subtitle}</div>}
        </div>
        {children}
      </aside>
    </>
  );
};
