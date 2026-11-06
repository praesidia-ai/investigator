import type { Job } from './http.ts';
import { state } from './state.ts';

const queue: Job[] = [];

// Delegation: the route only enqueues; the worker delivers to the separately observed destination.
export function enqueue(job: Job): void {
  queue.push(job);
}

export async function drain(): Promise<number> {
  let delivered = 0;
  for (let job = queue.shift(); job; job = queue.shift()) {
    const reply = await fetch(`${state.observerUrl}/__investigator__/effects`, {
      method: 'POST',
      redirect: 'error',
      headers: {
        authorization: `Bearer ${state.captureToken}`,
        'content-type': 'application/json',
      },
      body: JSON.stringify({
        ...job.correlation,
        effect: { ...job.effect, requestDigest: job.requestDigest },
      }),
      signal: AbortSignal.timeout(3000),
    });
    if (reply.status !== 201) throw new Error('destination did not accept the delivery');
    delivered += 1;
  }
  return delivered;
}
