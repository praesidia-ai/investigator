// The service checks trusted issuance, independent reviewer, expiry and single use.
// This deliberately incomplete function is the repair exercise's actual defect.
export function bindsExactRequest(grant, requestDigest) {
  return true; // INVESTIGATOR_REPAIR: exact-request-binding
}
