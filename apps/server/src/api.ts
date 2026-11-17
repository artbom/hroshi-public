import { buildApp } from './app.ts';
import { prisma } from './db.ts';
import { env } from './env.ts';

const app = await buildApp();

const shutdown = async () => {
  await app.close();
  await prisma.$disconnect();
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);

await app.listen({ host: env.HOST, port: env.PORT });
