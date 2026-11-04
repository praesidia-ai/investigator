// Owner: WP-M (FU-2). Masks secrets in code before it is sent to a model (principle 1: credentials never reach a model).
// Masking keeps every line where it was (no line is added or removed), so line numbers the model cites still point at
// the same lines in git, and the program copies quotes from the real git text, never from the masked text.

/** Files never sent to a model at all: env files, keys and certificates. */
const SECRET_FILE = /(?:^|\/)(?:\.env[\w.\-]*|id_(?:rsa|dsa|ecdsa|ed25519)|[^/]+\.(?:pem|key|p12|pfx|jks|keystore))$/iu;

/** True for `.env*`, `*.pem`, `*.key` (and private-key files like `id_rsa`, `*.p12`): skip these, do not mask them. */
export function isSecretFile(path: string): boolean {
  return SECRET_FILE.test(path);
}

export const MASK = '[masked]';

/** Values with a known secret shape, anywhere in the text (also inside comments). */
const TOKEN_SHAPES: readonly RegExp[] = [
  /\b(?:AKIA|ASIA)[0-9A-Z]{16}\b/gu, // AWS access key id
  /\bgh[pousr]_[A-Za-z0-9]{30,}\b/gu, // GitHub token
  /\bgithub_pat_[A-Za-z0-9_]{22,}\b/gu,
  /\bxox[abprs]-[A-Za-z0-9-]{10,}/gu, // Slack
  /\b[sr]k_(?:live|test)_[A-Za-z0-9]{16,}\b/gu, // Stripe
  /\bsk-[A-Za-z0-9_-]{20,}/gu, // OpenAI / Anthropic style
  /\bAIza[0-9A-Za-z_-]{35}\b/gu, // Google API key
  /\beyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}/gu, // JWT
];
const BEARER = /\b(Bearer|Basic)([ \t]+)([A-Za-z0-9._~+/=-]{16,})/gu;
const URL_PASSWORD = /\b([a-z][a-z0-9+.-]*:\/\/[^\s:/@'"`]+:)([^\s@/'"`]+)(@)/giu;
const PRIVATE_KEY = /(-----BEGIN [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)([\s\S]*?)(-----END [A-Z0-9 ]*PRIVATE KEY(?: BLOCK)?-----)/gu;

/** A name whose value is a secret: it ends with one of these words (`adminPassword`, `SESSION_SECRET`, `api_key`). */
const SECRET_NAME_END =
  /(?:password|passwd|passphrase|pwd|secret|token|apikey|accesskey|secretkey|privatekey|signingkey|encryptionkey|masterkey|authkey|credential|credentials|authorization|dsn|connectionstring)$/u;
/** `STRIPE_KEY`, `sendgridKey`: a generic `key` name, masked only when the value looks random. */
const KEY_NAME_END = /key$/u;

const normName = (name: string): string => name.toLowerCase().replace(/[^a-z0-9]/gu, '');

/** Values that are clearly not secrets: references, templates, numbers, booleans, prose. */
function notASecret(value: string): boolean {
  if (value === '' || /\s/u.test(value)) return true;
  if (value === MASK) return true;
  if (/^-?\d[\d_.]*$/u.test(value)) return true; // TOKEN_TTL_SECONDS = "3600"
  if (/^(?:true|false|null|none|nil|undefined|yes|no|on|off)$/iu.test(value)) return true;
  if (/\$\{|\{\{|#\{|^\$|^%|^process\.env|^os\.environ|^env\(/u.test(value)) return true;
  return false;
}
const looksRandom = (value: string): boolean => value.length >= 16 && /[A-Za-z]/u.test(value) && /\d/u.test(value);

function shouldMask(name: string, value: string): boolean {
  const n = normName(name);
  if (notASecret(value)) return false;
  if (SECRET_NAME_END.test(n)) return true;
  return KEY_NAME_END.test(n) && looksRandom(value);
}

// name (optionally quoted) · an assignment or key operator · a one-line string literal
const QUOTED_ASSIGN =
  /(["']?)([A-Za-z_$][\w$.-]*)\1([ \t]*(?::=|===?|!==?|=>|=|:)[ \t]*)(['"`])((?:\\.|(?!\4)[^\\\n])*)\4/gu;
// config files only: NAME=value / name: value with no quotes (in code an unquoted right-hand side is an expression)
const BARE_ASSIGN = /^([ \t]*(?:export[ \t]+)?)([A-Za-z_][\w.-]*)([ \t]*[:=][ \t]*)([^\s'"`#][^\s#]*)/gmu;
const CONFIG_FILE = /\.(?:ya?ml|toml|ini|cfg|conf|properties|sh|bash|zsh)$|(?:^|\/)(?:Dockerfile|Procfile)$/iu;

export interface MaskResult {
  /** The text with secrets replaced by `[masked]`; same number of lines as the input. */
  readonly text: string;
  /** How many values were masked. */
  readonly masked: number;
}

/**
 * Replaces secret values (API keys, tokens, private keys, passwords in assignments, passwords in URLs) with `[masked]`.
 * Never adds or removes a line. `path` decides whether bare `NAME=value` lines count (config files only).
 */
export function maskSecrets(text: string, path = ''): MaskResult {
  let masked = 0;
  let out = text.replace(PRIVATE_KEY, (_m, begin: string, body: string, end: string) => {
    masked += 1;
    // Keep each line break of the body (and any \r); blank the rest.
    return `${begin}${body.replace(/[^\r\n]+/gu, (seg) => (seg.trim() === '' ? seg : MASK))}${end}`;
  });
  for (const shape of TOKEN_SHAPES) {
    out = out.replace(shape, () => {
      masked += 1;
      return MASK;
    });
  }
  out = out.replace(BEARER, (m, kind: string, gap: string, value: string) => {
    if (value === MASK) return m;
    masked += 1;
    return `${kind}${gap}${MASK}`;
  });
  out = out.replace(URL_PASSWORD, (m, head: string, pass: string, at: string) => {
    if (notASecret(pass)) return m;
    masked += 1;
    return `${head}${MASK}${at}`;
  });
  out = out.replace(QUOTED_ASSIGN, (m, q: string, name: string, op: string, quote: string, value: string) => {
    if (!shouldMask(name, value)) return m;
    masked += 1;
    return `${q}${name}${q}${op}${quote}${MASK}${quote}`;
  });
  if (CONFIG_FILE.test(path)) {
    out = out.replace(BARE_ASSIGN, (m, lead: string, name: string, op: string, value: string) => {
      if (!shouldMask(name, value)) return m;
      masked += 1;
      return `${lead}${name}${op}${MASK}`;
    });
  }
  return { text: out, masked };
}

/** What may be sent for one file: null for a secret file (skip it), else the masked text. */
export function maskFileForModel(path: string, text: string): MaskResult | null {
  return isSecretFile(path) ? null : maskSecrets(text, path);
}

/** FU-I: the files as a model may see them: secret files left out, secrets masked in the rest (same line numbers). */
export function filesForModel<F extends { readonly path: string; readonly text: string }>(files: readonly F[]): F[] {
  const out: F[] = [];
  for (const file of files) {
    const masked = maskFileForModel(file.path, file.text);
    if (masked) out.push(masked.masked > 0 ? { ...file, text: masked.text } : file);
  }
  return out;
}
