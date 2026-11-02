import type { CheckResult, ControlCase } from './schemas.js';

/** Selected by the operator, never instantiated from model-supplied URLs or commands. */
export interface ControlCheckAdapter {
  readonly id: string;
  readonly version: 1;
  readonly subjectRevision: string;
  readonly configurationDigest?: string;
  runChecks(signal: AbortSignal): Promise<readonly CheckResult[]>;
}

/** Public adapter provenance contains identity/digests, never URLs or transport credentials. */
export function controlResultReference(controlCase: ControlCase): string {
  const target = controlCase.controlledTarget;
  if (!target) throw new Error('A controlled target is required.');
  if (target.kind === 'local-http-export' && !target.configurationDigest)
    return `local-http-export:v1:${controlCase.subject.revision}`;
  return `controlled-target:${target.kind}:v${target.version}:${controlCase.subject.revision}:${target.configurationDigest ?? 'unbound'}`;
}

/** Keep fixture answers and transport configuration outside model context. */
export function modelFacingControl(controlCase: ControlCase) {
  const { referenceTarget, controlledTarget, ...context } = controlCase;
  return { ...context, hasTestTarget: Boolean(referenceTarget || controlledTarget) };
}
