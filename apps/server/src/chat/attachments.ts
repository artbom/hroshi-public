import type { TelegramMessage } from '../telegram.ts';
import { type ChatImage, ImageMediaTypeSchema } from './stream.ts';

/** Claude takes up to 5 MB per picture, and base64 makes a file a third larger on the way. */
const MAX_IMAGE_BYTES = 3_500_000;

export type ImageAttachment =
  | { kind: 'image'; fileId: string; mediaType: ChatImage['mediaType'] }
  | { kind: 'refused'; reason: string };

/** The picture a message carries: the largest size of a photo that Claude takes, or an image sent as a file. */
export const findImageAttachment = ({ photo, document }: Pick<TelegramMessage, 'photo' | 'document'>): ImageAttachment | undefined => {
  if (photo !== undefined) {
    const largest = photo
      .filter((size) => (size.file_size ?? 0) <= MAX_IMAGE_BYTES)
      .toSorted((left, right) => left.width * left.height - right.width * right.height)
      .at(-1);
    return largest === undefined ? { kind: 'refused', reason: 'Фото завелике.' } : { kind: 'image', fileId: largest.file_id, mediaType: 'image/jpeg' };
  }
  if (document === undefined) return undefined;
  const mediaType = ImageMediaTypeSchema.safeParse(document.mime_type);
  if (!mediaType.success) return { kind: 'refused', reason: 'Такий файл не розберу: надішли фото або скріншот PNG чи JPEG.' };
  if ((document.file_size ?? 0) > MAX_IMAGE_BYTES) return { kind: 'refused', reason: 'Файл завеликий: надішли його як фото, Telegram його стисне.' };
  return { kind: 'image', fileId: document.file_id, mediaType: mediaType.data };
};
