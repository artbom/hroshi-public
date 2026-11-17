import type { ReactNode } from 'react';

/** A tile's title whose last word carries the ⓘ: on a narrow tile the icon wraps with that word, never alone. */
export const TileLabel = ({ label, info }: { label: string; info: ReactNode }) => {
  const cut = label.lastIndexOf(' ');
  return (
    <span className="k">
      {cut === -1 ? '' : `${label.slice(0, cut)} `}
      <span className="k-tail">
        {label.slice(cut + 1)}
        {info}
      </span>
    </span>
  );
};
