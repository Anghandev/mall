import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

test('production configuration gives the EOA runtime independent primary and fallback RPCs', async () => {
  const source = await readFile(new URL('./prepare-config.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("await writeEnv('eoa-runtime.env'");
  const end = source.indexOf("await writeEnv('media-storage.env'");
  assert.ok(start >= 0 && end > start, 'EOA runtime configuration section is unavailable');
  const section = source.slice(start, end);
  assert.match(section, /line\('BSC_RPC_URL', rpc\)/);
  assert.match(section, /line\('BSC_FALLBACK_RPC_URL', fallbackRpc\)/);
  assert.match(source, /assertDistinctRoleWallets\(roleAddresses\.map/);
  assert.match(source, /Production role wallet collision/);
});

test('production Core configuration includes the queue Redis URL required by micro preflight', async () => {
  const source = await readFile(new URL('./prepare-config.mjs', import.meta.url), 'utf8');
  const start = source.indexOf("await writeEnv('core.env'");
  const end = source.indexOf("await writeEnv('eoa-runtime.env'");
  assert.ok(start >= 0 && end > start, 'Core configuration section is unavailable');
  const section = source.slice(start, end);
  assert.match(section, /line\('REDIS_URL', redisUrl\)/);
  assert.match(section, /line\('QUEUE_URL', redisUrl\)/);
});
