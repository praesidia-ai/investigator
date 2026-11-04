import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { BRAND } from '../brand.js';

/** Keys a user may keep in `~/.jurator/credentials.json` instead of exporting them in every shell. */
const FILE_KEYS = ['META_API_KEY', 'MODEL_API_KEY', 'MODEL_BASE_URL', 'MODEL_ID', 'PRAESIDIA_API_KEY', 'PRAESIDIA_ORG'] as const;

/** `$JURATOR_HOME/credentials.json`, default `~/.jurator/credentials.json`. */
export function userCredentialsPath(env: NodeJS.ProcessEnv): string {
  const home = env.JURATOR_HOME && env.JURATOR_HOME.length > 0 ? env.JURATOR_HOME : join(env.HOME ?? homedir(), BRAND.folder);
  return join(home, 'credentials.json');
}

/**
 * Returns a copy of `env` where any of FILE_KEYS that is missing is filled from the user's credentials file.
 * The environment always wins. Values are never printed; a missing or unreadable file changes nothing.
 */
export function withFileCredentials(env: NodeJS.ProcessEnv): NodeJS.ProcessEnv {
  let file: Record<string, unknown>;
  try {
    const raw: unknown = JSON.parse(readFileSync(userCredentialsPath(env), 'utf8'));
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return env;
    file = raw as Record<string, unknown>;
  } catch {
    return env;
  }
  const merged: NodeJS.ProcessEnv = { ...env };
  for (const key of FILE_KEYS) {
    const value = file[key];
    if ((merged[key] === undefined || merged[key] === '') && typeof value === 'string' && value.length > 0) merged[key] = value;
  }
  return merged;
}
