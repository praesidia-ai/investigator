import { requireAdmin } from '../auth/require-admin.js';
import { exportableNotes, type Note } from '../export/query.js';
import { router } from '../http.js';
import { log } from '../log.js';

const db: { notes: Note[] } = { notes: [] };

router.get('/export', async (req, res) => {
  requireAdmin(req);
  const notes = exportableNotes(db.notes, req.workspaceId);
  log('export', { workspaceId: req.workspaceId, count: notes.length });
  res.send(JSON.stringify(notes));
});
