import { z } from 'zod';

import { env } from './env.ts';

const TELEGRAM_API = 'https://api.telegram.org';

const ChatSchema = z.object({
  id: z.number(),
  type: z.string(),
  username: z.string().optional(),
  first_name: z.string().optional(),
});

const MessageSchema = z.object({
  message_id: z.number(),
  /** Unix seconds. */
  date: z.number(),
  chat: ChatSchema,
  text: z.string().optional(),
  voice: z.object({ file_id: z.string(), duration: z.number().int() }).optional(),
  /** One photo in several sizes, smallest first. */
  photo: z
    .array(z.object({ file_id: z.string(), width: z.number().int(), height: z.number().int(), file_size: z.number().int().optional() }))
    .optional(),
  /** A file, such as a screenshot sent uncompressed. */
  document: z.object({ file_id: z.string(), mime_type: z.string().optional(), file_size: z.number().int().optional() }).optional(),
  /** The text under a photo or a file. */
  caption: z.string().optional(),
});
export type TelegramMessage = z.infer<typeof MessageSchema>;
export type TelegramVoice = NonNullable<TelegramMessage['voice']>;

const UpdateSchema = z.object({
  update_id: z.number(),
  message: MessageSchema.optional(),
  callback_query: z
    .object({ id: z.string(), data: z.string().optional(), message: MessageSchema.optional() })
    .optional(),
});
export type TelegramUpdate = z.infer<typeof UpdateSchema>;

const UpdatesSchema = z.object({ result: z.array(UpdateSchema) });
const SentSchema = z.object({ result: MessageSchema });
const FileSchema = z.object({ result: z.object({ file_path: z.string() }) });

/** The bot and the chat it serves; the digest, the chat bot and its pictures all need both. */
export const requireTelegramOwner = () => {
  if (env.TELEGRAM_BOT_TOKEN === undefined || env.TELEGRAM_CHAT_ID === undefined) {
    throw new Error('TELEGRAM_BOT_TOKEN and TELEGRAM_CHAT_ID are not set');
  }
  return { token: env.TELEGRAM_BOT_TOKEN, chatId: env.TELEGRAM_CHAT_ID };
};

/** The token sits in the URL path, so errors report the method and status, never the URL. */
const callTelegram = async ({ token, method, init }: { token: string; method: string; init?: RequestInit }) => {
  const response = await fetch(`${TELEGRAM_API}/bot${token}/${method}`, init);
  if (!response.ok) throw new Error(`Telegram ${method} answered ${response.status}: ${await response.text()}`);
  return response.json();
};

const postTelegram = ({ token, method, params }: { token: string; method: string; params: Record<string, unknown> }) =>
  callTelegram({
    token,
    method,
    init: { method: 'POST', headers: { 'content-type': 'application/json' }, body: JSON.stringify(params) },
  });

export const sendTelegramPhoto = async ({
  token,
  chatId,
  png,
  caption,
}: {
  token: string;
  chatId: string;
  png: Buffer;
  caption: string;
}) => {
  const form = new FormData();
  form.set('chat_id', chatId);
  form.set('caption', caption);
  form.set('photo', new Blob([new Uint8Array(png)], { type: 'image/png' }), 'hroshi.png');
  await callTelegram({ token, method: 'sendPhoto', init: { method: 'POST', body: form } });
};

/** A button under a message: `data` comes back to the bot when tapped, `url` opens in the browser. */
export type TelegramButton = { text: string; data: string } | { text: string; url: string };

/** Plain text on purpose: model replies carry stray Markdown that Telegram's parser would reject. */
export const sendTelegramMessage = async ({
  token,
  chatId,
  text,
  button,
}: {
  token: string;
  chatId: string;
  text: string;
  button?: TelegramButton | undefined;
}) => {
  const key = button === undefined ? undefined : 'url' in button ? { text: button.text, url: button.url } : { text: button.text, callback_data: button.data };
  const markup = key === undefined ? {} : { reply_markup: { inline_keyboard: [[key]] } };
  const { result } = SentSchema.parse(
    await postTelegram({ token, method: 'sendMessage', params: { chat_id: chatId, text, ...markup } }),
  );
  return result;
};

/** A file someone sent the bot, such as a voice note; like every call, errors leave the token out. */
export const downloadTelegramFile = async ({ token, fileId }: { token: string; fileId: string }) => {
  const { result } = FileSchema.parse(await postTelegram({ token, method: 'getFile', params: { file_id: fileId } }));
  const response = await fetch(`${TELEGRAM_API}/file/bot${token}/${result.file_path}`);
  if (!response.ok) throw new Error(`Telegram file download answered ${response.status}`);
  return Buffer.from(await response.arrayBuffer());
};

/** Telegram shows «друкує…» for five seconds per call. */
export const sendTelegramTyping = async ({ token, chatId }: { token: string; chatId: string }) => {
  await postTelegram({ token, method: 'sendChatAction', params: { chat_id: chatId, action: 'typing' } });
};

export const answerTelegramButton = async ({ token, callbackId, text }: { token: string; callbackId: string; text: string }) => {
  await postTelegram({ token, method: 'answerCallbackQuery', params: { callback_query_id: callbackId, text } });
};

export const removeTelegramButtons = async ({ token, chatId, messageId }: { token: string; chatId: string; messageId: number }) => {
  await postTelegram({
    token,
    method: 'editMessageReplyMarkup',
    params: { chat_id: chatId, message_id: messageId, reply_markup: { inline_keyboard: [] } },
  });
};

/** Long polling: the request waits up to `timeoutS` for something new, so the bot needs no public address. */
export const readTelegramUpdates = async ({ token, offset, timeoutS }: { token: string; offset: number; timeoutS: number }) => {
  const { result } = UpdatesSchema.parse(
    await postTelegram({
      token,
      method: 'getUpdates',
      params: { offset, timeout: timeoutS, allowed_updates: ['message', 'callback_query'] },
    }),
  );
  return result;
};

/** Chats that wrote to the bot recently: the owner sends it /start once to reveal the chat id. */
export const listTelegramChats = async (token: string) => {
  const { result } = UpdatesSchema.parse(await callTelegram({ token, method: 'getUpdates' }));
  const chats = new Map(
    result.flatMap((update) => (update.message === undefined ? [] : [[update.message.chat.id, update.message.chat] as const])),
  );
  return [...chats.values()].map((chat) => `${chat.id} · ${chat.type} · ${chat.username ?? chat.first_name ?? ''}`);
};
