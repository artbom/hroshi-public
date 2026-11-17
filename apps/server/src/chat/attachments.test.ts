import { describe, expect, it } from 'vitest';

import { findImageAttachment } from './attachments.ts';

describe('findImageAttachment', () => {
  it('takes the largest size of a photo that Claude accepts', () => {
    const photo = [
      { file_id: 'small', width: 320, height: 240, file_size: 20_000 },
      { file_id: 'large', width: 1280, height: 960, file_size: 300_000 },
      { file_id: 'huge', width: 2560, height: 1920, file_size: 9_000_000 },
    ];
    expect(findImageAttachment({ photo })).toEqual({ kind: 'image', fileId: 'large', mediaType: 'image/jpeg' });
  });

  it('takes a screenshot sent as a file', () => {
    expect(findImageAttachment({ document: { file_id: 'png', mime_type: 'image/png', file_size: 900_000 } })).toEqual({
      kind: 'image',
      fileId: 'png',
      mediaType: 'image/png',
    });
  });

  it('refuses files Claude cannot read', () => {
    expect(findImageAttachment({ document: { file_id: 'heic', mime_type: 'image/heic' } })?.kind).toBe('refused');
  });

  it('ignores a message without a picture', () => {
    expect(findImageAttachment({})).toBeUndefined();
  });
});
