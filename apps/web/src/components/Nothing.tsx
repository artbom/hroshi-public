/**
 * The one way a table says «nothing here»: a dash whose tooltip says why, never «0 €» in one cell
 * and «продажів не було» in the next.
 */
export const Nothing = ({ why }: { why: string }) => (
  <span className="nothing" title={why} aria-label={why}>
    —
  </span>
);
