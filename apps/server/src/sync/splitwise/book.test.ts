import { describe, expect, it } from 'vitest';

import { listTrips } from './book.ts';

describe('listTrips', () => {
  it('spans each trip tag over the days its rows cover', () => {
    expect(
      listTrips([
        { date: '2026-11-11', tags: ['trip:lisbon-2026-11'] },
        { date: '2026-11-09', tags: ['trip:lisbon-2026-11', 'gift'] },
        { date: '2026-11-13', tags: ['trip:lisbon-2026-11'] },
        { date: '2026-11-12', tags: [] },
      ]),
    ).toEqual([{ tag: 'trip:lisbon-2026-11', from: '2026-11-09', to: '2026-11-13' }]);
  });
});
