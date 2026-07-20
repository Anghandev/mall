import { createCoreRuntime } from './bootstrap.ts';

const port = Number(process.env.PORT ?? '3000');
const host = process.env.HOST ?? '127.0.0.1';
if (!Number.isSafeInteger(port) || port <= 0 || port > 65_535) throw new Error('PORT must be between 1 and 65535');

const runtime = await createCoreRuntime(process.env);
await new Promise<void>((resolve, reject) => {
  runtime.server.once('error', reject);
  runtime.server.listen(port, host, resolve);
});
console.log(`24K商城 Core listening on http://${host}:${port}`);

const shutdown = async () => {
  await runtime.close();
  process.exit(0);
};
process.once('SIGINT', shutdown);
process.once('SIGTERM', shutdown);
