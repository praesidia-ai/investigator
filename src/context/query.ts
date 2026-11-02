import { InvestigatorError } from '../core/errors.js';
import { parseInput } from '../core/parse.js';
import { checkClientSystemSnapshotDigest, entityKey } from './project.js';
import {
  contextQuerySchema,
  type ClientSystemSnapshot,
  type ContextQueryResult,
} from './schemas.js';

/**
 * Pure, bounded navigation of the selected snapshot. Edges of every basis and
 * assessment are retained; a configured or contradicted route is never silently
 * converted into an observed route. Nothing is fetched or executed here.
 */
export function queryClientContext(
  input: ClientSystemSnapshot,
  queryInput: unknown,
): ContextQueryResult {
  const snapshot = checkClientSystemSnapshotDigest(input);
  const query = parseInput(
    contextQuerySchema,
    queryInput,
    'INVALID_CONTEXT_QUERY',
    'Context query',
  );
  const entities = new Map(
    snapshot.context.entities.map((entity) => [entityKey(entity.ref), entity]),
  );
  const keys = [...new Set(query.anchors.map(entityKey))];
  if (
    keys.length !== query.anchors.length ||
    keys.length > query.maxEntities ||
    keys.some((key) => !entities.has(key))
  )
    throw new InvestigatorError(
      'INVALID_CONTEXT_QUERY',
      'Anchors must exist and fit within the entity limit.',
    );
  const selected = new Map(keys.map((key) => [key, 0]));
  const frontier: ContextQueryResult['frontier'][number][] = [];
  const seenFrontier = new Set<string>();
  const addFrontier = (
    reason: ContextQueryResult['frontier'][number]['reason'],
    reference: string,
  ) => {
    const key = JSON.stringify([reason, reference]);
    if (!seenFrontier.has(key)) {
      frontier.push({ reason, reference });
      seenFrontier.add(key);
    }
  };
  const queue = [...keys];
  while (queue.length) {
    const key = queue.shift()!;
    const depth = selected.get(key)!;
    for (const assertion of snapshot.context.assertions) {
      const subjectKey = entityKey(assertion.subject);
      const objectKey = assertion.object.kind === 'entity' ? entityKey(assertion.object.ref) : null;
      if (subjectKey !== key && objectKey !== key) continue;
      if (query.relations && !query.relations.includes(assertion.relation)) {
        addFrontier('relation-filter', assertion.id);
        continue;
      }
      if (objectKey === null) continue;
      const other = subjectKey === key ? objectKey : subjectKey;
      if (selected.has(other)) continue;
      if (depth >= query.maxDepth) addFrontier('depth-limit', other);
      else if (selected.size >= query.maxEntities) addFrontier('entity-limit', other);
      else {
        selected.set(other, depth + 1);
        queue.push(other);
      }
    }
  }
  for (const source of snapshot.context.sources) {
    if (
      !source.frontier.length &&
      (source.coverage !== 'complete' ||
        !['complete', 'not-applicable'].includes(source.pagination))
    )
      addFrontier('source-boundary', source.id);
    for (const boundary of source.frontier)
      addFrontier('source-boundary', `${source.id}:${boundary}`);
  }
  for (const reference of snapshot.context.scope.excludedResources)
    addFrontier('excluded-resource', reference);
  const assertions = snapshot.context.assertions.filter((assertion) => {
    if (
      !selected.has(entityKey(assertion.subject)) ||
      (query.relations && !query.relations.includes(assertion.relation))
    )
      return false;
    return assertion.object.kind !== 'entity' || selected.has(entityKey(assertion.object.ref));
  });
  return {
    entities: [...selected.keys()].map((key) => entities.get(key)!),
    assertions,
    frontier: frontier.filter(
      (item) =>
        !['depth-limit', 'entity-limit'].includes(item.reason) || !selected.has(item.reference),
    ),
    truncated: frontier.some(
      (item) =>
        ['depth-limit', 'entity-limit'].includes(item.reason) && !selected.has(item.reference),
    ),
    scope: 'selected-sources-only',
    completeness: 'not-established',
  };
}
