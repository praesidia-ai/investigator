// Owner: WP-M. Scripted ModelClient: answers come from files, never from the network.
import { readFile } from 'node:fs/promises';
import { basename, join, resolve } from 'node:path';
import type { ModelClient, ModelJsonRequest, ModelJsonResult, ModelUsage } from '../contracts.js';
import { JuratorError } from '../util/errors.js';
import { describeIssues } from './strict.js';

/** `compile:privacy` -> `compile__privacy.json`. */
export function scriptedFileName(task: string): string {
  const name = `${task.replaceAll(':', '__')}.json`;
  if (!task || basename(name) !== name || name.startsWith('.') || name.includes('\\')) {
    throw new JuratorError('SCRIPTED_TASK_INVALID', `The task key "${task}" cannot be used as a scripted file name.`);
  }
  return name;
}

export class ScriptedModelClient implements ModelClient {
  readonly id = 'scripted';
  readonly mode = 'scripted' as const;
  readonly dir: string;
  /** Task keys answered so far, in call order (handy in tests). */
  readonly tasks: string[] = [];

  constructor(dir: string, cwd: string = process.cwd()) {
    this.dir = resolve(cwd, dir);
  }

  /** Absolute path of the answer file for a task. */
  pathFor(task: string): string {
    return join(this.dir, scriptedFileName(task));
  }

  async json<T>(request: ModelJsonRequest<T>): Promise<ModelJsonResult<T>> {
    const path = this.pathFor(request.task);
    let text: string;
    try {
      text = await readFile(path, 'utf8');
    } catch {
      throw new JuratorError('SCRIPTED_ANSWER_MISSING', `No scripted answer for ${request.task} at ${path}`);
    }
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new JuratorError('SCRIPTED_ANSWER_INVALID', `The scripted answer at ${path} is not valid JSON.`);
    }
    const checked = request.schema.safeParse(parsed);
    if (!checked.success) {
      throw new JuratorError(
        'SCRIPTED_ANSWER_INVALID',
        `The scripted answer at ${path} does not match ${request.schemaName}: ${describeIssues(checked.error)}`,
      );
    }
    this.tasks.push(request.task);
    const usage: ModelUsage = { id: this.id, mode: 'scripted', inputTokens: 0, outputTokens: 0, usd: 0 };
    return { value: checked.data, usage };
  }
}
