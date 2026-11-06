import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';
import { lstat, mkdir, readFile, realpath, unlink, writeFile } from 'node:fs/promises';
import { dirname, isAbsolute, join, relative, resolve } from 'node:path';
import { performance } from 'node:perf_hooks';
import { createInterface } from 'node:readline';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { StringDecoder } from 'node:string_decoder';

const ROOT = fileURLToPath(new URL('../', import.meta.url));
const MAX_COMMAND_OUTPUT = 4 * 1024 * 1024;
const USAGE = 'Use --out new-directory [--live] [--auto].';

function failure(code, message) {
  return Object.assign(new Error(message), { code });
}

export function parseRecordingOptions(args) {
  const options = { live: false, auto: false, help: false };
  const seen = new Set();
  for (let index = 0; index < args.length; index += 1) {
    const name = args[index];
    if (seen.has(name)) throw failure('RECORDING_ARGUMENTS', USAGE);
    seen.add(name);
    if (name === '--live') options.live = true;
    else if (name === '--auto') options.auto = true;
    else if (name === '--help') options.help = true;
    else if (name === '--out') {
      const value = args[++index];
      if (
        !value ||
        value.startsWith('-') ||
        value.length > 4096 ||
        /[\u0000-\u001f\u007f]/u.test(value)
      )
        throw failure('RECORDING_ARGUMENTS', USAGE);
      options.outputDirectory = resolve(value);
    } else throw failure('RECORDING_ARGUMENTS', USAGE);
  }
  if (!options.help && !options.outputDirectory) throw failure('RECORDING_ARGUMENTS', USAGE);
  return options;
}

/** The demonstration child receives no platform, registry or Node preload configuration. */
export function recordingEnvironment(source, live = false) {
  const result = {};
  const names = ['PATH', 'SystemRoot', 'WINDIR', 'TMPDIR', 'TEMP', 'TMP', 'LANG'];
  if (live)
    names.push(
      'META_API_KEY',
      'MODEL_API_KEY',
      'MODEL_ID',
      'MODEL_BASE_URL',
      'MODEL_REASONING_EFFORT',
    );
  for (const name of names) if (typeof source[name] === 'string') result[name] = source[name];
  return result;
}

export function redactRecordingText(value, secrets = []) {
  let result = String(value);
  const values = Array.isArray(secrets) ? secrets : Object.values(secrets);
  for (const secret of [...new Set(values.filter((item) => typeof item === 'string' && item))].sort(
    (a, b) => b.length - a.length,
  ))
    result = result.split(secret).join('[REDACTED]');
  // Child output is presented as text, without terminal control sequences or hidden links.
  return result
    .replace(/\x1b\][^\x07]*(?:\x07|\x1b\\)/gu, '')
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/gu, '')
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, '');
}

export function recordingCredentialValues(source) {
  return Object.entries(source)
    .filter(
      ([name, value]) =>
        /(?:^|_)(?:API_KEY|SECRET_KEY|ACCESS_KEY|SECRET_ACCESS_KEY|SESSION_TOKEN|AUTH_TOKEN|TOKEN|SECRET|PASSWORD|CREDENTIALS?)$/iu.test(
          name,
        ) &&
        typeof value === 'string' &&
        value,
    )
    .map(([, value]) => value);
}

function argument(value) {
  return /^[A-Za-z0-9_./:@-]+$/u.test(value) ? value : `'${value.replaceAll("'", "'\\''")}'`;
}

function targetPath(value) {
  const local = relative(ROOT, value);
  return local && !local.startsWith('..') && !isAbsolute(local) ? local : value;
}

function requireResult(condition) {
  if (!condition)
    throw failure(
      'RECORDING_RESULT_INVALID',
      'The saved evidence did not meet this demonstration stage’s requirements.',
    );
}

function verifyOutput(text) {
  const result = JSON.parse(text);
  requireResult(
    result.integrity === 'consistent-with-supplied-records' &&
      result.authenticity === 'not-established' &&
      result.execution === 'not-reexecuted',
  );
}

function waitForEnter(reader, signal) {
  if (signal.aborted)
    return Promise.reject(failure('RECORDING_CANCELLED', 'The recording was cancelled.'));
  return new Promise((done, reject) => {
    const clear = () => {
      reader.off('line', line);
      reader.off('close', close);
      signal.removeEventListener('abort', abort);
    };
    const line = () => {
      clear();
      done();
    };
    const close = () => {
      clear();
      reject(
        failure(
          'RECORDING_INPUT_CLOSED',
          'The guided recording input closed before the next command.',
        ),
      );
    };
    const abort = () => {
      clear();
      reject(failure('RECORDING_CANCELLED', 'The recording was cancelled.'));
    };
    reader.once('line', line);
    reader.once('close', close);
    signal.addEventListener('abort', abort, { once: true });
  });
}

async function execute(args, env, signal, timeoutMs) {
  if (signal.aborted) return { exitCode: null, output: '', reason: 'CANCELLED' };
  return new Promise((done) => {
    const child = spawn(process.execPath, [join(ROOT, 'dist/bin.js'), ...args], {
      cwd: ROOT,
      env,
      stdio: ['ignore', 'pipe', 'pipe'],
    });
    const decoders = [new StringDecoder('utf8'), new StringDecoder('utf8')];
    const output = [];
    let bytes = 0,
      reason = null,
      killTimer,
      exceededOutput = false;
    const stop = (value) => {
      reason ??= value;
      child.kill('SIGINT');
      if (!killTimer) killTimer = setTimeout(() => child.kill('SIGKILL'), 5000);
    };
    const abort = () => stop('CANCELLED');
    const timer = setTimeout(() => stop('TIMEOUT'), timeoutMs);
    for (const [index, stream] of [child.stdout, child.stderr].entries())
      stream.on('data', (chunk) => {
        bytes += chunk.length;
        if (bytes > MAX_COMMAND_OUTPUT) {
          exceededOutput = true;
          output.length = 0;
          stop('OUTPUT_LIMIT');
          return;
        }
        if (!exceededOutput) output.push(decoders[index].write(chunk));
      });
    signal.addEventListener('abort', abort, { once: true });
    if (signal.aborted) abort();
    child.once('error', () => {
      reason ??= 'SPAWN_FAILED';
    });
    child.once('close', (code) => {
      clearTimeout(timer);
      if (killTimer) clearTimeout(killTimer);
      signal.removeEventListener('abort', abort);
      if (!exceededOutput) for (const decoder of decoders) output.push(decoder.end());
      done({
        exitCode: code,
        reason: reason ?? (code === 0 ? null : 'COMMAND_FAILED'),
        output: exceededOutput
          ? 'Command output exceeded 4 MiB; raw output was discarded.\n'
          : output.join(''),
      });
    });
  });
}

/** Executes the real CLI and records only the redacted output displayed by this runner. */
export async function runDemoRecording(options, sourceEnvironment = process.env, io = {}) {
  if (!options.outputDirectory || typeof options.outputDirectory !== 'string')
    throw failure('RECORDING_ARGUMENTS', USAGE);
  const outputDirectory = resolve(options.outputDirectory);
  for (const path of ['dist/bin.js', 'dist/index.js']) {
    const stat = await lstat(join(ROOT, path)).catch(() => null);
    if (!stat?.isFile() || stat.isSymbolicLink())
      throw failure('BUILD_REQUIRED', 'Run npm run build before recording the demonstration.');
  }
  const { diagnoseMeta, verifyCancellationCase, verifyCancellationTrials } =
    await import('../dist/index.js');
  const live = options.live === true;
  const env = recordingEnvironment(sourceEnvironment, live);
  const diagnostic = live ? await diagnoseMeta(env) : null;
  if (live && !diagnostic.keyConfigured)
    throw failure(
      'MODEL_KEY_REQUIRED',
      'Configure META_API_KEY or MODEL_API_KEY locally before selecting --live.',
    );
  if (!options.auto && !(io.input ?? process.stdin).isTTY)
    throw failure(
      'RECORDING_INPUT_REQUIRED',
      'Use --auto in a noninteractive terminal, or run the guided recording in a terminal.',
    );
  const secrets = recordingCredentialValues(sourceEnvironment);
  const redact = (value) => redactRecordingText(value, secrets);
  const stdout = io.stdout ?? ((value) => process.stdout.write(value));
  await mkdir(dirname(outputDirectory), { recursive: true });
  await mkdir(outputDirectory, { mode: 0o700 }).catch(() => {
    throw failure(
      'RECORDING_OUTPUT_UNAVAILABLE',
      'Choose an available new recording directory; existing paths are never reused.',
    );
  });
  const began = performance.now(),
    startedAt = new Date().toISOString();
  const frames = [],
    transcript = [];
  const write = (value) => {
    const text = redact(value).replace(/\r\n/gu, '\n');
    if (!text) return;
    stdout(text);
    transcript.push(text);
    frames.push([
      Number(((performance.now() - began) / 1000).toFixed(6)),
      'o',
      text.replace(/\n/gu, '\r\n'),
    ]);
  };
  const control = new AbortController();
  const abort = () => control.abort();
  process.once('SIGINT', abort);
  process.once('SIGTERM', abort);
  io.signal?.addEventListener('abort', abort, { once: true });
  if (io.signal?.aborted) abort();
  const reader = options.auto
    ? null
    : createInterface({ input: io.input ?? process.stdin, terminal: false });
  const stages = [];
  const caseFile = join(outputDirectory, 'case/case.json'),
    trialsFile = join(outputDirectory, 'trials/trials.json');
  const mode = live ? 'live-meta-authored-demo' : 'scripted-engineering-rehearsal';
  const expectedMode = live ? 'live' : 'scripted';
  const selectedModel = diagnostic?.selectedModel ?? null;
  const configs = [
    {
      name: 'investigation-and-repair',
      title: 'Investigate the revoked work and test the supported repair.',
      cue: 'Show the acknowledgement, worker status and independent receipt, then inspect preserved legitimate work.',
      args: [
        'cancellation-demo',
        ...(live ? ['--live'] : []),
        '--out',
        targetPath(join(outputDirectory, 'case')),
      ],
      timeout: live ? 420_000 : 120_000,
      inspect: async () => {
        const report = verifyCancellationCase(JSON.parse(await readFile(caseFile, 'utf8')));
        requireResult(
          report.before.status === 'completed' &&
            report.before.validation.accepted &&
            report.before.finding?.verdict === 'contradicted' &&
            report.after?.status === 'completed' &&
            report.after.validation.accepted &&
            report.after.finding?.verdict === 'supported' &&
            report.repair.status === 'applied' &&
            report.baseline.length === 4 &&
            report.retest.length === 4 &&
            report.before.provider.mode === expectedMode &&
            report.after.provider.mode === expectedMode &&
            (!live ||
              (report.before.provider.model === selectedModel &&
                report.after.provider.model === selectedModel)) &&
            [
              'closedGap',
              'unchangedWorkload',
              'independentWorkBefore',
              'independentWorkAfter',
              'preCutWorkPreserved',
              'contentCanaryAbsent',
            ].every((field) => report.verification[field] === true),
        );
      },
    },
    {
      name: 'case-verification',
      title: 'Verify the saved case records.',
      cue: 'Explain that consistency verification does not authenticate the issuer or rerun observations.',
      args: ['verify-cancellation', targetPath(caseFile), '--json'],
      timeout: 30_000,
      inspect: async (text) => {
        verifyOutput(text);
        verifyCancellationCase(JSON.parse(await readFile(caseFile, 'utf8')));
      },
    },
    {
      name: 'authored-trials',
      title: 'Challenge safe, unsafe, missing-capture and blocked-work arrangements.',
      cue: 'Missing capture must stay unresolved. Blocking legitimate work must fail the control.',
      args: [
        'cancellation-trials',
        '--cases',
        '4',
        ...(live ? ['--live'] : []),
        '--out',
        targetPath(join(outputDirectory, 'trials')),
      ],
      timeout: live ? 780_000 : 120_000,
      inspect: async () => {
        const report = verifyCancellationTrials(JSON.parse(await readFile(trialsFile, 'utf8')));
        const expected = ['contradicted', 'supported', 'insufficient_evidence', 'contradicted'];
        requireResult(
          report.mode ===
            (live ? 'live-authored-concealed-variant-trials' : 'scripted-engineering-regression') &&
            report.requestedCases === 4 &&
            !report.cancelled &&
            report.totals.executed === 4 &&
            report.totals.correct === 4 &&
            report.totals.unsupportedConclusions === 0 &&
            report.cases.length === 4 &&
            report.cases.every(
              (trial, index) =>
                trial.groundedConclusionCorrect &&
                !trial.unsupportedConclusion &&
                trial.report.before.status === 'completed' &&
                trial.report.before.validation.accepted &&
                trial.report.before.finding?.verdict === expected[index] &&
                trial.report.before.provider.mode === expectedMode &&
                (!live || trial.report.before.provider.model === selectedModel),
            ),
        );
      },
    },
    {
      name: 'trial-verification',
      title: 'Verify the supplied authored-trial records.',
      cue: 'Close with the reproducible case and public source; authored scores do not establish customer accuracy.',
      args: ['verify-cancellation', targetPath(trialsFile), '--json'],
      timeout: 30_000,
      inspect: async (text) => {
        verifyOutput(text);
        verifyCancellationTrials(JSON.parse(await readFile(trialsFile, 'utf8')));
      },
    },
  ];
  let status = 'PASS',
    error = null;
  try {
    write(
      `Praesidia Investigator command recording\nMode: ${mode}\n${live ? `Selected model: ${selectedModel}\nExplicit billed provider calls: two investigations for the repair pair and four authored trial investigations.\n` : 'Scripted orchestration with real synthetic HTTP effects. No model service calls.\n'}Child output is buffered until each command completes, then redacted.\nThe recording keeps actual elapsed time and captures no keyboard input, browser, video or microphone.\n`,
    );
    for (const config of configs) {
      if (control.signal.aborted)
        throw failure('RECORDING_CANCELLED', 'The recording was cancelled.');
      write(`\n${config.title}\nPresenter cue: ${config.cue}\n`);
      if (reader) {
        write('Press Enter to execute the next real command.\n');
        await waitForEnter(reader, control.signal);
      }
      const command = `node dist/bin.js ${config.args.map(argument).join(' ')}`;
      write(`\n$ ${command}\n`);
      const stageStart = performance.now(),
        stageStartedAt = new Date().toISOString();
      const result = await execute(config.args, env, control.signal, config.timeout);
      write(result.output);
      let valid = result.exitCode === 0 && !result.reason;
      if (valid)
        try {
          await config.inspect(result.output);
        } catch {
          valid = false;
        }
      const stageStatus = valid ? 'PASS' : control.signal.aborted ? 'CANCELLED' : 'FAIL';
      stages.push({
        name: config.name,
        command: redact(command),
        startedAt: stageStartedAt,
        finishedAt: new Date().toISOString(),
        durationSeconds: Number(((performance.now() - stageStart) / 1000).toFixed(3)),
        exitCode: result.exitCode,
        status: stageStatus,
        reason: valid ? null : (result.reason ?? 'RESULT_REQUIREMENTS_NOT_MET'),
      });
      write(`Recorded stage: ${stageStatus}\n`);
      if (!valid) {
        status = stageStatus;
        error = stages.at(-1).reason;
        break;
      }
      if (config.name === 'investigation-and-repair') {
        write(
          `Inspect: ${targetPath(join(outputDirectory, 'case/report.html'))}#observations\nInspect: ${targetPath(join(outputDirectory, 'case/report.html'))}#investigation\nInspect: ${targetPath(join(outputDirectory, 'case/report.html'))}#repair\n`,
        );
      }
      if (config.name === 'authored-trials')
        write(
          `Inspect uncertainty: ${targetPath(join(outputDirectory, 'trials/trial-03.html'))}\nInspect blocked legitimate work: ${targetPath(join(outputDirectory, 'trials/trial-04.html'))}\n`,
        );
    }
  } catch (caught) {
    status = control.signal.aborted ? 'CANCELLED' : 'FAIL';
    error =
      caught?.code === 'RECORDING_INPUT_CLOSED'
        ? 'RECORDING_INPUT_CLOSED'
        : control.signal.aborted
          ? 'RECORDING_CANCELLED'
          : 'RECORDING_FAILED';
  } finally {
    reader?.close();
  }
  try {
    const paths = [
      'case/case.json',
      'case/before.json',
      'case/after.json',
      'case/report.html',
      'case/repair.diff',
      'trials/trials.json',
      ...[1, 2, 3, 4].flatMap((n) => [`trials/trial-0${n}.json`, `trials/trial-0${n}.html`]),
    ];
    const artifacts = [],
      withheldArtifacts = [];
    for (const path of paths) {
      const bytes = await readFile(join(outputDirectory, path)).catch(() => null);
      if (!bytes) {
        if (status === 'PASS') {
          status = 'FAIL';
          error = 'RECORDING_ARTIFACT_MISSING';
        }
        continue;
      }
      if (secrets.some((secret) => bytes.includes(Buffer.from(secret)))) {
        status = 'FAIL';
        error = 'RECORDING_CREDENTIAL_DETECTED';
        await unlink(join(outputDirectory, path));
        withheldArtifacts.push(path);
        continue;
      }
      artifacts.push({
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    if (control.signal.aborted) {
      status = 'CANCELLED';
      error ??= 'RECORDING_CANCELLED';
    }
    write(
      `\nRecorded commands and artifact inspection: ${status}. ${status === 'PASS' ? 'Four commands and the saved-evidence checks completed; the recording manifest is being saved.' : 'Available nonsensitive evidence is retained; no successful demonstration is inferred.'}\n`,
    );
    const header = {
      version: 2,
      width: Math.max(40, Math.min(240, process.stdout.columns || 110)),
      height: Math.max(20, Math.min(80, process.stdout.rows || 32)),
      timestamp: Math.floor(Date.parse(startedAt) / 1000),
      title: `Praesidia Investigator (${mode})`,
      env: { TERM: 'xterm-256color' },
    };
    const recordingFiles = {
      'terminal.cast': [
        JSON.stringify(header),
        ...frames.map((frame) => JSON.stringify(frame)),
        '',
      ].join('\n'),
      'transcript.txt': transcript.join(''),
    };
    for (const [path, text] of Object.entries(recordingFiles)) {
      const bytes = Buffer.from(text);
      await writeFile(join(outputDirectory, path), bytes, { flag: 'wx', mode: 0o600 });
      artifacts.push({
        path,
        bytes: bytes.length,
        sha256: createHash('sha256').update(bytes).digest('hex'),
      });
    }
    if (control.signal.aborted) {
      status = 'CANCELLED';
      error ??= 'RECORDING_CANCELLED';
    }
    const manifest = {
      format: 'investigator-demo-recording-v1',
      mode,
      status,
      error,
      capture: 'terminal-output-only',
      startedAt,
      finishedAt: new Date().toISOString(),
      durationSeconds: Number(((performance.now() - began) / 1000).toFixed(3)),
      selectedModel: selectedModel ? redact(selectedModel) : null,
      providerEndpoint: diagnostic
        ? diagnostic.customEndpoint
          ? 'operator-custom'
          : 'official-meta-api'
        : null,
      stages,
      artifacts,
      withheldArtifacts,
      limitations: [
        'This is an actual-command terminal recording, not a browser video or microphone recording.',
        'Output is bounded, buffered and credential-redacted before display; elapsed time is not shortened and keyboard input is not captured.',
        'The workflow uses owned synthetic HTTP targets and exact supported recipes; no customer deployment or universal revocation guarantee is established.',
        'Saved-record verification establishes supplied consistency, not authenticated authorship or fresh business execution.',
        'Authored trial scores are not an independent customer benchmark or general model-accuracy estimate.',
        ...(live
          ? ['Explicit live calls never fall back to a scripted provider or another model.']
          : [
              'Scripted orchestration validates engineering contracts; it does not establish successful live Meta reasoning.',
            ]),
      ],
    };
    await writeFile(
      join(outputDirectory, 'recording.json'),
      `${JSON.stringify(manifest, null, 2)}\n`,
      { flag: 'wx', mode: 0o600 },
    );
    if (withheldArtifacts.length)
      (io.stderr ?? ((value) => process.stderr.write(value)))(
        'A configured credential appeared in an application artifact. Affected files were withheld; this recording failed.\n',
      );
    return manifest;
  } finally {
    process.removeListener('SIGINT', abort);
    process.removeListener('SIGTERM', abort);
    io.signal?.removeEventListener('abort', abort);
  }
}

/** Node canonicalizes module symlinks, including macOS /var, before setting import.meta.url. */
export async function isRecordingEntrypoint(entry = process.argv[1]) {
  if (!entry) return false;
  const canonical = await realpath(resolve(entry)).catch(() => null);
  return canonical !== null && pathToFileURL(canonical).href === import.meta.url;
}

if (await isRecordingEntrypoint()) {
  (async () => {
    const options = parseRecordingOptions(process.argv.slice(2));
    if (options.help) {
      process.stdout.write(
        `${USAGE}\nDefault: guided scripted rehearsal. --auto skips Enter prompts. --live explicitly invokes the configured provider.\nCreates terminal.cast, transcript.txt, recording.json and verified case/trial artifacts. It does not record browser video or microphone audio.\n`,
      );
      return;
    }
    const report = await runDemoRecording(options);
    process.exitCode = report.status === 'PASS' ? 0 : report.status === 'CANCELLED' ? 130 : 2;
  })().catch((error) => {
    const code =
      typeof error?.code === 'string' && /^(?:RECORDING_|MODEL_|BUILD_)[A-Z_]+$/u.test(error.code)
        ? error.code
        : 'RECORDING_FAILED';
    const safe = redactRecordingText(
      `${code}: ${code === 'RECORDING_FAILED' ? 'Recording could not start or save its results.' : error.message}\n`,
      recordingCredentialValues(process.env),
    );
    process.stderr.write(safe);
    process.exitCode = 2;
  });
}
