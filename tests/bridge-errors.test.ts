import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { BridgeError } from '../src/bridge-errors.js';
import { createSmokeMcpServer } from '../src/smoke-mcp-server.js';

test('MCP exposes only safe quota/device codes while keeping scope denial distinct', async () => {
  const fail = (code: ConstructorParameters<typeof BridgeError>[0]) => { throw new BridgeError(code); };
  const server = createSmokeMcpServer(
    async () => fail('BRIDGE_SMOKE_BUDGET_REACHED'),
    async () => fail('BRIDGE_READ_BUDGET_REACHED'),
    ['bridge:smoke', 'bridge:read', 'bridge:write'], undefined,
    async () => fail('BRIDGE_DEVICE_AMBIGUOUS'),
    async () => fail('BRIDGE_READ_BUDGET_REACHED'),
    async () => fail('BRIDGE_ANALYSIS_BUDGET_REACHED'),
    { prepare: async () => fail('BRIDGE_ANALYSIS_BUDGET_REACHED'), approve: async () => fail('BRIDGE_CHANGE_BUDGET_REACHED'), apply: async () => fail('BRIDGE_CHANGE_BUDGET_REACHED') },
  );
  const client = new Client({ name: 'error-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    for (const [name, args, code] of [
      ['bridge_e2e_smoke', {}, 'BRIDGE_SMOKE_BUDGET_REACHED'],
      ['project_git_status', { project: 'solicitudpro' }, 'BRIDGE_READ_BUDGET_REACHED'],
      ['project_context_snapshot', { project: 'solicitudpro' }, 'BRIDGE_DEVICE_AMBIGUOUS'],
      ['project_search', { project: 'solicitudpro', query: 'C19' }, 'BRIDGE_READ_BUDGET_REACHED'],
      ['codex_project_analyze', { project: 'solicitudpro', instruction: 'Analiza el estado' }, 'BRIDGE_ANALYSIS_BUDGET_REACHED'],
      ['codex_project_change_prepare', { project: 'solicitudpro', instruction: 'Planifica un cambio' }, 'BRIDGE_ANALYSIS_BUDGET_REACHED'],
      ['codex_project_change_approve', { approvalId: crypto.randomUUID() }, 'BRIDGE_CHANGE_BUDGET_REACHED'],
      ['codex_project_change_apply', { approvalId: crypto.randomUUID() }, 'BRIDGE_CHANGE_BUDGET_REACHED'],
    ] as const) {
      const result = await client.callTool({ name, arguments: args });
      assert.equal(result.isError, true);
      assert.equal((result.content as Array<{ text: string }>)[0]!.text, code);
    }
  } finally { await client.close(); await server.close(); }

  const readOnly = createSmokeMcpServer(async () => fail('BRIDGE_SMOKE_BUDGET_REACHED'), async () => fail('BRIDGE_READ_BUDGET_REACHED'), ['bridge:read']);
  const scoped = new Client({ name: 'scope-test', version: '1' });
  const [c, d] = InMemoryTransport.createLinkedPair();
  await readOnly.connect(c); await scoped.connect(d);
  try {
    const result = await scoped.callTool({ name: 'bridge_e2e_smoke', arguments: {} });
    assert.equal(result.isError, true);
    assert.equal((result.content as Array<{ text: string }>)[0]!.text, 'Authorization required');
  } finally { await scoped.close(); await readOnly.close(); }
});
