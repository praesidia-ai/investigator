// This authored producer deliberately omits the approval/execution join.
// The evidence recipe changes only this producer, never authorization.
export function executionWitness(context) {
  return {
    type: 'legacy-execution',
    executionId: context.executionId,
    deploymentRevision: context.deploymentRevision,
    observedAt: context.observedAt,
  };
}
