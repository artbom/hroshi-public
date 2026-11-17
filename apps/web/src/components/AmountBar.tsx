import type { ReactNode } from 'react';

/** One labelled bar row: name, bar scaled to `max`, value on the right. */
export const AmountBar = ({
  label,
  value,
  max,
  display,
  color,
  current = false,
  valueClassName = '',
}: {
  label: ReactNode;
  value: number;
  max: number;
  display: ReactNode;
  color?: string;
  current?: boolean;
  valueClassName?: string;
}) => (
  <div className={current ? 'cat cur' : 'cat'}>
    <span>{label}</span>
    <div className="bar">
      <i
        style={{
          width: `${max > 0 && value > 0 ? Math.max(2, (value / max) * 100) : 0}%`,
          ...(color === undefined ? {} : { background: color }),
        }}
      />
    </div>
    <span className={`num ${valueClassName}`.trim()}>{display}</span>
  </div>
);
