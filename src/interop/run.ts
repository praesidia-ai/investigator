import { readFile } from 'node:fs/promises';
import { dirname, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';
import { z } from 'zod';
import { runCancellationWorkflow } from '../cancellation/workflow.js';
import { cancellationFixtureModeSchema } from '../cancellation/target.js';
import { loadLocalCase } from '../connectors/local-bundle.js';
import { investigate } from '../core/coordinator.js';
import { InvestigatorError } from '../core/errors.js';
import { jsonDigest, type JsonValue } from '../core/json.js';
import { referenceVariantSchema } from '../core/schemas.js';
import { ScriptedReferenceProvider } from '../providers/scripted-reference.js';
import {
  createHttpApprovalTarget,
  httpApprovalTargetConfigSchema,
} from '../targets/http-approval-target.js';
import { findInteropProfile } from './profiles.js';
import {
  InteropError,
  assertNoCredentialMaterial,
  canonicalJson,
  deriveMismatch,
  parseRequest,
  sealResult,
  sha256Text,
  type BehavioralVerdict,
  type InvestigationRequest,
  type InvestigationResult,
  type ResultBody,
} from './schema.js';

/** Operator authorization: the only way anything executes. */
const scriptedLocalSchema = z
  .object({
    kind: z.literal('scripted-local'),
    schemaVersion: z.literal(1),
    adapterId: z.string().min(1).max(160),
    /** customer-export-approval: reference variant; work-revocation: cancellation fixture mode. */
    variant: z.string().min(1).max(64).optional(),
  })
  .strict();
/**
 * A real local target through the existing approval-target-v1 contract. Endpoints and credential variable names live
 * only in the operator-owned `targetConfig` file (path relative to this file); requests and models never supply them.
 * The digest binds this file, which pins the target file's sha256.
 */
const httpApprovalSchema = z
  .object({
    kind: z.literal('http-approval-target'),
    schemaVersion: z.literal(1),
    adapterId: z.string().min(1).max(160),
    targetConfig: z.string().min(1).max(1024),
    /** sha256 of the target file's exact bytes: swapping the file after the request was sealed is refused. */
    targetConfigSha256: z.string().regex(/^[a-f0-9]{64}$/u),
  })
  .strict();
export const adapterConfigSchema = z.discriminatedUnion('kind', [
  scriptedLocalSchema,
  httpApprovalSchema,
]);
export type AdapterConfig = z.infer<typeof adapterConfigSchema>;

/** Same canonical digest Jurator computes over the operator's config file. */
export const adapterConfigDigest = (parsedJson: unknown): string =>
  sha256Text(canonicalJson(parsedJson));

export async function readAdapterConfig(
  path: string,
): Promise<{ config: AdapterConfig; digest: string }> {
  let raw: unknown;
  try {
    raw = JSON.parse(await readFile(path, 'utf8'));
  } catch {
    throw new InteropError(
      'ADAPTER_CONFIG_UNREADABLE',
      'The --adapter-config file is not readable JSON.',
    );
  }
  assertNoCredentialMaterial(raw);
  const parsed = adapterConfigSchema.safeParse(raw);
  if (!parsed.success)
    throw new InteropError(
      'ADAPTER_CONFIG_INVALID',
      'The adapter configuration is not a supported scripted-local or http-approval-target config.',
    );
  const config: AdapterConfig =
    parsed.data.kind === 'http-approval-target'
      ? { ...parsed.data, targetConfig: resolve(dirname(path), parsed.data.targetConfig) }
      : parsed.data;
  return { config, digest: adapterConfigDigest(raw) };
}

const EXAMPLE = fileURLToPath(new URL('../../examples/customer-export/', import.meta.url));

interface Observed {
  status: 'completed' | 'incomplete' | 'failed';
  verdict: BehavioralVerdict | null;
  statement: string | null;
  captures: ResultBody['captures'];
  missing: string[];
  scope: string[];
}
const cap = (
  id: string,
  kind: string,
  status: ResultBody['captures'][number]['status'],
  summary: string,
  value: unknown,
) => ({
  id,
  kind,
  status,
  summary: summary.slice(0, 2048) || id,
  digest: jsonDigest(value as JsonValue),
});

async function observeApproval(
  config: AdapterConfig,
  env: Readonly<Record<string, string | undefined>>,
  signal?: AbortSignal,
): Promise<Observed> {
  const bundle = await loadLocalCase(EXAMPLE);
  if (config.kind === 'http-approval-target') {
    let targetConfig;
    try {
      const text = await readFile(config.targetConfig, 'utf8');
      if (sha256Text(text) !== config.targetConfigSha256) throw new Error('swapped');
      targetConfig = httpApprovalTargetConfigSchema.parse(JSON.parse(text));
    } catch {
      throw new InteropError(
        'ADAPTER_CONFIG_INVALID',
        'The operator target config is unreadable, invalid, or does not match the digest bound in the adapter config.',
      );
    }
    const checkAdapter = createHttpApprovalTarget(targetConfig, env);
    delete bundle.controlCase.referenceTarget;
    const digest = checkAdapter.configurationDigest ?? '';
    bundle.controlCase.id = `interop-${digest.slice(0, 12)}`;
    bundle.controlCase.subject = {
      id: 'operator-selected-export-service',
      environment: 'repository',
      revision: targetConfig.subjectRevision,
    };
    bundle.controlCase.controlledTarget = {
      kind: checkAdapter.id,
      version: checkAdapter.version,
      ...(checkAdapter.configurationDigest
        ? { configurationDigest: checkAdapter.configurationDigest }
        : {}),
    };
    const run = await investigate({
      ...bundle,
      provider: new ScriptedReferenceProvider(),
      checkAdapter,
      ...(signal ? { signal } : {}),
    });
    return {
      status: run.status,
      verdict: run.finding?.verdict ?? null,
      statement: run.finding?.statement.slice(0, 4096) ?? null,
      captures: [
        cap('target-adapter', 'adapter', 'PASS', 'operator target configuration digest', {
          configurationDigest: digest,
          subjectRevision: targetConfig.subjectRevision,
        }),
        ...run.checks.map((c) => cap(c.id, 'control-check', c.status, c.summary, c)),
      ],
      missing: [...(run.finding?.missingEvidence ?? [])],
      scope: run.limitations.map((l) => l.slice(0, 2048)),
    };
  }
  const variant = referenceVariantSchema.safeParse(
    (config.kind === 'scripted-local' ? config.variant : undefined) ?? 'request-unbound',
  );
  if (!variant.success)
    throw new InteropError('ADAPTER_CONFIG_INVALID', 'Unknown reference variant.');
  bundle.controlCase.referenceTarget = { kind: 'customer-export-reference', variant: variant.data };
  const run = await investigate({
    ...bundle,
    provider: new ScriptedReferenceProvider(),
    ...(signal ? { signal } : {}),
  });
  return {
    status: run.status,
    verdict: run.finding?.verdict ?? null,
    statement: run.finding?.statement.slice(0, 4096) ?? null,
    captures: run.checks.map((c) => cap(c.id, 'control-check', c.status, c.summary, c)),
    missing: [...(run.finding?.missingEvidence ?? [])],
    scope: run.limitations.map((l) => l.slice(0, 2048)),
  };
}

async function observeRevocation(config: AdapterConfig, signal?: AbortSignal): Promise<Observed> {
  if (config.kind !== 'scripted-local')
    throw new InteropError(
      'ADAPTER_CONFIG_INVALID',
      'Work revocation has no approval-target adapter; use a scripted-local config.',
    );
  const mode = cancellationFixtureModeSchema.safeParse(config.variant ?? 'cached-worker');
  if (!mode.success)
    throw new InteropError('ADAPTER_CONFIG_INVALID', 'Unknown cancellation fixture mode.');
  const c = await runCancellationWorkflow({
    mode: mode.data,
    repair: false,
    ...(signal ? { signal } : {}),
  });
  const before = c.before;
  return {
    status: before.status,
    verdict: before.finding?.verdict ?? before.assessment.verdict,
    statement: before.finding?.statement?.slice(0, 4096) ?? null,
    captures: before.assessment.checks.map((k, i) =>
      cap(`${k.experimentId ?? 'suite'}-${i}`, 'experiment', k.status, k.reason, k),
    ),
    missing: before.assessment.missingExperiments.map((e) => `experiment ${e}`),
    scope: [...before.assessment.limitations],
  };
}

/**
 * Executes only when the request is bound to this operator's adapter config and to a registered profile.
 * Unknown profile, version or requirements digest => sealed 'unsupported' result, nothing run.
 */
export async function runInteropRequest(input: {
  readonly request: unknown;
  readonly adapter: { readonly config: AdapterConfig; readonly digest: string };
  readonly signal?: AbortSignal;
  readonly env?: Readonly<Record<string, string | undefined>>;
  readonly now?: () => Date;
}): Promise<InvestigationResult> {
  const request: InvestigationRequest = parseRequest(input.request);
  if (
    request.adapter.configurationDigest !== input.adapter.digest ||
    request.adapter.id !== input.adapter.config.adapterId
  )
    throw new InteropError(
      'ADAPTER_MISMATCH',
      'The operator adapter configuration does not match the adapter identity and digest in the request.',
    );
  const m = request.mapping;
  // The request budget is enforced: runtime beyond maxRuntimeSeconds aborts the adapter (sealed as 'failed').
  const budget = AbortSignal.timeout(request.budget.maxRuntimeSeconds * 1000);
  const signal = input.signal ? AbortSignal.any([input.signal, budget]) : budget;
  // Tenant, workflow, environment and window are never read by an adapter; say what was actually observed, first.
  const observed =
    input.adapter.config.kind === 'http-approval-target'
      ? 'Observed: the operator-configured local approval target and its independent destination only. The wire protocol carries no tenant; requested tenant, workflow, environment and window were not observed.'
      : 'Scripted local fixture; requested tenant, workflow, environment and window were not observed.';
  const scopeOf = (more: readonly string[]) =>
    [observed, `Requested scope (not verified): ${request.scope}`, ...more].slice(0, 32);
  const profile = findInteropProfile(m.profileId, m.profileVersion);
  const base = {
    schema: 'praesidia.investigation-result/v1' as const,
    createdAt: (input.now?.() ?? new Date()).toISOString(),
    requestDigest: request.digest,
    adapter: request.adapter,
    static: request.trigger.codeCheck,
  };
  const none = (reason: string): InvestigationResult =>
    sealResult({
      ...base,
      profile: profile
        ? {
            id: profile.id,
            version: profile.version,
            requirementsDigest: profile.requirementsDigest,
          }
        : null,
      execution: { status: 'unsupported', reason },
      behavioral: { verdict: null, statement: null },
      mismatch: null,
      scope: ['Nothing was executed.'],
      captures: [],
      missingEvidence: [],
      proposedAction: {
        kind: 'review',
        description: 'Review the mapping against a registered profile before retrying.',
      },
    });
  if (!profile) return none(`No registered profile ${m.profileId} v${m.profileVersion}.`);
  if (profile.requirementsDigest !== m.requirementsDigest)
    return none(
      'The reviewed requirements digest does not match the registered profile requirements.',
    );
  let o: Observed;
  try {
    o =
      profile.kind === 'customer-export-approval'
        ? await observeApproval(input.adapter.config, input.env ?? process.env, signal)
        : await observeRevocation(input.adapter.config, signal);
    if (signal.aborted)
      throw new InvestigatorError(
        'RUN_ABORTED',
        'The request runtime budget or a cancellation stopped the run.',
      );
  } catch (error) {
    if (error instanceof InteropError) throw error;
    const msg =
      error instanceof InvestigatorError
        ? `${error.code}: ${error.message}`
        : 'The adapter run failed.';
    return sealResult({
      ...base,
      profile: {
        id: profile.id,
        version: profile.version,
        requirementsDigest: profile.requirementsDigest,
      },
      execution: { status: 'failed', reason: msg.slice(0, 2048) },
      behavioral: { verdict: null, statement: null },
      mismatch: null,
      scope: scopeOf([]),
      captures: [],
      missingEvidence: [],
      proposedAction: null,
    });
  }
  const verdict = o.status === 'failed' ? null : o.verdict;
  const action =
    verdict === 'contradicted'
      ? {
          kind: 'repair' as const,
          description:
            'Fix the observed gap in the runtime control, then retest keeping permitted work functional.',
        }
      : verdict === 'supported'
        ? {
            kind: 'none' as const,
            description: 'No action: the mapped behavior was supported in this scope.',
          }
        : {
            kind: 'collect-evidence' as const,
            description: 'Collect the missing evidence, then rerun the investigation.',
          };
  return sealResult({
    ...base,
    profile: {
      id: profile.id,
      version: profile.version,
      requirementsDigest: profile.requirementsDigest,
    },
    execution: { status: o.status, reason: null },
    behavioral: { verdict, statement: o.statement },
    mismatch: deriveMismatch(request.trigger.codeCheck, verdict),
    scope: scopeOf(o.scope),
    captures: o.status === 'failed' ? [] : o.captures.slice(0, 64),
    missingEvidence: o.missing.slice(0, 32),
    proposedAction: action,
  });
}
