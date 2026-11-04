// Owner: WP-M. `jurator doctor [--live] [--json]`: is the model set up? Never prints the key.
import { join } from 'node:path';
import { z } from 'zod';
import { BRAND } from '../../brand.js';
import { type Config, DEFAULT_CONFIG } from '../../contracts.js';
import { createModel, formatUsd, hasModelKey, priceFor } from '../../model/index.js';
import { readMetaEnvironment } from '../../model/meta/meta-config.js';
import { JuratorError } from '../../util/errors.js';
import { findRepoRoot, openStore } from '../../workspace/index.js';
import type { Command, CommandContext } from '../context.js';
import { dressed } from '../../render/screen.js';

const pingSchema = z.object({ ok: z.boolean(), word: z.string() });

interface DoctorReport {
  keySet: boolean;
  keyEnv: 'META_API_KEY' | 'MODEL_API_KEY' | null;
  model: string;
  modelSource: 'env MODEL_ID' | 'config' | 'default';
  reasoningEffort: string;
  priceKnown: boolean;
  endpoint: 'default' | 'custom';
  config: string | null;
  configNote: string | null;
  scriptedDir: string | null;
  live: { ok: boolean; latencyMs: number; inputTokens: number; outputTokens: number; usd: number } | null;
}

async function loadConfig(ctx: CommandContext): Promise<{ config: Config; path: string | null; note: string | null }> {
  try {
    const root = await findRepoRoot(ctx.cwd);
    const store = openStore(root);
    if (!(await store.exists())) return { config: DEFAULT_CONFIG, path: null, note: `no ${BRAND.folder}/ here; using defaults` };
    return { config: await store.readConfig(), path: join(store.dir, 'config.json'), note: null };
  } catch (error) {
    const why = error instanceof JuratorError ? `${error.code}: ${error.message}` : 'could not read it';
    return { config: DEFAULT_CONFIG, path: null, note: `config not read (${why}); using defaults` };
  }
}

async function doctor(ctx: CommandContext): Promise<number> {
  const args = new Set(ctx.argv);
  const unknown = ctx.argv.filter((a) => a !== '--live' && a !== '--json');
  if (unknown.length) {
    ctx.err(`Unknown option ${unknown[0]}. Usage: ${command.usage}`);
    return 2;
  }
  const wantLive = args.has('--live');
  const asJson = args.has('--json');
  const { config, path, note } = await loadConfig(ctx);
  // Throws MODEL_KEY_CONFLICT / MODEL_CONFIG_INVALID with a plain message (exit 2 via main).
  const meta = readMetaEnvironment(ctx.env, {
    model: config.model.id,
    ...(config.model.reasoningEffort ? { reasoningEffort: config.model.reasoningEffort } : {}),
  });
  const report: DoctorReport = {
    keySet: hasModelKey(ctx.env),
    keyEnv: ctx.env.META_API_KEY ? 'META_API_KEY' : ctx.env.MODEL_API_KEY ? 'MODEL_API_KEY' : null,
    model: meta.model,
    modelSource: ctx.env.MODEL_ID ? 'env MODEL_ID' : path ? 'config' : 'default',
    reasoningEffort: meta.reasoningEffort,
    priceKnown: priceFor(meta.model).known,
    endpoint: meta.baseUrl === 'https://api.meta.ai/v1' ? 'default' : 'custom',
    config: path,
    configNote: note,
    scriptedDir: ctx.env.JURATOR_SCRIPTED_DIR || null,
    live: null,
  };

  if (wantLive) {
    // Always live here, even if JURATOR_SCRIPTED_DIR is set: the point is to test the key.
    const model = createModel({ config, env: { ...ctx.env, JURATOR_SCRIPTED_DIR: '' }, cwd: ctx.cwd });
    const started = performance.now();
    const { value, usage } = await model.json({
      task: 'doctor:ping',
      instructions: 'You are a health check. Reply with ok set to true and word set to "ready".',
      input: 'ping',
      schemaName: 'doctor_ping',
      schema: pingSchema,
      maxOutputTokens: 2048,
    });
    report.live = {
      ok: value.ok,
      latencyMs: Math.round(performance.now() - started),
      inputTokens: usage.inputTokens,
      outputTokens: usage.outputTokens,
      usd: usage.usd,
    };
  }

  if (asJson) {
    ctx.out(JSON.stringify(report, null, 2));
    return 0;
  }
  const s = ctx.style;
  const price = priceFor(report.model);
  const row = (label: string, value: string) => ctx.out(`  ${label.padEnd(13)} ${value}`);
  ctx.out(s.bold(`${BRAND.name} doctor`));
  row('API key', report.keySet ? s.green(`set (${report.keyEnv})`) : s.yellow('not set'));
  row('Model', `${report.model} ${s.dim(`(from ${report.modelSource}, reasoning ${report.reasoningEffort})`)}`);
  row(
    'Price',
    `$${price.input}/M input, $${price.output}/M output, $${price.cachedInput}/M cached` +
      (price.known ? '' : s.yellow(' (unknown model: priced like muse-wonder-1.0)')),
  );
  row('Endpoint', report.endpoint === 'default' ? 'Meta (default)' : s.yellow('custom (MODEL_BASE_URL)'));
  row('Config', report.config ?? s.dim(report.configNote ?? 'defaults'));
  if (report.scriptedDir) row('Scripted', `JURATOR_SCRIPTED_DIR is set: AI steps use answers from ${report.scriptedDir}`);
  if (report.live) {
    row(
      'Live call',
      `${report.live.ok ? s.green('ok') : s.yellow('answered, but not ok')} in ${report.live.latencyMs} ms · ` +
        `${report.live.inputTokens} in / ${report.live.outputTokens} out tokens · ${formatUsd(report.live.usd)}`,
    );
  }
  // R4-FIX (backlog 2): no workspace yet -> init comes before compile.
  const noWorkspace = report.config === null || report.config === undefined;
  if (!report.keySet) {
    ctx.out(`Next: set META_API_KEY to use AI steps, or pass --scripted <dir>, or use --no-ai.`);
  } else if (noWorkspace) {
    ctx.out(`Next: ${BRAND.command} init (there is no ${BRAND.folder}/ here yet)`);
  } else if (!report.live) {
    ctx.out(`Next: ${BRAND.command} doctor --live (one tiny call, about a cent).`);
  } else {
    ctx.out(`Next: ${BRAND.command} compile`);
  }
  return 0;
}

const command: Command = {
  name: 'doctor',
  summary: 'Check the Meta API key and model access',
  usage: `${BRAND.command} doctor [--live] [--json]`,
  run: (ctx) => doctor(dressed(ctx, 'doctor')),
};
export default command;
