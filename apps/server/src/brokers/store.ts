import { mkdir, readdir, readFile, stat, writeFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';

import { REPO_ROOT } from '../env.ts';

/** Broker statements live next to the other personal files, outside git. */
export const BROKER_DIR = resolve(REPO_ROOT, 'data/brokers');

export type BrokerName = 'ibkr' | 'freedom24' | 'binance';

export const saveBrokerFile = async ({ broker, name, content }: { broker: BrokerName; name: string; content: string }) => {
  const dir = join(BROKER_DIR, broker);
  await mkdir(dir, { recursive: true });
  const path = join(dir, basename(name));
  await writeFile(path, content);
  return path;
};

/** The newest statement of a broker, by modification time. */
export const readLatestBrokerFile = async (broker: BrokerName): Promise<{ name: string; content: string } | undefined> => {
  const dir = join(BROKER_DIR, broker);
  const names = await readdir(dir).catch(() => []);
  const dated = await Promise.all(names.map(async (name) => ({ name, modified: (await stat(join(dir, name))).mtimeMs })));
  const [latest] = dated.toSorted((left, right) => right.modified - left.modified);
  return latest === undefined ? undefined : { name: latest.name, content: await readFile(join(dir, latest.name), 'utf8') };
};
