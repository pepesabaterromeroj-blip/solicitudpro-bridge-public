import { DurableObject } from 'cloudflare:workers';
import { WebStandardStreamableHTTPServerTransport } from '@modelcontextprotocol/sdk/server/webStandardStreamableHttp.js';
import { createSmokeMcpServer } from '../src/smoke-mcp-server.js';
import { SmokeBroker, ProjectStatusBroker, ProjectContextBroker, ProjectSearchBroker, ProjectAnalyzeBroker, ChangeBroker } from '../src/relay-protocol.js';
import { deviceKey, deviceCredentialHash, verifyDeviceCredential, validDeviceId } from '../src/device-auth.js';
import { oauthGateway, type OAuthEnv } from './oauth.js';
import { consumeBridgeQuota } from './bridge-quotas.js';
import { BridgeError } from '../src/bridge-errors.js';
import { describeDevices, RELAY_PROTOCOL_VERSION, selectDeviceId } from '../src/device-routing.js';

interface Env extends OAuthEnv { RELAY: DurableObjectNamespace; RELAY_TOKEN: string; DEVICE_ID: string; CF_VERSION_METADATA?: { id: string } }
type ApprovalDeviceBinding = { version: 1; deviceId: string; expiresAt: string };
export class Relay extends DurableObject<Env> {
  private broker = new SmokeBroker();
  private statusBroker = new ProjectStatusBroker();
  private contextBroker = new ProjectContextBroker();
  private searchBroker = new ProjectSearchBroker();
  private analyzeBroker = new ProjectAnalyzeBroker();
  private changeBroker = new ChangeBroker();
  private busy = false;
  private activeSocket?: WebSocket;
  private async expectedHash(id: string): Promise<string | null> {
    if (!validDeviceId(id)) return null;
    const record = await this.env.OAUTH_KV.get(deviceKey(id), 'json');
    return deviceCredentialHash(id, record, this.env.DEVICE_ID, this.env.RELAY_TOKEN);
  }
  private async eligibleSockets(): Promise<WebSocket[]> {
    const eligible: WebSocket[] = [];
    for (const socket of this.ctx.getWebSockets()) {
      const identity = socket.deserializeAttachment();
      if (identity?.device && identity.hash === await this.expectedHash(identity.device)) eligible.push(socket);
      else socket.close(1008, 'Device unavailable');
    }
    return eligible;
  }
  private async selectedSocket(requestedDeviceId?: string): Promise<WebSocket> {
    const sockets = await this.eligibleSockets();
    const selected = selectDeviceId(sockets.map(socket => socket.deserializeAttachment().device as string), requestedDeviceId);
    const socket = sockets.find(candidate => candidate.deserializeAttachment().device === selected);
    if (!socket) throw new BridgeError('BRIDGE_DEVICE_UNAVAILABLE');
    return socket;
  }
  private approvalBindingKey(approvalId: string): string { return `approval-device:v1:${approvalId}`; }
  private async bindApproval(value: any, deviceId: string): Promise<void> {
    const approvalId = value?.approvalId;
    const expiresAt = value?.expiresAt;
    if (!/^[0-9a-f-]{36}$/.test(approvalId ?? '') || !validDeviceId(deviceId) || value?.deviceId !== deviceId || typeof expiresAt !== 'string' || !Number.isFinite(Date.parse(expiresAt)) || Date.parse(expiresAt) <= Date.now()) {
      throw new Error('Invalid approval binding');
    }
    await this.ctx.storage.put(this.approvalBindingKey(approvalId), { version: 1, deviceId, expiresAt } satisfies ApprovalDeviceBinding);
  }
  private async boundApprovalDevice(approvalId: string): Promise<string> {
    const key = this.approvalBindingKey(approvalId);
    const value = await this.ctx.storage.get<ApprovalDeviceBinding>(key);
    if (!value || value.version !== 1 || !validDeviceId(value.deviceId) || typeof value.expiresAt !== 'string' || !Number.isFinite(Date.parse(value.expiresAt)) || Date.parse(value.expiresAt) <= Date.now()) {
      if (value) await this.ctx.storage.delete(key);
      throw new BridgeError('BRIDGE_DEVICE_UNAVAILABLE');
    }
    return value.deviceId;
  }
  constructor(ctx: DurableObjectState, env: Env) {
    super(ctx, env);
    ctx.setWebSocketAutoResponse(new WebSocketRequestResponsePair('ping', 'pong'));
  }
  async fetch(request: Request): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' || path === '/relay') console.log('relay-executing-version', this.env.CF_VERSION_METADATA?.id ?? 'unbound', RELAY_PROTOCOL_VERSION);
    if (path === '/relay') {
      const device = request.headers.get('X-Device-Id') ?? '';
      const hash = await this.expectedHash(device);
      if (!await verifyDeviceCredential(request.headers.get('Authorization'), hash)) return new Response('Unauthorized', { status: 401, headers: { 'X-Bridge-Relay-Protocol': String(RELAY_PROTOCOL_VERSION) } });
      if (request.headers.get('Upgrade')?.toLowerCase() !== 'websocket') return new Response('WebSocket required', { status: 426 });
      await this.eligibleSockets();
      if (this.ctx.getWebSockets().some(s => s.deserializeAttachment()?.device === device)) return new Response('Device already connected', { status: 409 });
      const pair = new WebSocketPair();
      this.ctx.acceptWebSocket(pair[1]);
      pair[1].serializeAttachment({ device, hash });
      return new Response(null, { status: 101, webSocket: pair[0] });
    }
    if (path === '/health') {
      const activeDevices = (await this.eligibleSockets()).length;
      return Response.json({ status: 'ok', mode: 'external-smoke', connected: activeDevices > 0, activeDevices, relayProtocolVersion: RELAY_PROTOCOL_VERSION }, { headers: { 'Cache-Control': 'no-store' } });
    }
    if (path !== '/mcp') return new Response('Not found', { status: 404 });
    if (request.method !== 'POST') return new Response(null, { status: 405, headers: { Allow: 'POST' } });
    // Reject browser cross-origin submissions; server-to-server MCP needs no CORS.
    const origin = request.headers.get('Origin');
    if (origin && origin !== new URL(request.url).origin) return new Response('Forbidden', { status: 403 });
    // Bound the actual stream too, including chunked requests without Content-Length.
    const reader = request.body?.getReader();
    const chunks: Uint8Array[] = []; let size = 0;
    if (reader) {
      while (true) {
        const chunk = await reader.read(); if (chunk.done) break;
        size += chunk.value.length;
        if (size > 16_384) { await reader.cancel(); return new Response('Too large', { status: 413 }); }
        chunks.push(chunk.value);
      }
    }
    const bytesIn = new Uint8Array(size); let offset = 0;
    for (const chunk of chunks) { bytesIn.set(chunk, offset); offset += chunk.length; }
    const body = new TextDecoder().decode(bytesIn);
    const scopes = (request.headers.get('X-Bridge-Scopes') ?? '').split(' ').filter(Boolean);
    const changeRequest = async (operation: 'prepare' | 'approve' | 'apply', args: { approvalId?: string; [key: string]: unknown }, requestedDeviceId?: string) => {
      if (this.busy) throw new Error('Busy'); this.busy = true;
      try {
        const deviceId = operation === 'prepare' ? requestedDeviceId : await this.boundApprovalDevice(args.approvalId ?? '');
        this.activeSocket = await this.selectedSocket(deviceId);
        const device = this.activeSocket.deserializeAttachment().device as string;
        await consumeBridgeQuota(this.ctx.storage, operation === 'prepare' ? 'analysis' : 'change', device);
        const id = crypto.randomUUID();
        console.log('relay-change-dispatch', operation, id, device);
        const value = await this.changeBroker.request(this.activeSocket, operation, args, device, id);
        if (operation === 'prepare') await this.bindApproval(value, device);
        if (operation === 'apply') await this.ctx.storage.delete(this.approvalBindingKey(args.approvalId!));
        return value;
      } finally { this.busy = false; this.activeSocket = undefined; }
    };
    const server = createSmokeMcpServer(async deviceId => {
      if (this.busy) throw new Error('Unavailable');
      this.busy = true;
      try {
        const socket = await this.selectedSocket(deviceId);
        this.activeSocket = socket;
        await consumeBridgeQuota(this.ctx.storage, 'smoke', socket.deserializeAttachment().device);
        const trace = request.headers.get('X-Bridge-Trace');
        const id = trace && /^[0-9a-f-]{36}$/.test(trace) ? trace : crypto.randomUUID();
        console.log('relay-smoke-dispatch', id, socket.deserializeAttachment().device);
        return await this.broker.request(socket, id);
      } finally { this.busy = false; this.activeSocket = undefined; }
    }, async (project, deviceId) => {
      if (this.busy) throw new Error('Unavailable');
      this.busy = true;
      try {
        const socket = await this.selectedSocket(deviceId);
        this.activeSocket = socket;
        await consumeBridgeQuota(this.ctx.storage, 'read', socket.deserializeAttachment().device);
        const trace = request.headers.get('X-Bridge-Trace');
        const id = trace && /^[0-9a-f-]{36}$/.test(trace) ? trace : crypto.randomUUID();
        const device = socket.deserializeAttachment().device as string;
        console.log('relay-project-status-dispatch', id, device, project);
        return await this.statusBroker.request(socket, project, device, id);
      } finally { this.busy = false; this.activeSocket = undefined; }
    }, scopes, `${this.env.GATEWAY_ORIGIN}/.well-known/oauth-protected-resource/mcp`, async (project, deviceId) => {
      if (this.busy) throw new Error('Unavailable');
      this.busy = true;
      try {
        const socket = await this.selectedSocket(deviceId);
        this.activeSocket = socket;
        await consumeBridgeQuota(this.ctx.storage, 'read', socket.deserializeAttachment().device);
        const trace = request.headers.get('X-Bridge-Trace');
        const id = trace && /^[0-9a-f-]{36}$/.test(trace) ? trace : crypto.randomUUID();
        const device = socket.deserializeAttachment().device as string;
        console.log('relay-context-dispatch', id, device, project);
        return await this.contextBroker.request(socket, project, device, id);
      } finally { this.busy = false; this.activeSocket = undefined; }
    }, async (project, query, deviceId) => {
      if (this.busy) throw new Error('Unavailable');
      this.busy = true;
      try {
        const socket = await this.selectedSocket(deviceId);
        this.activeSocket = socket;
        await consumeBridgeQuota(this.ctx.storage, 'read', socket.deserializeAttachment().device);
        const trace = request.headers.get('X-Bridge-Trace');
        const id = trace && /^[0-9a-f-]{36}$/.test(trace) ? trace : crypto.randomUUID();
        const device = socket.deserializeAttachment().device as string;
        console.log('relay-search-dispatch', id, device, project);
        return await this.searchBroker.request(socket, project, query, device, id);
      } finally { this.busy = false; this.activeSocket = undefined; }
    }, async (project, instruction, options) => {
      if (this.busy) throw new Error('Unavailable');
      this.busy = true;
      try {
        const socket = await this.selectedSocket(options?.deviceId);
        this.activeSocket = socket;
        await consumeBridgeQuota(this.ctx.storage, 'analysis', socket.deserializeAttachment().device);
        const trace = request.headers.get('X-Bridge-Trace');
        const id = trace && /^[0-9a-f-]{36}$/.test(trace) ? trace : crypto.randomUUID();
        const device = socket.deserializeAttachment().device as string;
        console.log('relay-analysis-dispatch', id, device, project);
        return await this.analyzeBroker.request(socket, project, instruction, device, id, {
          profile: options?.profile,
          category: options?.category,
        });
      } finally { this.busy = false; this.activeSocket = undefined; }
    }, { prepare: (project, instruction, options) => changeRequest('prepare', { project, instruction, profile: options?.profile, category: options?.category }, options?.deviceId), approve: approvalId => changeRequest('approve', { approvalId }), apply: approvalId => changeRequest('apply', { approvalId }) }, async () => describeDevices((await this.eligibleSockets()).map(socket => socket.deserializeAttachment().device as string)));
    const transport = new WebStandardStreamableHTTPServerTransport({ sessionIdGenerator: undefined, enableJsonResponse: true });
    try {
      await server.connect(transport);
      const response = await transport.handleRequest(new Request(request, { body }));
      const bytes = await response.arrayBuffer();
      return new Response(bytes, { status: response.status, headers: response.headers });
    } finally { await server.close(); }
  }
  webSocketMessage(socket: WebSocket, message: string | ArrayBuffer): void {
    if (socket !== this.activeSocket) return;
    if (typeof message !== 'string' || message.length > 8192) { socket.close(1008, 'Invalid message'); return; }
    try { const value = JSON.parse(message); this.broker.result(value); this.statusBroker.result(value); this.contextBroker.result(value); this.searchBroker.result(value); this.analyzeBroker.result(value); this.changeBroker.result(value); } catch { socket.close(1008, 'Invalid message'); }
  }
  webSocketClose(socket: WebSocket): void { if (socket === this.activeSocket) { this.broker.disconnect(); this.statusBroker.disconnect(); this.contextBroker.disconnect(); this.searchBroker.disconnect(); this.analyzeBroker.disconnect(); this.changeBroker.disconnect(); } }
  webSocketError(socket: WebSocket): void { if (socket === this.activeSocket) { this.broker.disconnect(); this.statusBroker.disconnect(); this.contextBroker.disconnect(); this.searchBroker.disconnect(); this.analyzeBroker.disconnect(); this.changeBroker.disconnect(); } }
}
export default {
  async fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> {
    const path = new URL(request.url).pathname;
    if (path === '/health' || path === '/relay') console.log('gateway-executing-version', env.CF_VERSION_METADATA?.id ?? 'unbound');
    try {
      const response = await oauthGateway(env, req => env.RELAY.get(env.RELAY.idFromName('active-smoke')).fetch(req)).fetch(request, env, ctx);
      if (path !== '/health') return response;
      const headers = new Headers(response.headers);
      headers.set('X-Bridge-Worker-Version', env.CF_VERSION_METADATA?.id ?? 'unbound');
      return new Response(response.body, { status: response.status, headers });
    }
    catch { return new Response('Gateway unavailable', { status: 503 }); }
  },
};
