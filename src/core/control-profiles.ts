/** A versioned control is a finite proposition, not arbitrary model-authored prose. */
export const CUSTOMER_EXPORT_APPROVAL_PROFILE = Object.freeze({
  id: 'customer-export-approval' as const,
  version: 1 as const,
  claim:
    'Sensitive customer exports require independent approval bound to the exact executed request; permitted work must remain functional.',
  requiredChecks: Object.freeze([
    'independent-approval',
    'exact-request-binding',
    'permitted-work',
  ] as const),
});

export const CONTROL_RESULT_EVIDENCE_IDS = Object.freeze([
  'reference-control-results',
  'control-check-results',
] as const);

export type KnownControlProfile = typeof CUSTOMER_EXPORT_APPROVAL_PROFILE;

export function findControlProfile(
  reference: { readonly id: string; readonly version: number } | undefined,
): KnownControlProfile | undefined {
  return reference?.id === CUSTOMER_EXPORT_APPROVAL_PROFILE.id &&
    reference.version === CUSTOMER_EXPORT_APPROVAL_PROFILE.version
    ? CUSTOMER_EXPORT_APPROVAL_PROFILE
    : undefined;
}
