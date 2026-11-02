import { join } from 'node:path';
import { z } from 'zod';
import { sha256 } from '../core/json.js';
import { parseInput, parseJson } from '../core/parse.js';
import { decodeUtf8, readBoundedFile } from '../io/read-file.js';
import { importMcpTools } from './import-mcp.js';
import { contextWindowSchema } from './schemas.js';

const selectionSchema = z
  .object({
    sourceId: z.string().min(1).max(160),
    tenant: z.string().min(1).max(512),
    serverId: z.string().min(1).max(512),
    revision: z.string().min(1).max(256),
    workflowRef: z.string().min(1).max(256),
    window: contextWindowSchema,
  })
  .strict();

/** Fixed local filenames avoid interpreting imported URLs or paths as capabilities. */
export async function loadMcpExport(directory: string) {
  const selection = parseInput(
    selectionSchema,
    parseJson(decodeUtf8(await readBoundedFile(join(directory, 'mcp-source.json'), 65_536))),
    'INVALID_MCP_IMPORT',
    'MCP source selection',
  );
  const bytes = await readBoundedFile(join(directory, 'tools.json'), 1_048_576);
  const evidence = {
    id: 'mcp-tools',
    source: { kind: 'local-file' as const, reference: 'tools.json' },
    mediaType: 'application/json' as const,
    content: decodeUtf8(bytes),
    sha256: sha256(bytes),
    byteLength: bytes.byteLength,
    capturedAt: new Date().toISOString(),
    coverage: 'partial' as const,
    redacted: false,
  };
  const imported = importMcpTools({
    sourceId: selection.sourceId,
    tenant: selection.tenant,
    serverId: selection.serverId,
    revision: selection.revision,
    evidence,
    scope: { workflowRef: selection.workflowRef, window: selection.window },
  });
  return { format: 'investigator-mcp-import-v1' as const, ...imported, evidence: [evidence] };
}
