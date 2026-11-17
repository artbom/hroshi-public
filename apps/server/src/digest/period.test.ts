import { describe, expect, it } from 'vitest';

import { findLastWeekEnd, findWeekEnd } from './period.ts';

describe('findWeekEnd', () => {
  it('finds the Sunday of the week a day falls in', () => {
    expect(findWeekEnd('2026-11-11')).toBe('2026-11-15');
    expect(findWeekEnd('2026-11-15')).toBe('2026-11-15');
    expect(findWeekEnd('2026-11-16')).toBe('2026-11-22');
  });

  it('agrees with the last full week before today', () => {
    expect(findWeekEnd('2026-11-04')).toBe(findLastWeekEnd('2026-11-13'));
  });
});
