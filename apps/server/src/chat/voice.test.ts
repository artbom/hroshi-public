import { describe, expect, it } from 'vitest';

import { findAudioWindow } from './voice.ts';

describe('findAudioWindow', () => {
  it('fits a short note with a margin', () => {
    expect(findAudioWindow(4)).toBe(300);
  });

  it('never asks for more than a full window', () => {
    expect(findAudioWindow(90)).toBe(1500);
  });
});
