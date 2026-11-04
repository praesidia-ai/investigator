import { router } from '../http.js';

router.get('/notes', async (req, res) => {
  res.send(JSON.stringify({ workspaceId: req.workspaceId, notes: [] }));
});
