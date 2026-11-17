import { mkdir } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { env } from '../env.ts';
import { runSubprocess } from '../subprocess.ts';
import { describeChatInstructions } from './instructions.ts';
import { type ChatImage, type ClaudeAnswer, describeUserTurn, findClaudeAnswer } from './stream.ts';

/** An empty working directory, so Claude picks up no project files or CLAUDE.md. */
const WORK_DIR = join(tmpdir(), 'hroshi-chat');

/** Claude gets what it needs to run and nothing more: the bank tokens in the bot's env stay out of it. */
const PASSED_ENV = ['PATH', 'HOME', 'TZ', 'LANG', 'CLAUDE_CONFIG_DIR', 'DISABLE_AUTOUPDATER'];

/** A request that walks the review inbox makes many tool calls; past this the owner has given up waiting. */
const ANSWER_TIMEOUT_MS = 5 * 60_000;

const pickEnv = () => {
  const picked: Record<string, string> = {};
  for (const key of PASSED_ENV) {
    const value = process.env[key];
    if (value !== undefined) picked[key] = value;
  }
  return picked;
};

/**
 * One turn of the chat: Claude Code in print mode, with no built-in tools and only the app's MCP
 * server allowed. `batchId` tags every write of this turn so the owner can undo it as a whole.
 */
export const askClaude = async ({
  text,
  images = [],
  batchId,
  sessionId,
  today,
}: {
  text: string;
  images?: readonly ChatImage[];
  batchId: string;
  sessionId: string | undefined;
  today: string;
}): Promise<ClaudeAnswer> => {
  await mkdir(WORK_DIR, { recursive: true });
  const mcpConfig = { mcpServers: { hroshi: { type: 'http', url: env.CHAT_MCP_URL, headers: { 'x-chat-batch': batchId } } } };
  const args = [
    '-p',
    // stream-json is the input that carries pictures; it needs the matching output, which needs --verbose.
    '--input-format', 'stream-json',
    '--output-format', 'stream-json',
    '--verbose',
    '--model', env.CHAT_MODEL,
    '--mcp-config', JSON.stringify(mcpConfig),
    '--strict-mcp-config',
    '--tools', '',
    '--allowedTools', 'mcp__hroshi',
    '--append-system-prompt', describeChatInstructions(today),
    ...(sessionId === undefined ? [] : ['--resume', sessionId]),
  ];
  const { code, stdout, stderr } = await runSubprocess({
    command: 'claude',
    args,
    input: describeUserTurn({ text, images }),
    cwd: WORK_DIR,
    env: pickEnv(),
    timeoutMs: ANSWER_TIMEOUT_MS,
  });
  const answer = findClaudeAnswer(stdout);
  if (answer !== undefined) return answer;
  throw new Error((stderr || stdout).trim().slice(-500) || `claude exited with ${code}`);
};
