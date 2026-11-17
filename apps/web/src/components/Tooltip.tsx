import {
  createContext,
  type FocusEvent,
  type MouseEvent,
  type ReactNode,
  type TouchEvent,
  useContext,
  useEffect,
  useLayoutEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

type Point = { clientX: number; clientY: number };

type TooltipApi = {
  showTooltip: (point: Point, content: ReactNode) => void;
  hideTooltip: () => void;
};

const TooltipContext = createContext<TooltipApi>({ showTooltip: () => {}, hideTooltip: () => {} });

const EDGE = 8;
const OFFSET = 12;

export const TooltipProvider = ({ children }: { children: ReactNode }) => {
  const [tip, setTip] = useState<(Point & { content: ReactNode }) | null>(null);
  const ref = useRef<HTMLDivElement>(null);

  const api = useMemo<TooltipApi>(
    () => ({
      showTooltip: (point, content) => setTip({ clientX: point.clientX, clientY: point.clientY, content }),
      hideTooltip: () => setTip(null),
    }),
    [],
  );

  useEffect(() => {
    const hide = () => setTip(null);
    window.addEventListener('scroll', hide, { passive: true });
    return () => window.removeEventListener('scroll', hide);
  }, []);

  // Placement needs the rendered size, so it happens after layout and before paint.
  useLayoutEffect(() => {
    const element = ref.current;
    if (element === null || tip === null) return;
    const { offsetWidth: width, offsetHeight: height } = element;
    // clientWidth leaves out the scrollbar, which innerWidth counts and a tooltip would hide under.
    const viewport = document.documentElement.clientWidth;
    const fitsRight = tip.clientX + OFFSET + width + EDGE <= viewport;
    const left = Math.max(EDGE, fitsRight ? tip.clientX + OFFSET : Math.min(viewport - width - EDGE, tip.clientX - width - OFFSET));
    const above = tip.clientY - height - OFFSET;
    element.style.left = `${left}px`;
    element.style.top = `${above < EDGE ? tip.clientY + 16 : above}px`;
  }, [tip]);

  return (
    <TooltipContext value={api}>
      {children}
      {tip !== null && (
        <div className="tip" ref={ref} role="tooltip">
          {tip.content}
        </div>
      )}
    </TooltipContext>
  );
};

export const useTooltip = () => useContext(TooltipContext);

/** Handlers that show a tooltip on hover, touch and keyboard focus. */
export const useTooltipHandlers = () => {
  const { showTooltip, hideTooltip } = useTooltip();
  return (content: () => ReactNode) => ({
    onMouseMove: (event: MouseEvent) => showTooltip(event, content()),
    onMouseLeave: hideTooltip,
    onTouchStart: (event: TouchEvent) => {
      const touch = event.touches[0];
      if (touch !== undefined) showTooltip(touch, content());
    },
    onFocus: (event: FocusEvent<Element>) => {
      const rect = event.currentTarget.getBoundingClientRect();
      showTooltip({ clientX: rect.left, clientY: rect.top }, content());
    },
    onBlur: hideTooltip,
  });
};
