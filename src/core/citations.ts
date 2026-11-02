import { InvestigatorError } from './errors.js';
import { boundedJsonValueSchema } from './bounded-json.js';
import type { EvidenceStore } from './evidence-store.js';
import { stableJson } from './json.js';
import { parseInput, parseJson } from './parse.js';
import {
  locatorSchema,
  type Citation,
  type EvidenceArtifact,
  type EvidenceLocator,
} from './schemas.js';

export function readLocator(artifact: EvidenceArtifact, locator: EvidenceLocator): string {
  locator = parseInput(locatorSchema, locator, 'INVALID_LOCATOR', 'Evidence locator');
  if (locator.kind === 'lines') {
    const lines = artifact.content.split(/\r?\n/);
    if (locator.end < locator.start || locator.end > lines.length) {
      throw new InvestigatorError(
        'INVALID_LOCATOR',
        'The line range is outside the evidence snapshot.',
      );
    }
    return lines.slice(locator.start - 1, locator.end).join('\n');
  }
  if (artifact.mediaType !== 'application/json')
    throw new InvestigatorError('INVALID_LOCATOR', 'JSON pointers require JSON evidence.');
  let value = parseInput(
    boundedJsonValueSchema,
    parseJson(artifact.content),
    'INVALID_EVIDENCE',
    'JSON evidence',
  );
  if (locator.pointer !== '') {
    if (!locator.pointer.startsWith('/') || /~(?:[^01]|$)/.test(locator.pointer)) {
      throw new InvestigatorError('INVALID_LOCATOR', 'Expected an RFC 6901 JSON pointer.');
    }
    for (const token of locator.pointer.slice(1).split('/')) {
      const key = token.replace(/~1/g, '/').replace(/~0/g, '~');
      if (value === null || typeof value !== 'object' || !Object.hasOwn(value, key)) {
        throw new InvestigatorError(
          'INVALID_LOCATOR',
          'The JSON pointer does not resolve in this evidence.',
        );
      }
      if (Array.isArray(value)) {
        if (!/^(0|[1-9]\d*)$/.test(key))
          throw new InvestigatorError('INVALID_LOCATOR', 'Expected a canonical array index.');
        value = value[Number(key)]!;
      } else {
        value = value[key]!;
      }
    }
  }
  return stableJson(value);
}

export function validateCitations(citations: readonly Citation[], store: EvidenceStore): void {
  for (const citation of citations) {
    if (readLocator(store.get(citation.evidenceId), citation.locator) !== citation.quote) {
      throw new InvestigatorError(
        'CITATION_MISMATCH',
        'A quotation does not match the cited evidence and locator.',
      );
    }
  }
}
