import { spawn } from 'node:child_process';

export type SubprocessResult = { code: number | null; stdout: string; stderr: string };

/** Runs a command to the end and collects its output; `input`, when given, goes in on stdin. */
export const runSubprocess = ({
  command,
  args,
  input,
  cwd,
  env,
  timeoutMs,
}: {
  command: string;
  args: readonly string[];
  input?: string;
  cwd?: string;
  env?: NodeJS.ProcessEnv;
  timeoutMs: number;
}) =>
  new Promise<SubprocessResult>((resolve, reject) => {
    const child = spawn(command, args, { cwd, env, timeout: timeoutMs });
    let stdout = '';
    let stderr = '';
    child.stdout.on('data', (chunk: Buffer) => (stdout += chunk.toString()));
    child.stderr.on('data', (chunk: Buffer) => (stderr += chunk.toString()));
    child.on('error', reject);
    child.on('close', (code) => resolve({ code, stdout, stderr }));
    child.stdin.end(input);
  });
