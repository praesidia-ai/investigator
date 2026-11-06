// The MCP server as a real child process over stdio, with fakes behind it (tests/mcp/fake-server.ts).
import { afterAll, beforeAll, describe, expect, it } from 'vitest';
import { LATEST_PROTOCOL_VERSION } from '../../src/mcp/index.js';
import { FAKE_SERVER, McpTestClient, textOf } from './client.js';

describe('jurator mcp over stdio (fakes)', () => {
  let client: McpTestClient;
  beforeAll(() => {
    client = McpTestClient.start(FAKE_SERVER);
  });
  afterAll(async () => {
    await client.close();
  });

  it('answers initialize with tools capability, server info and instructions', async () => {
    const r = await client.initialize();
    expect(r.error).toBeUndefined();
    expect(r.result).toMatchObject({
      protocolVersion: '2025-06-18',
      capabilities: { tools: { listChanged: false } },
      serverInfo: { name: 'jurator', version: expect.any(String) },
    });
    expect(String(r.result?.instructions)).toContain('promises_for_change');
  });

  it('answers ping', async () => {
    const r = await client.request('ping');
    expect(r.result).toEqual({});
  });

  it('lists exactly the four read/check tools, all read-only', async () => {
    const r = await client.request('tools/list');
    const tools = r.result?.tools as Array<{ name: string; inputSchema: { type: string }; annotations: { readOnlyHint: boolean } }>;
    expect(tools.map((t) => t.name).sort()).toEqual(['check_change', 'explain_promise', 'list_promises', 'promises_for_change']);
    for (const t of tools) {
      expect(t.inputSchema.type).toBe('object');
      expect(t.annotations.readOnlyHint).toBe(true);
    }
    // No write tool: nothing can accept, waive or edit a promise.
    expect(tools.some((t) => /accept|waive|edit|write|rule_propose|delete/u.test(t.name))).toBe(false);
  });

  it('list_promises returns accepted promises only, with has-rule', async () => {
    const r = await client.callTool('list_promises');
    expect(r.isError).toBe(false);
    const items = r.structuredContent?.promises as Array<{ id: string; hasRule: boolean; scope: string[] }>;
    expect(items.map((p) => p.id)).toEqual(['praesidia.01', 'privacy.01', 'privacy.02', 'security.01', 'security.02']);
    expect(items.find((p) => p.id === 'security.01')?.hasRule).toBe(true);
    expect(items.find((p) => p.id === 'privacy.02')?.hasRule).toBe(false);
    expect(r.structuredContent).toMatchObject({ coveredByRules: 2, codePromises: 3 });
    expect(textOf(r)).toContain('5 accepted promises (2 of 3 code promises checked by a rule, no AI)');
    expect(textOf(r)).not.toContain('privacy.03');
  });

  it('promises_for_change returns the promises about the files, with quote and rule', async () => {
    const r = await client.callTool('promises_for_change', { files: ['./src/routes/export.ts'] });
    expect(r.isError).toBe(false);
    const items = r.structuredContent?.promises as Array<{ id: string; checkedBy: string; policy: { quote: string; where: string }; rules: Array<{ id: string }> }>;
    expect(items.map((p) => p.id)).toEqual(['praesidia.01', 'privacy.02', 'security.01', 'security.02']);
    const sec = items.find((p) => p.id === 'security.01');
    expect(sec).toMatchObject({
      checkedBy: 'rule',
      policy: { quote: 'Only workspace admins can export customer data.', where: 'docs/security.md:3' },
      rules: [{ id: 'R-security.01-1' }],
    });
    expect(items.find((p) => p.id === 'security.02')?.checkedBy).toBe('checklist');
    const text = textOf(r);
    expect(text).toContain('"Only workspace admins can export customer data."  docs/security.md:3');
    expect(text).toContain('never edit .jurator/');
    // runtime promises are listed but labeled: enforced while running, not code-checked; drafts stay hidden
    expect(items.find((p) => p.id === 'praesidia.01')?.checkedBy).toBe('runtime');
    expect(text).toContain('runtime promise: enforced while running, not code-checked');
    expect(text).not.toContain('privacy.03');
  });

  it('promises_for_change maps an absolute path inside the repo and says when nothing applies', async () => {
    const abs = await client.callTool('promises_for_change', { files: ['/work/acme-notes/src/agent/chats.ts'] });
    expect((abs.structuredContent?.promises as Array<{ id: string }>).map((p) => p.id)).toEqual(['praesidia.01', 'privacy.01', 'privacy.02']);
    const none = await client.callTool('promises_for_change', { files: ['README.md'] });
    expect(none.isError).toBe(false);
    expect(textOf(none)).toContain('No accepted promise is about README.md');
  });

  it('promises_for_change rejects missing files as a tool error, not a crash', async () => {
    const r = await client.callTool('promises_for_change', {});
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('Bad input');
  });

  it('explain_promise before any check says there is no saved run', async () => {
    const r = await client.callTool('explain_promise', { id: 'privacy.01' });
    expect(r.isError).toBe(false);
    const text = textOf(r);
    expect(text).toContain('privacy.01 (accepted, must, code): Support chats are deleted after 30 days.');
    expect(text).toContain('"We delete support chats after 30 days."  docs/privacy.md:5');
    expect(text).toContain('Rule R-privacy.01-1');
    expect(text).toContain('Contradiction C-1 (open) with praesidia.01');
    expect(text).toContain('no saved check run includes it yet');
    expect(r.structuredContent?.lastVerdict).toBeNull();
  });

  it('check_change runs rules only (no AI) on main...HEAD and returns verdicts with citations', async () => {
    const r = await client.callTool('check_change');
    expect(r.isError).toBe(false);
    const s = r.structuredContent as {
      passed: boolean;
      blocking: boolean;
      base: string;
      changedFiles: string[];
      runPath: string;
      results: Array<{ promiseId: string; verdict: string; level: string; citations: Array<{ path: string; startLine: number; quote: string }> }>;
      checklist: Array<{ promiseId: string }>;
    };
    expect(s).toMatchObject({ passed: false, blocking: true, base: 'main', changedFiles: ['src/routes/export.ts'] });
    const sec = s.results.find((x) => x.promiseId === 'security.01');
    expect(sec).toMatchObject({ verdict: 'broken', level: 'rule' });
    expect(sec?.citations[0]).toMatchObject({ path: 'src/routes/export.ts', startLine: 9 });
    expect(sec?.citations[0]?.quote).toContain("router.get('/export.csv'");
    expect(s.results.find((x) => x.promiseId === 'privacy.02')).toMatchObject({ verdict: 'not-checked', level: 'quick' });
    expect(s.results.some((x) => x.level === 'ai-read')).toBe(false);
    expect(s.checklist.map((c) => c.promiseId)).toEqual(['security.02']);
    expect(s.runPath).toMatch(/^\.jurator\/local\/runs\/.+\/run\.json$/u);
    const text = textOf(r);
    expect(text).toContain('BROKEN · security.01 · proved by a rule, no AI');
    expect(text).toContain('do not change the rule, the promise or .jurator/');
    expect(text).not.toContain('\u001b['); // plain text, no colour codes
  });

  it('explain_promise after a check shows the last verdict', async () => {
    const r = await client.callTool('explain_promise', { id: 'security.01' });
    expect(textOf(r)).toMatch(/Last verdict: BROKEN \(rule, no AI\) in run \S+ {2}src\/routes\/export\.ts:9/u);
    expect(r.structuredContent?.lastVerdict).toMatchObject({ verdict: 'broken', level: 'rule' });
  });

  it('explain_promise on an unknown id is a tool error', async () => {
    const r = await client.callTool('explain_promise', { id: 'privacy.99' });
    expect(r.isError).toBe(true);
    expect(textOf(r)).toContain('No promise "privacy.99"');
  });

  it('check_change refuses a base that git could read as an option, and reports a bad ref', async () => {
    const opt = await client.callTool('check_change', { base: '--output=/tmp/x' });
    expect(opt.isError).toBe(true);
    expect(textOf(opt)).toContain('Bad input');
    const unknown = await client.callTool('check_change', { base: 'no-such-branch' });
    expect(unknown.isError).toBe(true);
    expect(textOf(unknown)).toContain('unknown ref no-such-branch');
  });

  it('an unknown tool is a JSON-RPC invalid-params error', async () => {
    const r = await client.request('tools/call', { name: 'accept_promise', arguments: { id: 'security.01' } });
    expect(r.error?.code).toBe(-32602);
    expect(r.error?.message).toContain('Unknown tool: accept_promise');
  });

  it('an unknown method is method-not-found', async () => {
    const r = await client.request('resources/list');
    expect(r.error?.code).toBe(-32601);
  });

  it('a malformed JSON line is ignored safely: no reply, a stderr note, and the server keeps serving', async () => {
    const before = client.lines.length;
    client.sendRaw('{"jsonrpc":"2.0","id":999,"method":"ping"'); // cut off
    client.sendRaw('this is not json at all');
    client.sendRaw('[1, 2');
    const pong = await client.request('ping');
    expect(pong.result).toEqual({});
    expect(client.lines.length).toBe(before + 1); // only the pong
    expect(client.lines.some((l) => l.id === 999)).toBe(false);
    expect(client.stderr).toContain('ignored a line that is not valid JSON');
  });

  it('notifications get no reply; a request with a non-2.0 version is an invalid request', async () => {
    const before = client.lines.length;
    client.notify('notifications/cancelled', { requestId: 1 });
    client.sendRaw(JSON.stringify({ jsonrpc: '1.0', id: 'old', method: 'ping' }));
    const pong = await client.request('ping');
    expect(pong.result).toEqual({});
    const old = client.lines.find((l) => l.id === 'old');
    expect(old?.error?.code).toBe(-32600);
    expect(client.lines.length).toBe(before + 2);
  });
});

describe('jurator mcp without a workspace or with a failing check', () => {
  it('tools say there is no .jurator/ folder (tool error), and the server stays up', async () => {
    const client = McpTestClient.start(FAKE_SERVER, [], { env: { MCP_FAKE_SCENARIO: 'no-workspace' } });
    try {
      await client.initialize();
      const r = await client.callTool('list_promises');
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('NO_WORKSPACE');
      expect(textOf(r)).toContain('do not create it yourself');
      expect((await client.request('ping')).result).toEqual({});
    } finally {
      expect(await client.close()).toBe(0);
    }
  });

  it('a check that throws becomes isError with the reason', async () => {
    const client = McpTestClient.start(FAKE_SERVER, [], { env: { MCP_FAKE_SCENARIO: 'check-fails' } });
    try {
      const r = await client.callTool('check_change', { base: 'main' });
      expect(r.isError).toBe(true);
      expect(textOf(r)).toContain('git exploded');
    } finally {
      await client.close();
    }
  });

  it('offers its own protocol version to a client asking for an unknown old one', async () => {
    const client = McpTestClient.start(FAKE_SERVER);
    try {
      const r = await client.request('initialize', { protocolVersion: '2023-01-01', capabilities: {}, clientInfo: { name: 'x', version: '0' } });
      expect(r.result?.protocolVersion).toBe(LATEST_PROTOCOL_VERSION);
    } finally {
      await client.close();
    }
  });
});
