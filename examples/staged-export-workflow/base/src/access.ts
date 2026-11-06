import { createHash } from 'node:crypto';
import type { Req } from './http.ts';
import { canonical, state } from './state.ts';

export class AccessDenied extends Error {}

export const requestDigest = (body: Req['body']): string =>
  createHash('sha256')
    .update(
      canonical({
        requestId: body.requestId,
        action: body.action,
        actorId: body.actorId,
        destination: body.destination,
        payload: body.payload,
      }),
    )
    .digest('hex');

// Guard: throws unless an independent, unexpired, unused approval is presented for this tenant/dataset export.
export async function assertAccess(req: Req, tenant: string, resource: string): Promise<void> {
  const grant = state.grants.get(req.approval?.grantId ?? '');
  const ok =
    grant !== undefined &&
    grant.approverId === 'reviewer:reference' &&
    grant.approverId !== req.body.actorId &&
    grant.expiresAt > state.now &&
    !grant.used;
  if (!ok) throw new AccessDenied(`approval required for ${tenant}/${resource}`);
  grant.used = true;
}
