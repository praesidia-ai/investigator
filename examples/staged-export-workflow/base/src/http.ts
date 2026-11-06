// Minimal router so the analyzer reads familiar `router.post(path, handler)` registrations.
export interface Req {
  params: { tenant: string; dataset: string };
  body: {
    requestId: string;
    action: string;
    actorId: string;
    destination: string;
    payload: Record<string, unknown>;
  };
  approval: { grantId?: string } | undefined;
  job: Job;
}
export interface Job {
  correlation: { runId: string; scenarioId: string; attemptId: string; challenge: string };
  effect: Req['body'];
  /** Computed by the HTTP shell so the worker stays a shallow call chain for the analyzer. */
  requestDigest: string;
}
export interface Res {
  json(value: unknown): void;
}
export type Handler = (req: Req, res: Res) => unknown;
export const router = {
  routes: new Map<string, Handler>(),
  post(path: string, handler: Handler): void {
    this.routes.set(path, handler);
  },
};
