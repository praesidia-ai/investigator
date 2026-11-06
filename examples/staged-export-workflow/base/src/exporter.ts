import type { Job } from './http.ts';
import { drain, enqueue } from './worker.ts';

export async function exportData(
  tenant: string,
  resource: string,
  job: Job,
): Promise<{ queued: string; delivered: number }> {
  enqueue(job);
  return { queued: `${tenant}/${resource}`, delivered: await drain() };
}
