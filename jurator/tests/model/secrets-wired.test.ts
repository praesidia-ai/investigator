// FU-I: the rule, bind and red-team prompts send code through the same secret masking as the AI read.
import { describe, expect, it } from 'vitest';
import { buildBindPrompt } from '../../src/bindings/index.js';
import { filesForModel, MASK } from '../../src/model/index.js';
import { buildRulePrompt } from '../../src/rules/index.js';
import { redteamInput } from '../../src/rules/redteam.js';
import { promise, rule } from '../rules/helpers.js';

const files = [
  { path: 'src/agent/chats.ts', text: "export const CHAT_TTL_DAYS = 30;\nconst apiKey = 'abcd1234efgh5678';\nexport {};" },
  { path: '.env', text: 'META_API_KEY=live-key-value' },
  { path: 'certs/server.pem', text: '-----BEGIN PRIVATE KEY-----\nAAAA\n-----END PRIVATE KEY-----' },
];
const p = promise('privacy.01', 'Support chats are deleted after 30 days.', ['src/agent/**']);

describe('filesForModel', () => {
  it('leaves out secret files and masks secrets with line numbers kept', () => {
    const out = filesForModel(files);
    expect(out.map((f) => f.path)).toEqual(['src/agent/chats.ts']);
    expect(out[0]?.text.split('\n')).toHaveLength(3);
    expect(out[0]?.text).toContain(`apiKey = '${MASK}'`);
    expect(out[0]?.text).toContain('CHAT_TTL_DAYS = 30;');
  });
});

describe('prompts that carry code', () => {
  const built = {
    rule: buildRulePrompt(p, files, 'c'.repeat(40)),
    bind: buildBindPrompt(p, files, 'c'.repeat(40)),
    redteam: redteamInput(rule({ mode: 'must-match', pattern: 'CHAT_TTL_DAYS\\s*=\\s*30', globs: ['src/agent/**'] }), p, files),
  };
  for (const [name, text] of Object.entries(built)) {
    it(`${name} prompt masks secrets and never sends .env or .pem files`, () => {
      expect(text).not.toContain('abcd1234efgh5678');
      expect(text).not.toContain('live-key-value');
      expect(text).not.toContain('=== .env');
      expect(text).not.toContain('server.pem');
      expect(text).toContain('CHAT_TTL_DAYS = 30;');
    });
  }
  it('keeps line 2 as line 2 in the numbered rule prompt', () => {
    expect(built.rule).toContain(`2| const apiKey = '${MASK}';`);
  });
});
