import { assertAccess } from './access.ts';
import { exportData } from './exporter.ts';
import { router } from './http.ts';

router.post('/export', async (req, res) => {
  const { tenant, dataset } = req.params;
  await assertAccess(req, tenant, dataset);
  res.json(await exportData(tenant, dataset, req.job));
});
