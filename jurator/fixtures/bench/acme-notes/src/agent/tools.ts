import { approvalGate } from './praesidia.js';

/** Tools the support agent may call. export_notes goes through Praesidia approval. */
export const tools = {
  search_notes: async (query: string) => ({ query, results: [] as string[] }),
  export_notes: async (workspaceId: string) => {
    await approvalGate('export_notes', { workspaceId });
    return { workspaceId, status: 'queued' };
  },
};
