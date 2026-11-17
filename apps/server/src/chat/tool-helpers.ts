import type { CallToolResult } from '@modelcontextprotocol/sdk/types.js';

export const reply = (data: unknown): CallToolResult => ({ content: [{ type: 'text', text: JSON.stringify(data) }] });

/** Every write of one chat message carries its id, so the message can be undone as a whole. */
export const requireBatch = (batchId: string | undefined) => {
  if (batchId === undefined) throw new Error('Зміни через MCP мають нести заголовок x-chat-batch, інакше їх не скасувати');
  return batchId;
};
