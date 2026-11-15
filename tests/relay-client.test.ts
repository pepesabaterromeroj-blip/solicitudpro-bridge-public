import test from 'node:test';
import assert from 'node:assert/strict';
import { WebSocketServer } from 'ws';
import { startRelay } from '../local/relay.js';

test('local relay ignores arbitrary instructions and replay; sends only fixed result', { timeout: 5000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const address = server.address();
  assert.equal(typeof address, 'object');
  let calls = 0;
  const done = new Promise<void>((resolve, reject) => server.once('connection', (socket, request) => {
    assert.equal(request.headers['x-device-id'], 'test-device');
    const id = crypto.randomUUID();
    socket.send(JSON.stringify({ type: 'command', prompt: 'arbitrary' }));
    socket.send(JSON.stringify({ type: 'smoke', id, prompt: 'arbitrary' }));
    socket.send(JSON.stringify({ type: 'smoke', id }));
    socket.send(JSON.stringify({ type: 'smoke', id }));
    socket.once('message', raw => {
      try { assert.deepEqual(JSON.parse(raw.toString()), { type: 'result', id, ok: true, response: 'BRIDGE_E2E_OK' }); assert.equal(calls, 1); resolve(); }
      catch (error) { reject(error); }
    });
  }));
  const relay = startRelay({ origin: `http://127.0.0.1:${(address as any).port}`, deviceId: 'test-device', token: 'x'.repeat(40), smoke: async () => { calls++; return { bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }; } });
  try { await done; } finally { relay.stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});

test('local relay reconnects after disconnect and completes heartbeat without logging credentials', { timeout: 40_000 }, async () => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await new Promise<void>(resolve => server.once('listening', resolve));
  const token = crypto.randomUUID() + crypto.randomUUID();
  const statuses: string[] = [];
  let connections = 0;
  let resolvePong!: () => void;
  const pong = new Promise<void>(resolve => { resolvePong = resolve; });
  server.on('connection', socket => {
    if (++connections === 1) { socket.terminate(); return; }
    socket.on('message', raw => { if (raw.toString() === 'ping') { socket.send('pong'); resolvePong(); } });
  });
  const relay = startRelay({ origin: `http://127.0.0.1:${(server.address() as any).port}`, deviceId: 'home-windows', token,
    smoke: async () => ({ bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' }), onStatus: s => statuses.push(s) });
  try {
    await pong;
    assert.equal(connections, 2);
    assert.equal(statuses.filter(s => s === 'connected').length, 2);
    assert.ok(statuses.includes('disconnected'));
    assert.equal(statuses.join(' ').includes(token), false);
  } finally { relay.stop(); for (const socket of server.clients) socket.terminate(); await new Promise<void>(resolve => server.close(() => resolve())); }
});
