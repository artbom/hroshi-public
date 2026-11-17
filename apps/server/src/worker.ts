import type { SyncSource } from '@hroshi/schema';
import { Cron } from 'croner';

import { prisma } from './db.ts';
import { SYNC_PROVIDERS } from './sync/providers.ts';
import { findToday } from './clock.ts';
import type { DigestKind } from './digest/period.ts';
import { sendDigest } from './digest/send.ts';
import { env } from './env.ts';
import { importRecentNbuRates } from './fx/nbu.ts';
import { topUpBenchmarkPrices } from './prices/benchmark.ts';
import { alertSyncFailure, remindRevolutConsent } from './sync/alerts.ts';
import { runSync } from './sync/runner.ts';

/**
 * Daily, in the owner's time zone. Mono goes first and takes about a minute per account
 * (rate limit), so Binance runs after it and its P2P orders find the card payments.
 */
const SCHEDULES: Readonly<Record<SyncSource, string>> = {
  mono: '0 6 * * *',
  revolut: '20 6 * * *',
  binance: '30 6 * * *',
  ibkr: '40 6 * * *',
  // Last: the shares it books look for the card payments the banks brought in this morning.
  splitwise: '50 6 * * *',
};

const log = (message: string) => console.log(`${new Date().toISOString()} ${message}`);
const describeError = (error: unknown) => (error instanceof Error ? error.message : String(error));
const telegramConfigured = env.TELEGRAM_BOT_TOKEN !== undefined && env.TELEGRAM_CHAT_ID !== undefined;

const jobs = Object.values(SYNC_PROVIDERS)
  .filter((provider) => provider.isConfigured())
  .map(
    (provider) =>
      new Cron(SCHEDULES[provider.source], { protect: true, name: provider.source }, async () => {
        try {
          const counts = await runSync({ db: prisma, source: provider.source, log });
          log(`[${provider.source}] ${JSON.stringify(counts)}`);
        } catch (error) {
          log(`[${provider.source}] failed: ${describeError(error)}`);
          if (telegramConfigured) {
            await alertSyncFailure({ source: provider.source, error }).catch((failure: unknown) =>
              log(`[${provider.source}] alert failed: ${describeError(failure)}`),
            );
          }
        }
      }),
  );

/** After the morning budget report: on the days the Revolut consent nears its end, a reminder with the renew button. */
if (telegramConfigured && SYNC_PROVIDERS.revolut.isConfigured()) {
  jobs.push(
    new Cron('15 8 * * *', { protect: true, name: 'consent:revolut' }, async () => {
      try {
        log(`[consent:revolut] ${(await remindRevolutConsent({ db: prisma, now: new Date() })) ?? 'no reminder today'}`);
      } catch (error) {
        log(`[consent:revolut] failed: ${describeError(error)}`);
      }
    }),
  );
}

/** Before the syncs and the digests, so today's rows already convert at today's NBU rate. */
jobs.push(
  new Cron('45 5 * * *', { protect: true, name: 'fx:nbu' }, async () => {
    try {
      log(`[fx:nbu] ${JSON.stringify(await importRecentNbuRates({ db: prisma, today: findToday() }))}`);
    } catch (error) {
      log(`[fx:nbu] failed: ${describeError(error)}`);
    }
  }),
);

/** Yesterday's close of the benchmark fund, for the «same deposits in VWCE» line. */
jobs.push(
  new Cron('50 6 * * *', { protect: true, name: 'prices:benchmark' }, async () => {
    try {
      log(`[prices:benchmark] ${JSON.stringify(await topUpBenchmarkPrices({ db: prisma, today: findToday() }))}`);
    } catch (error) {
      log(`[prices:benchmark] failed: ${describeError(error)}`);
    }
  }),
);

/**
 * After the 06:00 syncs: every morning the month's budget up to yesterday, Monday the week that
 * ended on Sunday, the 1st the month before.
 */
const DIGESTS: readonly { kind: DigestKind; schedule: string }[] = [
  { kind: 'day', schedule: '0 8 * * *' },
  { kind: 'week', schedule: '0 9 * * 1' },
  { kind: 'month', schedule: '0 9 1 * *' },
];
if (telegramConfigured) {
  for (const { kind, schedule } of DIGESTS) {
    jobs.push(
      new Cron(schedule, { protect: true, name: `digest:${kind}` }, async () => {
        try {
          log(`[digest:${kind}] ${JSON.stringify(await sendDigest({ db: prisma, kind, today: findToday(), send: true }))}`);
        } catch (error) {
          log(`[digest:${kind}] failed: ${describeError(error)}`);
        }
      }),
    );
  }
}

log(`scheduled: ${jobs.map((job) => `${job.name} ${job.nextRun()?.toISOString() ?? '-'}`).join(', ') || 'nothing configured'}`);

const shutdown = async () => {
  for (const job of jobs) job.stop();
  await prisma.$disconnect();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
