import { randomUUID } from 'node:crypto';
import { resolve } from 'node:path';
import { setTimeout as sleep } from 'node:timers/promises';

import { type ConsentCompletion, ConsentCompletedSchema, ConsentStartSchema } from '@hroshi/schema';
import type { z } from 'zod';

import { findImageAttachment, type ImageAttachment } from './chat/attachments.ts';
import { listChatChanges, undoChatBatch } from './chat/changes.ts';
import { askClaude } from './chat/claude.ts';
import { formatChatChanges } from './chat/format.ts';
import { formatSplitwiseChanges, listSplitwiseChanges, undoSplitwiseChanges } from './chat/splitwise-log.ts';
import type { ChatImage } from './chat/stream.ts';
import { transcribeVoice } from './chat/voice.ts';
import { findToday } from './clock.ts';
import { RENEW_REVOLUT } from './sync/alerts.ts';
import { parseConsentRedirect } from './sync/enable-banking/redirect.ts';
import { requireSplitwiseClient } from './sync/splitwise/provider.ts';
import { prisma } from './db.ts';
import { env, REPO_ROOT } from './env.ts';
import {
  answerTelegramButton,
  downloadTelegramFile,
  readTelegramUpdates,
  removeTelegramButtons,
  requireTelegramOwner,
  sendTelegramMessage,
  sendTelegramTyping,
  type TelegramButton,
  type TelegramMessage,
  type TelegramUpdate,
  type TelegramVoice,
} from './telegram.ts';

const POLL_TIMEOUT_S = 50;
/** A follow-up inside this window continues the conversation («ні, там було 15 €»). */
const SESSION_TTL_MS = 30 * 60_000;
/** After downtime Telegram hands over the backlog; requests this old are not what the owner wants now. */
const STALE_MESSAGE_S = 60 * 60;
/** Telegram keeps «друкує…» up for five seconds per call. */
const TYPING_EVERY_MS = 4_000;
const RETRY_AFTER_MS = 5_000;
/** Telegram's own limit is 4096 characters. */
const TEXT_LIMIT = 4_000;
const UNDO_PREFIX = 'undo:';
/** A photo without words still asks for something: a receipt to book, a screenshot to check. */
const UNCAPTIONED = 'Фото без підпису.';
/** Past this the Pi needs minutes to transcribe; a longer story is better typed. */
const MAX_VOICE_S = 120;
const LOGIN_HINT = 'Якщо Claude розлогінився: на Pi виконай docker exec -it hroshi-bot-1 claude auth login';
const HELP = [
  'Пиши, надиктуй голосовим або скинь фото чека чи скріншот: що зробив із грошима чи що виправити. Наприклад:',
  '«заплатив готівкою 20 € за каву»',
  '«перенеси вчорашні витрати в Лісабоні в Подорожі»',
  '«що висить у перевірці?»',
  '«намалюй витрати на їжу по місяцях за рік»',
  'фото чека з підписом «внеси, платив карткою Revolut»',
  'Під кожною зміною буде кнопка «Скасувати». /new починає розмову спочатку.',
].join('\n');

const log = (message: string) => console.log(`${new Date().toISOString()} [bot] ${message}`);

const { token, chatId: ownerChat } = requireTelegramOwner();
const WHISPER_MODEL = resolve(REPO_ROOT, env.WHISPER_MODEL);

const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));

const truncate = (text: string) => (text.length <= TEXT_LIMIT ? text : `${text.slice(0, TEXT_LIMIT - 1)}…`);

const send = (text: string, button?: TelegramButton) => sendTelegramMessage({ token, chatId: ownerChat, text: truncate(text), button });

/** The bot holds no bank keys: consent goes through the API's own routes, as the web app's button does. */
const API_BASE = new URL('./', env.CHAT_MCP_URL);

const postApi = async <Schema extends z.ZodType>({ path, body, schema }: { path: string; body?: unknown; schema: Schema }): Promise<z.infer<Schema>> => {
  const response = await fetch(new URL(path, API_BASE), {
    method: 'POST',
    ...(body === undefined ? {} : { headers: { 'content-type': 'application/json' }, body: JSON.stringify(body) }),
  });
  if (!response.ok) throw new Error(`${path} answered ${response.status}: ${await response.text()}`);
  return schema.parse(await response.json());
};

let session: { id: string; at: number } | undefined;

const pingTyping = () => void sendTelegramTyping({ token, chatId: ownerChat }).catch(() => undefined);

/** Keeps «друкує…» on screen while Claude works; the returned function stops it. */
const showTyping = () => {
  pingTyping();
  const timer = setInterval(pingTyping, TYPING_EVERY_MS);
  return () => clearInterval(timer);
};

/** `heard` marks a transcribed voice note: the owner sees what was understood, Claude knows to expect slips. */
const answerText = async ({ text, heard = false, images }: { text: string; heard?: boolean; images?: readonly ChatImage[] }) => {
  if (text === '/start' || text === '/new') {
    session = undefined;
    await send(HELP);
    return;
  }

  const batchId = randomUUID();
  const stopTyping = showTyping();
  let reply: string;
  try {
    const resumed = session !== undefined && Date.now() - session.at < SESSION_TTL_MS ? session.id : undefined;
    const prompt = heard ? `Голосове, розпізнане автоматично: ${text}` : text;
    const answer = await askClaude({ text: prompt, images, batchId, sessionId: resumed, today: findToday() });
    session = { id: answer.session_id, at: Date.now() };
    reply = answer.is_error ? `Claude не впорався: ${answer.result}\n${LOGIN_HINT}` : answer.result.trim();
  } catch (error) {
    session = undefined;
    reply = `Не вийшло: ${describeError(error)}\n${LOGIN_HINT}`;
  } finally {
    stopTyping();
  }

  // A run that failed halfway may still have written; the list and the undo button show what it did.
  const [changes, splitwise] = await Promise.all([listChatChanges({ db: prisma, batchId }), listSplitwiseChanges({ db: prisma, batchId })]);
  const listed = [formatSplitwiseChanges(splitwise), formatChatChanges(changes)].filter((part) => part !== '').join('\n');
  const body = [heard ? `🎙 ${text}` : '', reply, listed].filter((part) => part !== '').join('\n\n') || 'Готово.';
  const undoable = changes.length > 0 || splitwise.length > 0;
  await send(body, undoable ? { text: '↩️ Скасувати', data: `${UNDO_PREFIX}${batchId}` } : undefined);
};

const answerVoice = async (voice: TelegramVoice) => {
  if (voice.duration > MAX_VOICE_S) {
    await send(`Голосове задовге: розбираю до ${MAX_VOICE_S / 60} хв. Розбий на кілька або напиши.`);
    return;
  }
  const stopTyping = showTyping();
  let text: string;
  try {
    const ogg = await downloadTelegramFile({ token, fileId: voice.file_id });
    text = await transcribeVoice({ ogg, durationS: voice.duration, model: WHISPER_MODEL });
  } catch (error) {
    await send(`Не розібрав голосове: ${describeError(error)}`);
    return;
  } finally {
    stopTyping();
  }
  if (text === '') {
    await send('Нічого не почув. Спробуй ще раз або напиши.');
    return;
  }
  await answerText({ text, heard: true });
};

const answerPicture = async ({ attachment, caption }: { attachment: ImageAttachment; caption: string | undefined }) => {
  if (attachment.kind === 'refused') {
    await send(attachment.reason);
    return;
  }
  let data: Buffer;
  try {
    data = await downloadTelegramFile({ token, fileId: attachment.fileId });
  } catch (error) {
    await send(`Не завантажив фото: ${describeError(error)}`);
    return;
  }
  await answerText({ text: caption?.trim() || UNCAPTIONED, images: [{ mediaType: attachment.mediaType, data }] });
};

/**
 * The ledger goes first: when a row changed since, it refuses before Splitwise is touched. A
 * Splitwise call that fails after it leaves the expense for the next sync to book again.
 */
const undoMessage = async (batchId: string) => {
  const pending = await prisma.chatChange.count({ where: { batchId, undoneAt: null } });
  const rows = pending === 0 ? 0 : await undoChatBatch({ db: prisma, batchId });
  const splitwise = await undoSplitwiseChanges({ db: prisma, client: requireSplitwiseClient, batchId });
  if (rows === 0 && splitwise === 0) throw new Error('Скасовувати нічого: ці зміни вже скасовано');
  return { rows, splitwise };
};

const answerUndo = async ({ callbackId, batchId, message }: { callbackId: string; batchId: string; message: TelegramMessage | undefined }) => {
  try {
    const { rows, splitwise } = await undoMessage(batchId);
    await answerTelegramButton({ token, callbackId, text: 'Скасовано' });
    if (message !== undefined) await removeTelegramButtons({ token, chatId: ownerChat, messageId: message.message_id });
    await send(`↩️ Скасовано: записів повернуто як було ${rows}${splitwise > 0 ? `, змін у Splitwise відкочено ${splitwise}` : ''}.`);
  } catch (error) {
    await answerTelegramButton({ token, callbackId, text: 'Не вийшло' });
    await send(`Не скасовано: ${describeError(error)}`);
  }
};

/** A fresh link each time: the bank's consent page doesn't wait long. */
const answerRenewRevolut = async (callbackId: string) => {
  try {
    const { url } = await postApi({ path: 'connections/revolut/start', schema: ConsentStartSchema });
    await answerTelegramButton({ token, callbackId, text: 'Посилання готове' });
    await send(
      'Відкрий Revolut і підтверди доступ. Якщо потім відкриється сторінка, що не вантажиться, скопіюй її адресу й надішли сюди: я завершу поновлення.',
      { text: '🔐 Відкрити Revolut', url },
    );
  } catch (error) {
    await answerTelegramButton({ token, callbackId, text: 'Не вийшло' });
    await send(`Не вдалося почати поновлення Revolut: ${describeError(error)}`);
  }
};

const answerConsentRedirect = async (redirect: ConsentCompletion) => {
  try {
    const { validUntil } = await postApi({ path: 'connections/revolut/complete', body: redirect, schema: ConsentCompletedSchema });
    const until = new Date(validUntil).toLocaleDateString('uk-UA', { day: 'numeric', month: 'long', year: 'numeric' });
    await send(`✅ Revolut поновлено до ${until}. Підтягую пропущене; підсумок буде на вкладці «Синхронізація».`);
  } catch (error) {
    await send(`Не вдалося завершити поновлення Revolut: ${describeError(error)}`);
  }
};

const isOwner = (message: TelegramMessage | undefined) => message !== undefined && String(message.chat.id) === ownerChat;

const handleUpdate = async ({ message, callback_query: button }: TelegramUpdate) => {
  if (button !== undefined) {
    if (!isOwner(button.message)) return;
    if (button.data === RENEW_REVOLUT) await answerRenewRevolut(button.id);
    else if (button.data?.startsWith(UNDO_PREFIX) === true) {
      await answerUndo({ callbackId: button.id, batchId: button.data.slice(UNDO_PREFIX.length), message: button.message });
    }
    return;
  }
  // Anyone can find the bot; only the owner's chat reaches the ledger.
  if (message === undefined || !isOwner(message)) return;
  if (Date.now() / 1000 - message.date > STALE_MESSAGE_S) return;
  if (message.voice !== undefined) {
    await answerVoice(message.voice);
    return;
  }
  const attachment = findImageAttachment(message);
  if (attachment !== undefined) {
    await answerPicture({ attachment, caption: message.caption });
    return;
  }
  if (message.text === undefined) {
    await send('Розумію текст, голосові й фото.');
    return;
  }
  const redirect = parseConsentRedirect(message.text);
  if (redirect !== undefined) {
    await answerConsentRedirect(redirect);
    return;
  }
  await answerText({ text: message.text.trim() });
};

log(`polling Telegram, model ${env.CHAT_MODEL}, MCP at ${env.CHAT_MCP_URL}`);
let offset = 0;
for (;;) {
  try {
    for (const update of await readTelegramUpdates({ token, offset, timeoutS: POLL_TIMEOUT_S })) {
      offset = update.update_id + 1;
      await handleUpdate(update).catch((error: unknown) => log(`update ${update.update_id} failed: ${describeError(error)}`));
    }
  } catch (error) {
    log(`polling failed: ${describeError(error)}`);
    await sleep(RETRY_AFTER_MS);
  }
}
