import type { Request } from '../http.js';

export class ForbiddenError extends Error {}

/** Throws unless the caller is an admin of the workspace. */
export function requireAdmin(req: Request): void {
  if (req.user.role !== 'admin') throw new ForbiddenError('admins only');
}
