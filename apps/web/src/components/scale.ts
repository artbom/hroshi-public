/** Rounds a step up to 1, 2, 2.5 or 5 × a power of ten, so grid labels read as round numbers. */
const findNiceStep = (rough: number): number => {
  if (rough <= 0) return 1;
  const power = 10 ** Math.floor(Math.log10(rough));
  const scaled = rough / power;
  const nice = scaled <= 1 ? 1 : scaled <= 2 ? 2 : scaled <= 2.5 ? 2.5 : scaled <= 5 ? 5 : 10;
  return nice * power;
};

export type Scale = { bottom: number; top: number; ticks: readonly number[] };

/**
 * Evenly spaced grid values covering the data: 0, 10k, 20k, 30k rather than the top, its half
 * and the bottom (which gave 12 500 next to 25 000). Amounts start at zero; a rate that only
 * moves between 40 and 52 would be a flat line on a zero-based axis, so it may leave zero out.
 */
export const findScale = ({
  min,
  max,
  count = 4,
  includeZero = true,
}: {
  min: number;
  max: number;
  count?: number;
  includeZero?: boolean;
}): Scale => {
  const low = includeZero ? Math.min(0, min) : min;
  const high = includeZero ? Math.max(0, max) : max;
  const step = findNiceStep((high - low || 1) / count);
  const bottom = Math.floor(low / step) * step;
  const top = Math.max(Math.ceil(high / step) * step, bottom + step);
  const ticks = Array.from({ length: Math.round((top - bottom) / step) + 1 }, (_, index) => bottom + index * step);
  return { bottom, top, ticks };
};
