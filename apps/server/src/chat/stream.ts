import { z } from 'zod';

/** The picture formats Claude reads; an iPhone's HEIC sent as a file is not among them. */
export const ImageMediaTypeSchema = z.enum(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
export type ChatImage = { mediaType: z.infer<typeof ImageMediaTypeSchema>; data: Buffer };

/** The last event of a stream-json run; the fields match what `--output-format json` prints. */
const ClaudeResultSchema = z.object({
  type: z.literal('result'),
  result: z.string().default(''),
  session_id: z.string(),
  is_error: z.boolean(),
});
export type ClaudeAnswer = Omit<z.infer<typeof ClaudeResultSchema>, 'type'>;

/** One turn of Claude Code's stream-json input: the pictures first, then the words about them. */
export const describeUserTurn = ({ text, images }: { text: string; images: readonly ChatImage[] }) =>
  `${JSON.stringify({
    type: 'user',
    message: {
      role: 'user',
      content: [
        ...images.map(({ mediaType, data }) => ({ type: 'image', source: { type: 'base64', media_type: mediaType, data: data.toString('base64') } })),
        { type: 'text', text },
      ],
    },
  })}\n`;

/** Claude prints plain text instead of JSON when it fails before starting (no login, bad flag). */
const readJson = (line: string): unknown => {
  try {
    return JSON.parse(line);
  } catch {
    return null;
  }
};

/** stream-json prints one event per line; the answer is in the `result` one, or there is none. */
export const findClaudeAnswer = (stdout: string): ClaudeAnswer | undefined => {
  for (const line of stdout.split('\n').toReversed()) {
    const parsed = ClaudeResultSchema.safeParse(readJson(line));
    if (parsed.success) {
      const { type: _type, ...answer } = parsed.data;
      return answer;
    }
  }
  return undefined;
};
