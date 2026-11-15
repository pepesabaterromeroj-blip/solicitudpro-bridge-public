import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { once } from 'node:events';
import test from 'node:test';
import { WebSocketServer, type WebSocket } from 'ws';
import { startRelay } from '../local/relay.js';

test('relay budgets recover over time and deduplication survives reconnect', { timeout: 15_000 }, async t => {
  const server = new WebSocketServer({ host: '127.0.0.1', port: 0 });
  await once(server, 'listening');
  const address = server.address();
  assert.ok(address && typeof address !== 'string');
  let now = Date.now(), calls = 0;
  const options = {
    origin: `http://127.0.0.1:${address.port}`, deviceId: 'fixture', token: randomUUID(), now: () => now,
    smoke: async () => { calls++; return { bridge: 'ok', codex: 'ok', response: 'BRIDGE_E2E_OK' } as const; },
  };
  const connected = once(server, 'connection');
  const relay = startRelay(options);
  t.after(() => { relay.stop(); for (const client of server.clients) client.terminate(); server.close(); });
  let [socket] = await connected as [WebSocket];
  const call = async (id = randomUUID()) => {
    const answer = once(socket, 'message');
    socket.send(JSON.stringify({ type: 'smoke', id }));
    const [data] = await answer;
    return JSON.parse(String(data)).ok;
  };
  for (let window = 0; window < 2; window++) {
    for (let i = 0; i < 100; i++) assert.equal(await call(), true);
    assert.equal(await call(), false);
    now += 60_000;
  }
  const previousId = randomUUID();
  assert.equal(await call(previousId), true);
  const reconnected = once(server, 'connection');
  socket.terminate();
  [socket] = await reconnected as [WebSocket];
  socket.send(JSON.stringify({ type: 'smoke', id: previousId }));
  assert.equal(await call(), true);
  assert.equal(calls, 202);
});
