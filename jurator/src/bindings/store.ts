// Owner: WP-B. .jurator/bindings.json: `{ schemaVersion: 1, items }`, sorted by id, validated on read and write.
import { mkdir, readFile, rename, writeFile } from 'node:fs/promises';
import { dirname, join } from 'node:path';
import { bindingSchema, itemsFile, type Binding, type Store } from '../contracts.js';
import { BRAND } from '../brand.js';
import { JuratorError } from '../util/errors.js';
import { prettyJson } from '../util/json.js';
import { compareIds } from '../workspace/index.js';

export const BINDINGS_FILE = 'bindings.json';
const bindingsFile = itemsFile(bindingSchema);

export const bindingsPath = (store: Pick<Store, 'dir'>): string => join(store.dir, BINDINGS_FILE);
const rel = `${BRAND.folder}/${BINDINGS_FILE}`;

const issues = (error: { issues: ReadonlyArray<{ path: PropertyKey[]; message: string }> }): string =>
  error.issues
    .slice(0, 3)
    .map((i) => `${i.path.map(String).join('.') || '(root)'}: ${i.message}`)
    .join('; ');

export const byBindingId = (a: Binding, b: Binding): number => compareIds(a.id, b.id);

/** Missing file -> []. A file that is not valid JSON or not the expected shape is an error (fix it or restore it from git). */
export async function readBindings(store: Pick<Store, 'dir'>): Promise<Binding[]> {
  let text: string;
  try {
    text = await readFile(bindingsPath(store), 'utf8');
  } catch (error) {
    if ((error as NodeJS.ErrnoException).code === 'ENOENT') return [];
    throw error;
  }
  let raw: unknown;
  try {
    raw = JSON.parse(text);
  } catch {
    throw new JuratorError('BAD_WORKSPACE_FILE', `${rel} is not valid JSON. Fix it or restore it from git.`);
  }
  const parsed = bindingsFile.safeParse(raw);
  if (!parsed.success) throw new JuratorError('BAD_WORKSPACE_FILE', `${rel} does not match the expected shape: ${issues(parsed.error)}`);
  return [...parsed.data.items].sort(byBindingId);
}

/** Validates every item, refuses duplicate ids, sorts by id and writes atomically (temp file + rename). */
export async function writeBindings(store: Pick<Store, 'dir'>, items: readonly Binding[]): Promise<void> {
  const sorted = [...items].sort(byBindingId);
  const dup = sorted.find((b, i) => i > 0 && sorted[i - 1]?.id === b.id);
  if (dup) throw new JuratorError('BAD_WORKSPACE_WRITE', `Refusing to write ${rel}: the id ${dup.id} appears twice.`);
  const parsed = bindingsFile.safeParse({ schemaVersion: 1, items: sorted });
  if (!parsed.success) throw new JuratorError('BAD_WORKSPACE_WRITE', `Refusing to write ${rel}: ${issues(parsed.error)}`);
  const path = bindingsPath(store);
  await mkdir(dirname(path), { recursive: true });
  const tmp = `${path}.${process.pid}.tmp`;
  await writeFile(tmp, prettyJson(parsed.data), 'utf8');
  await rename(tmp, path);
}
