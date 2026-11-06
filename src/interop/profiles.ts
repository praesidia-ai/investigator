import { CANCELLATION_PROFILE } from '../cancellation/schemas.js';
import { CUSTOMER_EXPORT_APPROVAL_PROFILE } from '../core/control-profiles.js';
import { jsonDigest, type JsonValue } from '../core/json.js';
import { EXPORT_EVIDENCE_REQUIREMENTS } from '../evidence-plans/requirements.js';

export interface InteropProfile {
  readonly id: string;
  readonly version: number;
  /** Canonical-JSON digest of what the verifier requires; a reviewed mapping must quote it. */
  readonly requirementsDigest: string;
  readonly kind: 'customer-export-approval' | 'work-revocation';
}

const digest = (value: unknown): string => jsonDigest(value as JsonValue);

/** Registry of verifiers an operator can map a promise to. Unknown ids are 'unsupported', never guessed. */
export const INTEROP_PROFILES: readonly InteropProfile[] = Object.freeze([
  {
    id: CUSTOMER_EXPORT_APPROVAL_PROFILE.id,
    version: CUSTOMER_EXPORT_APPROVAL_PROFILE.version,
    kind: 'customer-export-approval',
    requirementsDigest: digest({
      profile: CUSTOMER_EXPORT_APPROVAL_PROFILE,
      evidence: EXPORT_EVIDENCE_REQUIREMENTS,
    }),
  },
  {
    id: CANCELLATION_PROFILE.id,
    version: CANCELLATION_PROFILE.version,
    kind: 'work-revocation',
    requirementsDigest: digest({ profile: CANCELLATION_PROFILE }),
  },
]);

export function findInteropProfile(id: string, version: number): InteropProfile | undefined {
  return INTEROP_PROFILES.find((p) => p.id === id && p.version === version);
}
