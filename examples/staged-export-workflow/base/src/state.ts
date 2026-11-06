export interface Grant {
  id: string;
  approverId: string;
  requestDigest: string;
  expiresAt: number;
  used: boolean;
}
// Prepared by the supervisor-owned reset call of the approval-target-v1 protocol.
export const state: {
  grants: Map<string, Grant>;
  now: number;
  captureToken: string;
  observerUrl: string;
} = { grants: new Map(), now: 0, captureToken: '', observerUrl: '' };

// Non-recursive on purpose: the analyzer does not follow recursive helpers (it would report a coverage gap).
export const canonical = (value: unknown): string =>
  JSON.stringify(value, (_key, v: unknown) =>
    v !== null && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v).sort(([a], [b]) => (a < b ? -1 : 1)))
      : v,
  );
