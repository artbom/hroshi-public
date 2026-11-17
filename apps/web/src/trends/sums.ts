/**
 * Whole euros that add up: each value is rounded so the rounded rows sum to the rounded total
 * (largest remainder first). Rounded one by one, fifteen rows can miss their own «Разом» by a euro or two.
 */
export const roundToTotal = (values: readonly number[]): number[] => {
  const total = Math.round(values.reduce((sum, value) => sum + value, 0));
  const floors = values.map((value) => Math.floor(value));
  const missing = total - floors.reduce((sum, value) => sum + value, 0);
  const lifted = new Set(
    values
      .map((value, index) => ({ index, remainder: value - Math.floor(value) }))
      .toSorted((left, right) => right.remainder - left.remainder)
      .slice(0, Math.max(0, missing))
      .map((entry) => entry.index),
  );
  return floors.map((value, index) => (lifted.has(index) ? value + 1 : value));
};

/** One column of a table rounded with `roundToTotal`, read back by row key. */
export const roundColumn = <TRow>({
  rows,
  pick,
  key,
}: {
  rows: readonly TRow[];
  pick: (row: TRow) => number;
  key: (row: TRow) => string;
}): ReadonlyMap<string, number> => {
  const rounded = roundToTotal(rows.map(pick));
  return new Map(rows.map((row, index) => [key(row), rounded[index] ?? 0]));
};
