import test from 'node:test';
import assert from 'node:assert/strict';
import { Miniflare, convertV4MiniflareOptions } from 'miniflare';
import { Client } from '@modelcontextprotocol/sdk/client/index.js';
import { StreamableHTTPClientTransport } from '@modelcontextprotocol/sdk/client/streamableHttp.js';
import { startRelay } from '../../local/relay.js';
import { readFile } from 'node:fs/promises';
import { credentialHash, deviceKey } from '../../src/device-auth.js';
import { createHash } from 'node:crypto';
import { BRIDGE_QUOTA_LIMITS } from '../../cloud/bridge-quotas.js';

test('Workers OAuth: denied requests never reach relay; valid scope exposes only smoke', { timeout: 60_000 }, async () => {
  const token = crypto.randomUUID() + crypto.randomUUID();
  assert.equal((await readFile('tmp/gateway/gateway.js', 'utf8')).includes('/__test/token'), false, 'No test token route in production bundle');
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'tmp/oauth-test/oauth-worker.js', compatibilityDate: '2026-11-02', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], durableObjects: { RELAY: { className: 'Relay', useSQLite: true } }, bindings: { RELAY_TOKEN: token, DEVICE_ID: 'test-device', ALLOWED_GITHUB_ID: '123', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' } }));
  const url = await mf.ready;
  const client = new Client({ name: 'gateway-test', version: '1' });
  let relay: ReturnType<typeof startRelay> | undefined;
  let home: ReturnType<typeof startRelay> | undefined;
  try {
    const healthResponse = await fetch(new URL('/health', url));
    assert.equal(healthResponse.headers.get('X-Bridge-Worker-Version'), 'unbound', 'Health identifies the executing Worker version');
    const health = await healthResponse.json() as any;
    assert.equal(health.relayProtocolVersion, 2, 'Health identifies the executing Relay protocol');
    const deniedHandshake = await fetch(new URL('/relay', url));
    assert.equal(deniedHandshake.status, 401);
    assert.equal(deniedHandshake.headers.get('X-Bridge-Relay-Protocol'), '2');
    assert.equal((await fetch(new URL('/relay', url), { headers: { Authorization: 'Bearer wrong', 'X-Device-Id': 'test-device' } })).status, 401);
    assert.equal((await fetch(new URL('/relay', url), { headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'wrong-device' } })).status, 401);
    const mint = async (empty = false) => {
      const response = await fetch(new URL(`/__test/token${empty ? '?empty=1' : ''}`, url));
      assert.equal(response.status, 200, 'Official OAuth provider must issue test token');
      return (await response.json() as any).access_token as string;
    };
    const accessToken = await mint();
    const wrongScopeToken = await mint(true);
    const otherUser = await (await fetch(new URL('/__test/token?other=1', url))).json() as any;
    const headers = { Authorization: `Bearer ${accessToken}` };
    assert.equal((await fetch(new URL('/mcp', url), { method: 'POST', headers: { ...headers, Origin: 'https://untrusted.invalid' }, body: '{}' })).status, 403);
    assert.equal((await fetch(new URL('/mcp', url), { method: 'POST', headers, body: 'x'.repeat(20_000) })).status, 413);
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers } }));
    assert.deepEqual((await client.listTools()).tools.map(t => t.name).sort(), ['bridge_devices', 'bridge_e2e_smoke', 'project_git_status', 'project_context_snapshot', 'project_search', 'codex_project_analyze', 'codex_project_change_prepare', 'codex_project_change_approve', 'codex_project_change_apply'].sort());
    const scopeDenied = await client.callTool({ name: 'project_git_status', arguments: { project: 'solicitudpro' } });
    assert.equal(scopeDenied.isError, true);
    assert.match(JSON.stringify(scopeDenied._meta), /bridge:read/);
    const contextDenied = await client.callTool({ name: 'project_context_snapshot', arguments: { project: 'solicitudpro' } });
    assert.equal(contextDenied.isError, true);
    assert.match(JSON.stringify(contextDenied._meta), /bridge:read/);
    const searchDenied = await client.callTool({ name: 'project_search', arguments: { project: 'solicitudpro', query: 'C19' } });
    assert.equal(searchDenied.isError, true);
    assert.match(JSON.stringify(searchDenied._meta), /bridge:read/);
    assert.equal((await client.callTool({ name: 'codex_project_analyze', arguments: { project: 'solicitudpro', instruction: 'Analiza el estado actual' } })).isError, true);
    assert.equal((await client.callTool({ name: 'codex_start_task', arguments: {} })).isError, true);
    assert.equal((await client.callTool({ name: 'bridge_e2e_smoke', arguments: { prompt: 'unsafe' } })).isError, true);
    assert.equal((await client.callTool({ name: 'bridge_e2e_smoke', arguments: {} })).isError, true);
    let calls = 0;
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Relay connect timeout')), 10_000);
      relay = startRelay({ origin: url.origin, deviceId: 'test-device', token, smoke: async () => { calls++; return { bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }; }, onStatus: status => { if (status === 'connected') { clearTimeout(timer); resolve(); } } });
    });
    assert.equal((await (await fetch(new URL('/health', url))).json() as any).connected, true);
    const homeToken = crypto.randomUUID() + crypto.randomUUID();
    const kv = await mf.getKVNamespace('OAUTH_KV');
    await kv.put(deviceKey('home-windows'), JSON.stringify({ version: 1, hash: await credentialHash(homeToken), revoked: false }));
    assert.equal((await fetch(new URL('/relay', url), { headers: { Authorization: `Bearer ${homeToken}`, 'X-Device-Id': 'test-device' } })).status, 401);
    assert.equal((await fetch(new URL('/relay', url), { headers: { Authorization: `Bearer ${token}`, 'X-Device-Id': 'home-windows' } })).status, 401);
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Home connect timeout')), 10_000);
      home = startRelay({ origin: url.origin, deviceId: 'home-windows', token: homeToken,
        smoke: async () => { throw new Error('Ambiguous routing must not execute'); },
        onStatus: status => { if (status === 'connected') { clearTimeout(timer); resolve(); } } });
    });
    const ambiguous = await client.callTool({ name: 'bridge_e2e_smoke', arguments: {} });
    assert.equal(ambiguous.isError, true, 'Two devices must not be silently selected');
    assert.equal((ambiguous.content as Array<{ text: string }>)[0]!.text, 'BRIDGE_DEVICE_AMBIGUOUS');
    assert.equal(calls, 0);
    home!.stop();
    // Observe actual disconnect before testing the remaining eligible device.
    const disconnected = Date.now() + 5000;
    while ((await (await fetch(new URL('/health', url))).json() as any).activeDevices !== 1) {
      assert.ok(Date.now() < disconnected, 'Home did not disconnect');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await kv.put(deviceKey('home-windows'), JSON.stringify({ version: 1, revoked: true }));
    assert.equal((await fetch(new URL('/relay', url), { headers: { Authorization: `Bearer ${homeToken}`, 'X-Device-Id': 'home-windows' } })).status, 401);
    const anonymous = await fetch(new URL('/mcp', url), { method: 'POST', body: '{}' });
    assert.equal(anonymous.status, 401);
    assert.match(anonymous.headers.get('WWW-Authenticate')!, /oauth-protected-resource/);
    const invalid = await fetch(new URL('/mcp', url), { method: 'POST', headers: { Authorization: 'Bearer invalid-private-value' }, body: '{}' });
    assert.equal(invalid.status, 401);
    assert.equal((await invalid.text()).includes('invalid-private-value'), false);
    assert.equal((await fetch(new URL('/mcp', url), { method: 'POST', headers: { Authorization: `Bearer ${wrongScopeToken}` }, body: '{}' })).status, 403);
    assert.equal((await fetch(new URL('/mcp', url), { method: 'POST', headers: { Authorization: `Bearer ${otherUser.access_token}` }, body: '{}' })).status, 403);
    assert.equal(calls, 0, 'Rejected requests must not reach the local smoke/Codex callback');
    for (let i = 0; i < BRIDGE_QUOTA_LIMITS.smoke; i++) {
      const answer = await client.callTool({ name: 'bridge_e2e_smoke', arguments: {} });
      assert.deepEqual(answer.structuredContent, { bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }, JSON.stringify(answer));
    }
    const exhausted = await client.callTool({ name: 'bridge_e2e_smoke', arguments: {} });
    assert.equal((exhausted.content as Array<{ text: string }>)[0]!.text, 'BRIDGE_SMOKE_BUDGET_REACHED');
    assert.equal(calls, BRIDGE_QUOTA_LIMITS.smoke);
    relay?.stop();
    const offline = Date.now() + 5000;
    while ((await (await fetch(new URL('/health', url))).json() as any).activeDevices !== 0) {
      assert.ok(Date.now() < offline, 'Class did not disconnect');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    await kv.put(deviceKey('home-windows'), JSON.stringify({ version: 1, hash: await credentialHash(homeToken), revoked: false }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Home reconnect timeout')), 10_000);
      home = startRelay({ origin: url.origin, deviceId: 'home-windows', token: homeToken,
        smoke: async () => ({ bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }),
        onStatus: status => { if (status === 'connected') { clearTimeout(timer); resolve(); } } });
    });
    const otherDevice = await client.callTool({ name: 'bridge_e2e_smoke', arguments: {} });
    assert.deepEqual(otherDevice.structuredContent, { bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }, 'Home quota is independent of exhausted class quota');
    home?.stop();
  } finally { home?.stop(); relay?.stop(); await client.close(); await mf.dispose(); }
});

test('OAuth lifecycle: expiry, refresh rotation, revocation and reauthorization stay scoped to the approved identity', { timeout: 60_000 }, async () => {
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'tmp/oauth-test/oauth-worker.js', compatibilityDate: '2026-11-02', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], durableObjects: { RELAY: { className: 'Relay', useSQLite: true } }, bindings: { RELAY_TOKEN: 'test-device-only', DEVICE_ID: 'test-device', ALLOWED_GITHUB_ID: '123', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' } }));
  const url = await mf.ready;
  const origin = url.origin;
  const kv = await mf.getKVNamespace('OAUTH_KV');
  const issued: any = await (await fetch(new URL('/__test/token', url))).json();
  const tokenRequest = (params: Record<string, string>) => fetch(new URL('/oauth/token', url), { method: 'POST', body: new URLSearchParams(params) });
  const resourceRequest = (accessToken: string) => fetch(new URL('/mcp', url), { method: 'POST', headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json, text/event-stream', 'Content-Type': 'application/json' }, body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'tools/list', params: {} }) });
  try {
    assert.equal(issued.expires_in, 600);
    assert.equal(issued.scope, 'bridge:smoke');
    assert.ok(issued.refresh_token);
    assert.equal((await resourceRequest(issued.access_token)).status, 200, 'Valid access token may list the single smoke tool');

    // Simulate expiry only inside Miniflare KV; production TTL and tokens stay untouched.
    const [subject, grantId] = issued.access_token.split(':');
    const grantKey = `grant:${subject}:${grantId}`;
    const initialGrant: any = await kv.get(grantKey, { type: 'json' });
    const now = Math.floor(Date.now() / 1000);
    const idleSeconds = 30 * 86400;
    const assertFullWindow = (expiresAt: number, message: string) => {
      assert.ok(Math.abs(expiresAt - Math.floor(Date.now() / 1000) - idleSeconds) <= 5, message);
    };
    assertFullWindow(initialGrant.expiresAt, 'New grant starts with 30 days');
    // A previously issued, still valid grant adopts the new policy on refresh.
    await kv.put(grantKey, JSON.stringify({ ...initialGrant, expiresAt: now + 86400 }), { expirationTtl: 86400 });
    const tokenKey = `token:${subject}:${grantId}:${createHash('sha256').update(issued.access_token).digest('hex')}`;
    const tokenData: any = await kv.get(tokenKey, { type: 'json' });
    assert.ok(tokenData);
    await kv.put(tokenKey, JSON.stringify({ ...tokenData, expiresAt: Math.floor(Date.now() / 1000) - 1 }), { expirationTtl: 120 });
    assert.equal((await resourceRequest(issued.access_token)).status, 401, 'Expired access token never reaches the relay');

    const refresh = (value: string) => tokenRequest({ grant_type: 'refresh_token', refresh_token: value, client_id: issued.client_id, resource: `${origin}/mcp` });
    const firstRefreshResponse = await refresh(issued.refresh_token);
    assert.equal(firstRefreshResponse.status, 200);
    const firstRefresh: any = await firstRefreshResponse.json();
    assert.notEqual(firstRefresh.refresh_token, issued.refresh_token, 'Refresh token rotates');
    assert.equal(firstRefresh.scope, 'bridge:smoke');
    const renewedGrant: any = await kv.get(grantKey, { type: 'json' });
    assertFullWindow(renewedGrant.expiresAt, 'Refresh slides an existing grant by 30 days');
    assert.equal((await resourceRequest(firstRefresh.access_token)).status, 200);

    const retry = await refresh(issued.refresh_token);
    assert.equal(retry.status, 200, 'Immediately previous token can recover a lost refresh response');
    const recovered = await retry.json() as { access_token: string; refresh_token: string };
    assert.notEqual(recovered.refresh_token, firstRefresh.refresh_token);
    assert.equal((await resourceRequest(recovered.access_token)).status, 200);

    // Model a later refresh with only a week left on the rotated grant.
    const recoveredGrant: any = await kv.get(grantKey, { type: 'json' });
    const remaining = 7 * 86400;
    await kv.put(grantKey, JSON.stringify({ ...recoveredGrant, expiresAt: now + remaining }), { expirationTtl: remaining });
    const secondRefreshResponse = await refresh(recovered.refresh_token);
    assert.equal(secondRefreshResponse.status, 200);
    const secondRefresh: any = await secondRefreshResponse.json();
    assert.notEqual(secondRefresh.refresh_token, recovered.refresh_token);
    const secondGrant = await kv.get(grantKey, { type: 'json' }) as { expiresAt: number } | null;
    assert.ok(secondGrant);
    assertFullWindow(secondGrant.expiresAt, 'Later refresh restores the full 30-day window');
    assert.notEqual((await refresh(issued.refresh_token)).status, 200, 'Used previous refresh token is rejected');
    assert.notEqual((await refresh('invalid-refresh-token')).status, 200);

    const revokeResponse = await tokenRequest({ token: secondRefresh.access_token, client_id: issued.client_id });
    assert.equal(revokeResponse.status, 200);
    assert.equal((await resourceRequest(secondRefresh.access_token)).status, 401, 'Revoked token cannot reach the relay');
    assert.equal((await tokenRequest({ token: secondRefresh.refresh_token, client_id: issued.client_id })).status, 200, 'Revoking the refresh token revokes the grant');
    assert.equal((await resourceRequest(firstRefresh.access_token)).status, 401, 'Grant revocation invalidates remaining access');
    const revoked = await refresh(secondRefresh.refresh_token);
    assert.equal(revoked.status, 400);
    assert.deepEqual(await revoked.json(), { error: 'invalid_grant', error_description: 'OAUTH_REAUTH_REQUIRED: reconnect SolicitudPro Bridge.' });

    const reauthorized: any = await (await fetch(new URL('/__test/token', url))).json();
    assert.equal(reauthorized.scope, 'bridge:smoke');
    assert.equal((await resourceRequest(reauthorized.access_token)).status, 200, 'Fresh authorization restores the approved identity');
    const [newSubject, newGrantId] = reauthorized.access_token.split(':');
    const inactiveKey = `grant:${newSubject}:${newGrantId}`;
    const inactive: any = await kv.get(inactiveKey, { type: 'json' });
    await kv.put(inactiveKey, JSON.stringify({ ...inactive, expiresAt: now - 10 }), { expirationTtl: 120 });
    const expired = await tokenRequest({ grant_type: 'refresh_token', refresh_token: reauthorized.refresh_token, client_id: reauthorized.client_id, resource: `${origin}/mcp` });
    assert.equal(expired.status, 400);
    assert.deepEqual(await expired.json(), { error: 'invalid_grant', error_description: 'OAUTH_REAUTH_REQUIRED: reconnect SolicitudPro Bridge.' });
    const other: any = await (await fetch(new URL('/__test/token?other=1', url))).json();
    assert.equal((await resourceRequest(other.access_token)).status, 403, 'Other identity remains denied');
    const otherRefresh = await tokenRequest({ grant_type: 'refresh_token', refresh_token: other.refresh_token, client_id: other.client_id, resource: `${origin}/mcp` });
    assert.equal(otherRefresh.status, 400, 'Refresh cannot preserve an identity that is no longer allowlisted');
    assert.equal((await resourceRequest(other.access_token)).status, 401, 'Rejected identity refresh revokes its grant');
  } finally { await mf.dispose(); }
});

test('bridge:read reaches only the two scoped reads on one authenticated device', { timeout: 30_000 }, async () => {
  const deviceToken = crypto.randomUUID() + crypto.randomUUID();
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'tmp/oauth-test/oauth-worker.js', compatibilityDate: '2026-11-02', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], durableObjects: { RELAY: { className: 'Relay', useSQLite: true } }, bindings: { RELAY_TOKEN: deviceToken, DEVICE_ID: 'class-windows', ALLOWED_GITHUB_ID: '123', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' } }));
  const url = await mf.ready;
  const readToken: any = await (await fetch(new URL('/__test/token?scope=read', url))).json();
  const smokeToken: any = await (await fetch(new URL('/__test/token', url))).json();
  const client = new Client({ name: 'read-test', version: '1' });
  let relay: ReturnType<typeof startRelay> | undefined;
  let home: ReturnType<typeof startRelay> | undefined;
  let calls = 0, contextCalls = 0, searchCalls = 0, analyzeCalls = 0, prepareCalls = 0, applyCalls = 0, approveCalls = 0;
  let latestApprovalId = crypto.randomUUID();
  try {
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Relay connect timeout')), 10_000);
      relay = startRelay({ origin: url.origin, deviceId: 'class-windows', token: deviceToken,
        smoke: async () => ({ bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }),
        projectStatus: async project => { calls++; if (project !== 'solicitudpro') throw new Error('Unknown project'); return { project, deviceId: 'class-windows', branch: 'main', head: 'a'.repeat(40), clean: false, staged: 1, unstaged: 0, untracked: 2, upstream: 'origin/main', ahead: 0, behind: 1 }; },
        contextSnapshot: async project => { contextCalls++; if (project !== 'solicitudpro') throw new Error('Unknown project'); return { project, deviceId: 'class-windows', git: { project, deviceId: 'class-windows', branch: 'main', head: 'a'.repeat(40), clean: false, staged: 1, unstaged: 0, untracked: 2, upstream: 'origin/main', ahead: 0, behind: 1 }, contextSources: [{ path: 'AGENTS.md', role: 'instructions', status: 'ok', dirty: false, excerpts: ['# Project instructions'] }], currentState: 'C19 GLOBAL CERRADA', currentPhase: 'C19 GLOBAL', nextAction: 'Revalidar estado', warnings: ['DOCUMENTATION_DATED_REVALIDATE'] }; },
        projectSearch: async (project, query) => { searchCalls++; if (project !== 'solicitudpro') throw new Error('Unknown project'); return { project, deviceId: 'class-windows', query, matches: [{ file: 'docs/state.md', line: 1, snippet: 'C19' }], totalMatches: 1, truncated: false }; },
        projectAnalyze: async (project, _instruction, options) => { analyzeCalls++; if (project !== 'solicitudpro') throw new Error('Unknown project'); return { project, deviceId: 'class-windows', threadId: 'thread-local-1', threadCreated: true, turnId: 'turn-1', status: 'completed', result: 'Read-only analysis', blockedActions: 0, selectedProfile: options?.profile === 'deep' ? 'deep' : 'fast', requestedModel: 'gpt-test', requestedReasoning: options?.profile === 'deep' ? 'high' : 'low', runtimeModel: 'gpt-test', runtimeReasoning: options?.profile === 'deep' ? 'high' : 'low' }; },
        changes: { prepare: async () => { prepareCalls++; latestApprovalId = crypto.randomUUID(); return { deviceId: 'class-windows', approvalId: latestApprovalId, expiresAt: new Date(Date.now() + 60_000).toISOString(), approvalStatus: 'EXPLICIT_USER_APPROVAL_REQUIRED' }; }, approve: async () => { approveCalls++; return { deviceId: 'class-windows', approvalStatus: 'APPROVED' }; }, apply: async () => { applyCalls++; return { deviceId: 'class-windows', status: 'fixture-approved' }; } },
        onStatus: status => { if (status === 'connected') { clearTimeout(timer); resolve(); } },
      });
    });
    await client.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${readToken.access_token}` } } }));
    const tools = (await client.listTools()).tools;
    assert.deepEqual(tools.map(t => t.name).sort(), ['bridge_devices', 'bridge_e2e_smoke', 'project_git_status', 'project_context_snapshot', 'project_search', 'codex_project_analyze', 'codex_project_change_prepare', 'codex_project_change_approve', 'codex_project_change_apply'].sort());
    assert.match(JSON.stringify(tools.find(t => t.name === 'project_git_status')?._meta), /bridge:read/);
    assert.equal((await client.callTool({ name: 'bridge_e2e_smoke', arguments: {} })).isError, true, 'Read scope does not grant smoke');
    const result = await client.callTool({ name: 'project_git_status', arguments: { project: 'solicitudpro' } });
    assert.deepEqual(result.structuredContent, { project: 'solicitudpro', deviceId: 'class-windows', branch: 'main', head: 'a'.repeat(40), clean: false, staged: 1, unstaged: 0, untracked: 2, upstream: 'origin/main', ahead: 0, behind: 1 });
    assert.equal(calls, 1);
    const context = await client.callTool({ name: 'project_context_snapshot', arguments: { project: 'solicitudpro' } });
    assert.equal((context.structuredContent as any).currentPhase, 'C19 GLOBAL');
    assert.equal((context.structuredContent as any).git.head, 'a'.repeat(40));
    assert.equal(contextCalls, 1);
    const search = await client.callTool({ name: 'project_search', arguments: { project: 'solicitudpro', query: 'C19' } });
    assert.deepEqual((search.structuredContent as any).matches, [{ file: 'docs/state.md', line: 1, snippet: 'C19' }]);
    assert.equal(searchCalls, 1);
    const analysis = await client.callTool({ name: 'codex_project_analyze', arguments: { project: 'solicitudpro', instruction: 'Analiza el estado actual', profile: 'deep', category: 'security' } });
    assert.equal((analysis.structuredContent as any).threadId, 'thread-local-1');
    assert.equal((analysis.structuredContent as any).selectedProfile, 'deep');
    assert.equal((analysis.structuredContent as any).requestedReasoning, 'high');
    assert.equal(analyzeCalls, 1);
    for (let i = 1; i < BRIDGE_QUOTA_LIMITS.analysis; i++) {
      const prepared = await client.callTool({ name: 'codex_project_change_prepare', arguments: { project: 'solicitudpro', instruction: 'Planifica un cambio de prueba' } });
      assert.equal(prepared.isError, undefined);
    }
    assert.equal(prepareCalls, BRIDGE_QUOTA_LIMITS.analysis - 1);
    const analysisLimit = await client.callTool({ name: 'codex_project_change_prepare', arguments: { project: 'solicitudpro', instruction: 'Planifica un cambio de prueba' } });
    assert.equal((analysisLimit.content as Array<{ text: string }>)[0]!.text, 'BRIDGE_ANALYSIS_BUDGET_REACHED');
    const approvalId = latestApprovalId;
    assert.equal((await client.callTool({ name: 'codex_project_change_approve', arguments: { approvalId } })).isError, true);
    assert.equal(approveCalls, 0, 'read scope never reaches APPROVE');
    assert.equal((await client.callTool({ name: 'codex_project_change_apply', arguments: { approvalId } })).isError, true);
    assert.equal(applyCalls, 0, 'read scope never reaches APPLY');
    const writeToken: any = await (await fetch(new URL('/__test/token?scope=write', url))).json();
    const writer = new Client({ name: 'write-test', version: '1' });
    try {
      await writer.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${writeToken.access_token}` } } }));
      assert.equal((await writer.callTool({ name: 'codex_project_change_prepare', arguments: { project: 'solicitudpro', instruction: 'Change fixture only' } })).isError, true, 'write does not imply read');
      assert.equal((await writer.callTool({ name: 'codex_project_change_apply', arguments: { approvalId, instruction: 'tamper' } })).isError, true);
      assert.equal((await writer.callTool({ name: 'codex_project_change_approve', arguments: { approvalId, instruction: 'tamper' } })).isError, true);
      assert.equal((await writer.callTool({ name: 'codex_project_change_approve', arguments: { approvalId } })).isError, undefined);
      assert.equal(approveCalls, 1);
      assert.equal((await writer.callTool({ name: 'codex_project_change_apply', arguments: { approvalId } })).isError, undefined);
      assert.equal(applyCalls, 1);
    } finally { await writer.close(); }
    const homeToken = crypto.randomUUID() + crypto.randomUUID();
    const kv = await mf.getKVNamespace('OAUTH_KV');
    await kv.put(deviceKey('home-windows'), JSON.stringify({ version: 1, hash: await credentialHash(homeToken), revoked: false }));
    await new Promise<void>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('Home connect timeout')), 10_000);
      home = startRelay({ origin: url.origin, deviceId: 'home-windows', token: homeToken,
        smoke: async () => { throw new Error('Ambiguous routing'); },
        onStatus: status => { if (status === 'connected') { clearTimeout(timer); resolve(); } } });
    });
    assert.equal((await client.callTool({ name: 'project_context_snapshot', arguments: { project: 'solicitudpro' } })).isError, true, 'Two devices cannot be selected silently');
    assert.equal((await client.callTool({ name: 'project_search', arguments: { project: 'solicitudpro', query: 'C19' } })).isError, true, 'Two devices cannot be selected silently');
    assert.equal((await client.callTool({ name: 'codex_project_analyze', arguments: { project: 'solicitudpro', instruction: 'Analiza el estado actual' } })).isError, true, 'Two devices cannot be selected silently');
    assert.equal(contextCalls, 1);
    home!.stop();
    const until = Date.now() + 5000;
    while ((await (await fetch(new URL('/health', url))).json() as any).activeDevices !== 1) {
      assert.ok(Date.now() < until, 'Home did not disconnect');
      await new Promise(resolve => setTimeout(resolve, 20));
    }
    for (const args of [{ project: 'solicitudpro', path: 'AGENTS.md' }, { project: 'solicitudpro', filename: '.env' }, { project: '../../' }, { project: 'C:\\Windows' }]) assert.equal((await client.callTool({ name: 'project_context_snapshot', arguments: args })).isError, true);
    for (const args of [{ project: 'solicitudpro', query: 'C19', path: 'js' }, { project: 'solicitudpro', query: '../' }, { project: 'solicitudpro', query: 'C19', command: 'pwd' }]) assert.equal((await client.callTool({ name: 'project_search', arguments: args })).isError, true);
    assert.equal(searchCalls, 1, 'Unsafe search inputs never reach device');
    assert.equal(contextCalls, 1, 'Unsafe inputs never reach local context callback');
    assert.equal((await client.callTool({ name: 'project_context_snapshot', arguments: { project: 'other-project' } })).isError, true);
    assert.equal(contextCalls, 2, 'Unknown logical project rejected by local allowlist');
    for (const project of ['other-project', '../../', '/etc', 'C:\\Windows']) assert.equal((await client.callTool({ name: 'project_git_status', arguments: { project } })).isError, true);
    assert.equal(calls, 2, 'Only a syntactically valid unknown project reaches local allowlist');
    const smokeClient = new Client({ name: 'smoke-scope-test', version: '1' });
    await smokeClient.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${smokeToken.access_token}` } } }));
    try {
      assert.equal((await smokeClient.callTool({ name: 'project_git_status', arguments: { project: 'solicitudpro' } })).isError, true);
      assert.equal((await smokeClient.callTool({ name: 'project_context_snapshot', arguments: { project: 'solicitudpro' } })).isError, true);
      assert.equal((await smokeClient.callTool({ name: 'project_search', arguments: { project: 'solicitudpro', query: 'C19' } })).isError, true);
      assert.equal((await smokeClient.callTool({ name: 'codex_project_analyze', arguments: { project: 'solicitudpro', instruction: 'Analiza el estado actual' } })).isError, true);
    }
    finally { await smokeClient.close(); }
    assert.equal(calls, 2, 'Smoke-only token never dispatches read');
    assert.equal(contextCalls, 2, 'Smoke-only token never dispatches context');
    assert.equal(searchCalls, 1, 'Smoke-only token never dispatches search');
    assert.equal(analyzeCalls, 1, 'Smoke-only token never dispatches Codex analysis');
  } finally { home?.stop(); relay?.stop(); await client.close(); await mf.dispose(); }
});

test('three eligible relays require explicit routing and expose only sanitized discovery', { timeout: 45_000 }, async () => {
  const tokens = {
    'class-windows': crypto.randomUUID() + crypto.randomUUID(),
    'home-windows': crypto.randomUUID() + crypto.randomUUID(),
    'home-mac': crypto.randomUUID() + crypto.randomUUID(),
  };
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'tmp/oauth-test/oauth-worker.js', compatibilityDate: '2026-11-02', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], durableObjects: { RELAY: { className: 'Relay', useSQLite: true } }, bindings: { RELAY_TOKEN: tokens['class-windows'], DEVICE_ID: 'class-windows', ALLOWED_GITHUB_ID: '123', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' } }));
  const url = await mf.ready;
  const kv = await mf.getKVNamespace('OAUTH_KV');
  for (const deviceId of ['home-windows', 'home-mac'] as const) await kv.put(deviceKey(deviceId), JSON.stringify({ version: 1, hash: await credentialHash(tokens[deviceId]), revoked: false }));
  const calls: Record<string, number> = { 'class-windows': 0, 'home-windows': 0, 'home-mac': 0 };
  const routed: string[] = [];
  const relays: Array<ReturnType<typeof startRelay>> = [];
  const connect = (deviceId: keyof typeof tokens) => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error(`${deviceId} connect timeout`)), 10_000);
    const git = (project: string) => ({ project, deviceId, branch: 'main', head: 'a'.repeat(40), clean: true, staged: 0, unstaged: 0, untracked: 0, upstream: 'origin/main', ahead: 0, behind: 0 });
    relays.push(startRelay({ origin: url.origin, deviceId, token: tokens[deviceId],
      smoke: async () => { calls[deviceId] = (calls[deviceId] ?? 0) + 1; return { bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }; },
      projectStatus: async project => { routed.push(`status:${deviceId}`); return git(project); },
      contextSnapshot: async project => { routed.push(`context:${deviceId}`); return { project, deviceId, git: git(project), contextSources: [{ path: 'AGENTS.md', role: 'instructions', status: 'ok', dirty: false, excerpts: ['Bridge fixture'] }], currentState: null, currentPhase: null, nextAction: null, warnings: [] }; },
      projectSearch: async (project, query) => { routed.push(`search:${deviceId}`); return { project, deviceId, query, matches: [], truncated: false, totalMatches: 0 }; },
      projectAnalyze: async project => { routed.push(`analyze:${deviceId}`); return { project, deviceId, threadId: `thread-${deviceId}`, threadCreated: false, turnId: `turn-${deviceId}`, status: 'completed', result: 'ok', blockedActions: 0, selectedProfile: 'fast', requestedModel: 'gpt-test', requestedReasoning: 'low', runtimeModel: 'gpt-test', runtimeReasoning: 'low' }; },
      changes: { prepare: async () => { routed.push(`prepare:${deviceId}`); return { deviceId, approvalId: crypto.randomUUID(), expiresAt: new Date(Date.now() + 60_000).toISOString() }; }, approve: async () => ({ deviceId }), apply: async () => ({ deviceId }) },
      onStatus: status => { if (status === 'connected') { clearTimeout(timer); resolve(); } },
    }));
  });
  const smoke = new Client({ name: 'routing-smoke-test', version: '1' });
  const read = new Client({ name: 'routing-read-test', version: '1' });
  try {
    await connect('class-windows'); await connect('home-windows'); await connect('home-mac');
    const smokeToken: any = await (await fetch(new URL('/__test/token', url))).json();
    const readToken: any = await (await fetch(new URL('/__test/token?scope=read', url))).json();
    await smoke.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${smokeToken.access_token}` } } }));
    await read.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${readToken.access_token}` } } }));
    const ambiguous = await smoke.callTool({ name: 'bridge_e2e_smoke', arguments: {} });
    assert.equal((ambiguous.content as Array<{ text: string }>)[0]!.text, 'BRIDGE_DEVICE_AMBIGUOUS');
    for (const deviceId of ['home-mac', 'home-windows', 'class-windows']) {
      const result = await smoke.callTool({ name: 'bridge_e2e_smoke', arguments: { deviceId } });
      assert.equal(result.isError, undefined, `${deviceId} must be explicitly routable`);
    }
    assert.deepEqual(calls, { 'class-windows': 1, 'home-windows': 1, 'home-mac': 1 });
    const discovery = await read.callTool({ name: 'bridge_devices', arguments: {} });
    assert.deepEqual(discovery.structuredContent, {
      devices: [
        { deviceId: 'class-windows', connected: true },
        { deviceId: 'home-mac', connected: true },
        { deviceId: 'home-windows', connected: true },
      ],
      activeDevices: 3,
      relayProtocolVersion: 2,
    });
    assert.equal(JSON.stringify(discovery.structuredContent).match(/(?:token|hash|host|path|ip|credential)/i), null);
    assert.equal((await read.callTool({ name: 'project_git_status', arguments: { project: 'solicitudpro', deviceId: 'home-mac' } }).then(result => (result.structuredContent as any).deviceId)), 'home-mac');
    assert.equal((await read.callTool({ name: 'project_context_snapshot', arguments: { project: 'solicitudpro', deviceId: 'home-mac' } }).then(result => (result.structuredContent as any).deviceId)), 'home-mac');
    assert.equal((await read.callTool({ name: 'project_search', arguments: { project: 'solicitudpro', query: 'C19', deviceId: 'home-mac' } }).then(result => (result.structuredContent as any).deviceId)), 'home-mac');
    assert.equal((await read.callTool({ name: 'codex_project_analyze', arguments: { project: 'solicitudpro', instruction: 'Analiza el estado actual', deviceId: 'home-mac' } }).then(result => (result.structuredContent as any).deviceId)), 'home-mac');
    assert.equal((await read.callTool({ name: 'codex_project_change_prepare', arguments: { project: 'solicitudpro', instruction: 'Planifica un cambio seguro', deviceId: 'home-mac' } }).then(result => (result.structuredContent as any).deviceId)), 'home-mac');
    assert.deepEqual(routed, ['status:home-mac', 'context:home-mac', 'search:home-mac', 'analyze:home-mac', 'prepare:home-mac']);
    const missing = await smoke.callTool({ name: 'bridge_e2e_smoke', arguments: { deviceId: 'missing-device' } });
    assert.equal((missing.content as Array<{ text: string }>)[0]!.text, 'BRIDGE_DEVICE_UNAVAILABLE');
    assert.deepEqual(calls, { 'class-windows': 1, 'home-windows': 1, 'home-mac': 1 }, 'missing selector never falls back');
  } finally {
    for (const relay of relays) relay.stop();
    await smoke.close(); await read.close(); await mf.dispose();
  }
});

test('prepared changes remain bound to their device across disconnect, reconnect, apply and expiry', { timeout: 45_000 }, async () => {
  const tokens = { 'home-mac': crypto.randomUUID() + crypto.randomUUID(), 'home-windows': crypto.randomUUID() + crypto.randomUUID() };
  const liveApprovalId = crypto.randomUUID();
  const expiredApprovalId = crypto.randomUUID();
  const mf = new Miniflare(convertV4MiniflareOptions({ modules: true, scriptPath: 'tmp/oauth-test/oauth-worker.js', compatibilityDate: '2026-11-02', compatibilityFlags: ['nodejs_compat', 'global_fetch_strictly_public'], kvNamespaces: ['OAUTH_KV'], durableObjects: { RELAY: { className: 'Relay', useSQLite: true } }, bindings: { RELAY_TOKEN: 'x'.repeat(64), DEVICE_ID: 'class-windows', ALLOWED_GITHUB_ID: '123', GITHUB_CLIENT_ID: 'test-client', GITHUB_CLIENT_SECRET: 'test-secret' } }));
  const url = await mf.ready;
  const kv = await mf.getKVNamespace('OAUTH_KV');
  for (const deviceId of ['home-mac', 'home-windows'] as const) await kv.put(deviceKey(deviceId), JSON.stringify({ version: 1, hash: await credentialHash(tokens[deviceId]), revoked: false }));
  const calls = { macPrepare: 0, macApprove: 0, macApply: 0, windowsApprove: 0, windowsApply: 0 };
  let mac: ReturnType<typeof startRelay> | undefined;
  let windows: ReturnType<typeof startRelay> | undefined;
  const connectMac = () => new Promise<void>((resolve, reject) => {
    const timer = setTimeout(() => reject(new Error('home-mac connect timeout')), 10_000);
    mac = startRelay({ origin: url.origin, deviceId: 'home-mac', token: tokens['home-mac'], smoke: async () => ({ bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }), changes: {
      prepare: async (_project, instruction) => { calls.macPrepare++; const expired = instruction.includes('expired'); return { deviceId: 'home-mac', approvalId: expired ? expiredApprovalId : liveApprovalId, expiresAt: new Date(Date.now() + (expired ? -1_000 : 60_000)).toISOString() }; },
      approve: async approvalId => { calls.macApprove++; assert.equal(approvalId, liveApprovalId); return { deviceId: 'home-mac', approvalId, approvalStatus: 'APPROVED' }; },
      apply: async approvalId => { calls.macApply++; assert.equal(approvalId, liveApprovalId); return { deviceId: 'home-mac', approvalId, status: 'APPLIED' }; },
    }, onStatus: status => { if (status === 'connected') { clearTimeout(timer); resolve(); } } });
  });
  const read = new Client({ name: 'device-bound-read', version: '1' });
  const write = new Client({ name: 'device-bound-write', version: '1' });
  try {
    windows = await new Promise<ReturnType<typeof startRelay>>((resolve, reject) => {
      const timer = setTimeout(() => reject(new Error('home-windows connect timeout')), 10_000);
      const relay = startRelay({ origin: url.origin, deviceId: 'home-windows', token: tokens['home-windows'], smoke: async () => ({ bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }), changes: {
        prepare: async () => ({ deviceId: 'home-windows' }),
        approve: async approvalId => { calls.windowsApprove++; return { deviceId: 'home-windows', approvalId, approvalStatus: 'APPROVED' }; },
        apply: async approvalId => { calls.windowsApply++; return { deviceId: 'home-windows', approvalId, status: 'APPLIED' }; },
      }, onStatus: status => { if (status === 'connected') { clearTimeout(timer); resolve(relay); } } });
    });
    await connectMac();
    const readToken: any = await (await fetch(new URL('/__test/token?scope=read', url))).json();
    const writeToken: any = await (await fetch(new URL('/__test/token?scope=write', url))).json();
    await read.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${readToken.access_token}` } } }));
    await write.connect(new StreamableHTTPClientTransport(new URL('/mcp', url), { requestInit: { headers: { Authorization: `Bearer ${writeToken.access_token}` } } }));
    const prepared = await read.callTool({ name: 'codex_project_change_prepare', arguments: { project: 'solicitudpro', instruction: 'Planifica un cambio seguro', deviceId: 'home-mac' } });
    assert.equal((prepared.structuredContent as any).approvalId, liveApprovalId);
    mac!.stop();
    const disconnected = Date.now() + 5_000;
    while ((await (await fetch(new URL('/health', url))).json() as any).activeDevices !== 1) { assert.ok(Date.now() < disconnected, 'home-mac did not disconnect'); await new Promise(resolve => setTimeout(resolve, 20)); }
    const offlineApprove = await write.callTool({ name: 'codex_project_change_approve', arguments: { approvalId: liveApprovalId } });
    assert.equal((offlineApprove.content as Array<{ text: string }>)[0]!.text, 'BRIDGE_DEVICE_UNAVAILABLE');
    assert.deepEqual({ mac: calls.macApprove, windows: calls.windowsApprove }, { mac: 0, windows: 0 }, 'approval never falls back to another connected device');
    await connectMac();
    assert.equal((await write.callTool({ name: 'codex_project_change_approve', arguments: { approvalId: liveApprovalId } })).isError, undefined);
    assert.equal((await write.callTool({ name: 'codex_project_change_apply', arguments: { approvalId: liveApprovalId } })).isError, undefined);
    assert.deepEqual({ macApprove: calls.macApprove, macApply: calls.macApply, windowsApprove: calls.windowsApprove, windowsApply: calls.windowsApply }, { macApprove: 1, macApply: 1, windowsApprove: 0, windowsApply: 0 });
    const replay = await write.callTool({ name: 'codex_project_change_apply', arguments: { approvalId: liveApprovalId } });
    assert.equal((replay.content as Array<{ text: string }>)[0]!.text, 'BRIDGE_DEVICE_UNAVAILABLE', 'successful apply consumes the gateway binding');
    await read.callTool({ name: 'codex_project_change_prepare', arguments: { project: 'solicitudpro', instruction: 'Planifica un cambio expired', deviceId: 'home-mac' } });
    const expired = await write.callTool({ name: 'codex_project_change_approve', arguments: { approvalId: expiredApprovalId } });
    assert.equal((expired.content as Array<{ text: string }>)[0]!.text, 'BRIDGE_DEVICE_UNAVAILABLE');
    assert.equal(calls.macApprove, 1, 'expired gateway binding never reaches the relay');
  } finally {
    mac?.stop(); windows?.stop(); await read.close(); await write.close(); await mf.dispose();
  }
});
