import { fileURLToPath } from 'node:url';

import { z } from 'zod';

/** `.env` leaves unset secrets as empty strings; treat them as absent. */
const OptionalSecretSchema = z
  .string()
  .trim()
  .optional()
  .transform((value) => value || undefined);

const EnvSchema = z.object({
  DATABASE_URL: z.string().min(1),
  HOST: z.string().default('127.0.0.1'),
  PORT: z.coerce.number().int().default(4300),
  WEB_DIST: z.string().default(new URL('../../web/dist', import.meta.url).pathname),
  MONO_TOKEN: OptionalSecretSchema,
  ENABLE_BANKING_APP_ID: OptionalSecretSchema,
  ENABLE_BANKING_KEY_PATH: OptionalSecretSchema,
  ENABLE_BANKING_REDIRECT_URL: OptionalSecretSchema,
  /** How Enable Banking names the bank, and the country it is listed under (`pnpm cli eb:aspsps ES`). */
  ENABLE_BANKING_ASPSP_NAME: z.string().default('Revolut'),
  ENABLE_BANKING_ASPSP_COUNTRY: z.string().length(2).default('ES'),
  BINANCE_API_KEY: OptionalSecretSchema,
  BINANCE_API_SECRET: OptionalSecretSchema,
  IBKR_FLEX_TOKEN: OptionalSecretSchema,
  IBKR_FLEX_QUERY_ID: OptionalSecretSchema,
  /** Login cookies copied from a browser signed in to splitwise.com; they act as the owner. */
  SPLITWISE_SESSION: OptionalSecretSchema,
  SPLITWISE_USER_CREDENTIALS: OptionalSecretSchema,
  /** Weekly digest: a bot from @BotFather and the chat it writes to (`cli telegram:chats`). */
  TELEGRAM_BOT_TOKEN: OptionalSecretSchema,
  TELEGRAM_CHAT_ID: OptionalSecretSchema,
  /** Where the chat bot's Claude reaches the app's MCP server; compose points it at the api service. */
  CHAT_MCP_URL: z.url().default('http://127.0.0.1:4300/api/mcp'),
  /** The model the chat bot asks; a plain bookkeeping request does not need the largest one. */
  CHAT_MODEL: z.string().default('sonnet'),
  /** whisper.cpp model for voice messages; relative to the repository root, where the deploy puts it. */
  WHISPER_MODEL: z.string().default('data/models/ggml-large-v3-turbo-q5_0.bin'),
});

export type Env = z.infer<typeof EnvSchema>;

/** Relative paths in `.env` (key files) mean the repository root, wherever the process starts. */
export const REPO_ROOT = fileURLToPath(new URL('../../../', import.meta.url));

export const env: Env = EnvSchema.parse(process.env);
