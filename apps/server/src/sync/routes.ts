import {
  ConsentCompletedSchema,
  ConsentCompletionSchema,
  ConsentStartSchema,
  FileImportRequestSchema,
  FileImportResultSchema,
  SyncParamsSchema,
  SyncStatusListSchema,
} from '@hroshi/schema';
import type { FastifyPluginAsyncZod } from 'fastify-type-provider-zod';
import { z } from 'zod';

import { prisma } from '../db.ts';
import { badRequest } from '../http-errors.ts';
import { completeRevolutConsent, startRevolutConsent } from './enable-banking/consent.ts';
import { importFiles } from './files.ts';
import { pullRevolutHistory } from './enable-banking/provider.ts';
import { describeSyncStatus, recordSyncRun, runSync } from './runner.ts';

export const syncRoutes: FastifyPluginAsyncZod = async (app) => {
  /** The bank hands out full history only for a short while after consent, so the pull starts right away. */
  const finishRevolutConsent = async ({ code, state }: { code: string; state: string }) => {
    const completed = await completeRevolutConsent({ db: prisma, code, state });
    recordSyncRun({ db: prisma, source: 'revolut', task: () => pullRevolutHistory(prisma) }).catch((failure: unknown) =>
      app.log.error({ err: failure }, 'revolut history pull failed'),
    );
    return completed;
  };

  app.get('/sync', { schema: { response: { 200: SyncStatusListSchema } } }, async () => describeSyncStatus(prisma));

  /** Runs in the background: a Monobank pass waits a minute between calls. */
  app.post('/sync/:source', { schema: { params: SyncParamsSchema } }, async (request, reply) => {
    const { source } = request.params;
    runSync({ db: prisma, source, log: (message) => app.log.info(message) }).catch((error: unknown) =>
      app.log.error({ err: error, source }, 'sync failed'),
    );
    reply.code(202);
    return { started: true };
  });

  /** A Mono export of a few years runs to megabytes; the default limit is one. */
  app.post(
    '/import',
    { bodyLimit: 50 * 1024 * 1024, schema: { body: FileImportRequestSchema, response: { 200: FileImportResultSchema } } },
    async (request) => {
      const { kind, dryRun, files } = request.body;
      try {
        return await importFiles({
          db: prisma,
          kind,
          dryRun,
          files: files.map((file) => ({ name: file.name, modified: new Date(file.lastModified), content: file.content })),
          log: (message) => app.log.info(message),
        });
      } catch (error) {
        // A file of the wrong shape is the owner's to fix, not a server fault.
        if (error instanceof z.ZodError) throw badRequest(`Файл не схожий на очікуваний: ${z.prettifyError(error)}`);
        throw error;
      }
    },
  );

  app.post('/connections/revolut/start', { schema: { response: { 200: ConsentStartSchema } } }, async () =>
    startRevolutConsent(prisma),
  );

  app.get(
    '/connections/revolut/callback',
    {
      schema: {
        querystring: z.object({ code: z.string().min(1).optional(), state: z.string().min(1), error: z.string().optional() }),
      },
    },
    async (request, reply) => {
      const { code, state, error } = request.query;
      // Cancelling in the bank comes back with `error` instead of `code`; nothing to finish then.
      if (code === undefined) {
        app.log.warn({ error }, 'revolut consent not granted');
        return reply.redirect('/#sync');
      }
      await finishRevolutConsent({ code, state });
      return reply.redirect('/#sync');
    },
  );

  /** For a redirect address nothing listens on: the bot passes on the code from the address the owner pastes. */
  app.post(
    '/connections/revolut/complete',
    { schema: { body: ConsentCompletionSchema, response: { 200: ConsentCompletedSchema } } },
    async (request) => finishRevolutConsent(request.body),
  );
};
