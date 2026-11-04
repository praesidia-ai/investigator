// Owner: HZ-1. Short ids for screens (backlog 14): `document-handling.09` says little and eats a column, so a long
// source alias is shown short (`doc.09`). The full id stays in JSON, in files and in every record; commands accept
// either spelling.
import type { PromiseRecord } from '../contracts.js';

/** Source aliases up to this long are shown as they are (privacy, security, praesidia). */
export const SHORT_ALIAS_MAX = 9;

const split = (id: string): [string, string] | null => {
  const at = id.lastIndexOf('.');
  return at > 0 ? [id.slice(0, at), id.slice(at + 1)] : null;
};

/** Candidate short names for a long alias, best first: "doc", "dh" (initials), "docu", "docum", ... */
function candidates(alias: string): string[] {
  const out: string[] = [];
  const parts = alias.split(/[-_.]+/u).filter(Boolean);
  const head = (parts[0] ?? alias).toLowerCase();
  out.push(head.slice(0, 3));
  if (parts.length > 1) out.push(parts.map((p) => p[0] ?? '').join('').toLowerCase());
  for (let n = 4; n < Math.min(head.length, SHORT_ALIAS_MAX); n += 1) out.push(head.slice(0, n));
  if (parts.length > 1) out.push(`${head.slice(0, 3)}-${(parts[1] ?? '').slice(0, 3)}`.toLowerCase());
  out.push(alias);
  return out.filter((c, i) => c.length > 0 && out.indexOf(c) === i);
}

/**
 * Source alias -> the alias shown on screens, for every alias in `ids` (promise ids or bare aliases). Short aliases
 * stay; a long one gets the first candidate no other alias uses (as its short or full name).
 */
export function aliasMap(ids: Iterable<string>): Map<string, string> {
  const aliases = new Set<string>();
  for (const id of ids) {
    const parts = split(id);
    aliases.add(parts ? parts[0] : id);
  }
  const sorted = [...aliases].sort();
  const taken = new Set(sorted.filter((a) => a.length <= SHORT_ALIAS_MAX));
  const map = new Map<string, string>();
  for (const a of sorted) {
    if (a.length <= SHORT_ALIAS_MAX) {
      map.set(a, a);
      continue;
    }
    const pick = candidates(a).find((c) => !taken.has(c) && !aliases.has(c)) ?? a;
    taken.add(pick);
    map.set(a, pick);
  }
  return map;
}

/** Shows promise ids short on screens: `short('document-handling.09')` -> "doc.09". */
export interface ShortIds {
  short(id: string): string;
  /** The full id for a typed id (full or short); undefined when it names no known promise. */
  full(id: string): string | undefined;
}

export function shortIds(ids: Iterable<string>): ShortIds {
  const all = [...ids];
  const map = aliasMap(all);
  const back = new Map<string, string>();
  for (const id of all) {
    const parts = split(id);
    if (!parts) continue;
    back.set(`${map.get(parts[0]) ?? parts[0]}.${parts[1]}`, id);
    back.set(id, id);
  }
  return {
    short: (id) => {
      const parts = split(id);
      if (!parts) return id;
      const a = map.get(parts[0]);
      return a ? `${a}.${parts[1]}` : id;
    },
    full: (id) => back.get(id.trim()),
  };
}

/** Short ids over a store's promises (every status, so a retired id still reads the same). */
export function shortIdsFor(promises: readonly Pick<PromiseRecord, 'id'>[]): ShortIds {
  return shortIds(promises.map((p) => p.id));
}
