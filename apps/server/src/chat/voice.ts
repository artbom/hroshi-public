import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { availableParallelism, tmpdir } from 'node:os';
import { join } from 'node:path';

import { runSubprocess } from '../subprocess.ts';

/** Whisper hears in 30-second windows of 1500 frames, whatever the length of the note. */
const FRAMES_PER_SECOND = 50;
const WINDOW_FRAMES = 1500;
/** Telegram rounds the duration; the margin keeps the last word in the window. */
const MARGIN_S = 2;
/** A two-minute note takes the Pi about four windows of a minute each. */
const TRANSCRIBE_TIMEOUT_MS = 5 * 60_000;
/** Whisper's marks for what is not speech: [BLANK_AUDIO], [музика]. */
const NOT_SPEECH = /\[[^\]]*\]/g;

/**
 * Cutting the window to the note is what makes the Pi answer a short note in seconds instead of a
 * minute; the large-v3-turbo model keeps Ukrainian accurate with it, smaller models start to repeat.
 */
export const findAudioWindow = (durationS: number) => Math.min(WINDOW_FRAMES, Math.ceil((durationS + MARGIN_S) * FRAMES_PER_SECOND));

const run = async ({ command, args }: { command: string; args: readonly string[] }) => {
  const { code, stdout, stderr } = await runSubprocess({ command, args, timeoutMs: TRANSCRIBE_TIMEOUT_MS });
  if (code !== 0) throw new Error(`${command} exited with ${code}: ${stderr.trim().slice(-300)}`);
  return stdout;
};

/** A Telegram voice note (OGG Opus) as text; empty when there was nothing to hear. `model` is a whisper.cpp model file. */
export const transcribeVoice = async ({ ogg, durationS, model }: { ogg: Buffer; durationS: number; model: string }) => {
  const dir = await mkdtemp(join(tmpdir(), 'hroshi-voice-'));
  try {
    const oggPath = join(dir, 'voice.ogg');
    const wavPath = join(dir, 'voice.wav');
    await writeFile(oggPath, ogg);
    await run({ command: 'opusdec', args: ['--quiet', '--rate', '16000', oggPath, wavPath] });
    const text = await run({
      command: 'whisper-cli',
      args: [
        '--model', model,
        '--language', 'uk',
        '--threads', String(availableParallelism()),
        '--audio-ctx', String(findAudioWindow(durationS)),
        '--no-timestamps',
        '--no-prints',
        '--file', wavPath,
      ],
    });
    return text.replace(NOT_SPEECH, ' ').replace(/\s+/g, ' ').trim();
  } finally {
    await rm(dir, { recursive: true, force: true });
  }
};
