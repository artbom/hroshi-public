/** Above this share of the limit a category is worth a look whatever the pace. */
export const NEAR_LIMIT_SHARE = 0.9;

/**
 * Spending against a limit: the fill turns amber near it and red past it; the tick marks how much
 * of the month has gone, so a bar ahead of its tick is spending faster than the month.
 */
export const LimitBar = ({ share, pace }: { share: number; pace: number }) => (
  <div className="bar limit-bar">
    <i
      style={{
        width: `${Math.max(2, Math.min(1, share) * 100)}%`,
        background: share > 1 ? 'var(--neg)' : share >= NEAR_LIMIT_SHARE ? 'var(--warn)' : 'var(--accent)',
      }}
    />
    {pace < 1 && <span className="pace" style={{ left: `${pace * 100}%` }} aria-hidden="true" />}
  </div>
);
