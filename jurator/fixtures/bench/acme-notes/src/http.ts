// A tiny router so the demo has no dependencies.
export interface Request { user: { id: string; role: 'admin' | 'member' }; workspaceId: string; query: Record<string, string> }
export interface Response { send(body: string): void; status(code: number): Response }
type Handler = (req: Request, res: Response) => Promise<void> | void;
const routes: Array<{ method: string; path: string; handler: Handler }> = [];
export const router = {
  get(path: string, handler: Handler) { routes.push({ method: 'GET', path, handler }); },
  post(path: string, handler: Handler) { routes.push({ method: 'POST', path, handler }); },
};
export function listRoutes() { return routes.map((r) => `${r.method} ${r.path}`); }
