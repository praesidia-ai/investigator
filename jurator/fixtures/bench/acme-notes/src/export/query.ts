export interface Note { id: string; workspaceId: string; body: string; deletedAt: Date | null; archivedAt: Date | null }

/** The notes an export may contain. */
export function exportableNotes(all: Note[], workspaceId: string): Note[] {
  return all.filter((n) => n.workspaceId === workspaceId && n.deletedAt === null && n.archivedAt === null);
}
