import test from 'node:test';
import assert from 'node:assert/strict';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { InMemoryTransport } from '@modelcontextprotocol/sdk/inMemory.js';
import { createSmokeMcpServer } from '../src/smoke-mcp-server.js';

test('MCP discovery is read-only and optional deviceId reaches every selectable operation', async () => {
  const seen: Array<[string, string | undefined]> = [];
  const status = (project: string, deviceId = 'home-mac') => ({ project, deviceId, branch: 'main', head: 'a'.repeat(40), clean: true, staged: 0, unstaged: 0, untracked: 0, upstream: 'origin/main', ahead: 0, behind: 0 });
  const server = createSmokeMcpServer(
    async deviceId => { seen.push(['smoke', deviceId]); return { bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }; },
    async (project, deviceId) => { seen.push(['status', deviceId]); return status(project, deviceId); },
    ['bridge:smoke', 'bridge:read', 'bridge:write'], undefined,
    async (project, deviceId) => { seen.push(['context', deviceId]); return { project, deviceId: deviceId!, git: status(project, deviceId), contextSources: [], currentState: null, currentPhase: null, nextAction: null, warnings: [] }; },
    async (project, query, deviceId) => { seen.push(['search', deviceId]); return { project, deviceId: deviceId!, query, matches: [], truncated: false, totalMatches: 0 }; },
    async (project, _instruction, options) => { seen.push(['analyze', options?.deviceId]); return { project, deviceId: options?.deviceId!, threadId: 'thread-home-mac', threadCreated: false, turnId: 'turn-home-mac', status: 'completed', result: 'ok', blockedActions: 0, selectedProfile: 'fast', requestedModel: 'gpt-test', requestedReasoning: 'low', runtimeModel: 'gpt-test', runtimeReasoning: 'low' }; },
    {
      prepare: async (_project, _instruction, options) => { seen.push(['prepare', options?.deviceId]); return { deviceId: options?.deviceId }; },
      approve: async () => ({ deviceId: 'home-mac' }),
      apply: async () => ({ deviceId: 'home-mac' }),
    },
    async () => ({ devices: [{ deviceId: 'home-mac', connected: true }], activeDevices: 1, relayProtocolVersion: 2 }),
  );
  const client = new Client({ name: 'routing-mcp-test', version: '1' });
  const [a, b] = InMemoryTransport.createLinkedPair();
  await server.connect(a); await client.connect(b);
  try {
    const tools = (await client.listTools()).tools;
    assert.equal(tools.find(tool => tool.name === 'bridge_devices')?.annotations?.readOnlyHint, true);
    assert.deepEqual((await client.callTool({ name: 'bridge_devices', arguments: {} })).structuredContent, {
      devices: [{ deviceId: 'home-mac', connected: true }], activeDevices: 1, relayProtocolVersion: 2,
    });
    await client.callTool({ name: 'bridge_e2e_smoke', arguments: { deviceId: 'home-mac' } });
    await client.callTool({ name: 'project_git_status', arguments: { project: 'solicitudpro', deviceId: 'home-mac' } });
    await client.callTool({ name: 'project_context_snapshot', arguments: { project: 'solicitudpro', deviceId: 'home-mac' } });
    await client.callTool({ name: 'project_search', arguments: { project: 'solicitudpro', query: 'C19', deviceId: 'home-mac' } });
    await client.callTool({ name: 'codex_project_analyze', arguments: { project: 'solicitudpro', instruction: 'Analiza el estado actual', deviceId: 'home-mac' } });
    await client.callTool({ name: 'codex_project_change_prepare', arguments: { project: 'solicitudpro', instruction: 'Planifica un cambio seguro', deviceId: 'home-mac' } });
    assert.deepEqual(seen, [['smoke', 'home-mac'], ['status', 'home-mac'], ['context', 'home-mac'], ['search', 'home-mac'], ['analyze', 'home-mac'], ['prepare', 'home-mac']]);
  } finally { await client.close(); await server.close(); }
});
