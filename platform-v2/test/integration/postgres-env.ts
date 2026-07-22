import { existsSync, readFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import path from 'node:path';

const PROJECT_ROOT = fileURLToPath(new URL('../../../', import.meta.url));
const LOCAL_ENV_FILES = Object.freeze(['.env', '.env.runtime', '.env.wallets.local']);

export function requiredPostgresAdminUrl(gateName = 'gate') {
  loadLocalPostgresAdminUrl();
  const value = process.env.POSTGRES_ADMIN_URL;
  if (!value || !/^postgres(?:ql)?:\/\//i.test(value)) {
    throw new Error(`POSTGRES_ADMIN_URL is required for the real PostgreSQL ${gateName} gate; set it in the shell or local ignored env`);
  }
  return value;
}

function loadLocalPostgresAdminUrl() {
  if (process.env.POSTGRES_ADMIN_URL) return;
  for (const file of LOCAL_ENV_FILES) {
    const value = readEnvKey(path.join(PROJECT_ROOT, file), 'POSTGRES_ADMIN_URL');
    if (value) {
      process.env.POSTGRES_ADMIN_URL = value;
      return;
    }
  }
}

function readEnvKey(file: string, key: string) {
  if (!existsSync(file)) return undefined;
  for (const line of readFileSync(file, 'utf8').split(/\r?\n/)) {
    const match = line.match(/^\s*([A-Za-z_][A-Za-z0-9_]*)\s*=\s*(.*)\s*$/);
    if (!match || match[1] !== key) continue;
    const raw = match[2];
    if (raw === undefined) continue;
    const parsed = unquote(raw.trim());
    return parsed === '' ? undefined : parsed;
  }
  return undefined;
}

function unquote(value: string) {
  if ((value.startsWith('"') && value.endsWith('"')) || (value.startsWith("'") && value.endsWith("'"))) {
    return value.slice(1, -1);
  }
  return value;
}
