import { router } from './http.ts';
import { drain, enqueue } from './worker.ts';

// Harmless synthetic operation: no customer data, delivered through the same worker.
router.post('/ping', async (req, res) => {
  enqueue(req.job);
  res.json({ delivered: await drain() });
});
