import test from 'node:test';
import assert from 'node:assert/strict';
import { SmokeBroker, validResult, authorizedDevice } from '../src/relay-protocol.js';

test('relay authenticates only the configured device and credential', async () => {
  assert.equal(await authorizedDevice('Bearer test-value', 'class', 'test-value', 'class'), true);
  assert.equal(await authorizedDevice('Bearer wrong', 'class', 'test-value', 'class'), false);
  assert.equal(await authorizedDevice('Bearer test-value', 'home', 'test-value', 'class'), false);
  assert.equal(await authorizedDevice(null, 'class', '', 'class'), false);
});
test('relay correlates result IDs and rejects forged or malformed results', async () => {
  const broker = new SmokeBroker(100);
  let request: any;
  const promise = broker.request({ send: value => { request = JSON.parse(value); } });
  assert.equal(request.type, 'smoke');
  broker.result({ type: 'result', id: 'wrong', ok: true, response: 'BRIDGE_E2E_OK' });
  broker.result({ type: 'result', id: request.id, ok: true, response: 'BRIDGE_E2E_OK' });
  assert.equal((await promise).response, 'BRIDGE_E2E_OK');
  assert.equal(validResult({ type: 'result', id: request.id, ok: true, response: 'private data' }), false);
});
test('relay handles offline, timeout, single-flight and disconnect', async () => {
  const broker = new SmokeBroker(10);
  await assert.rejects(broker.request(undefined), /unavailable/);
  const timeout = broker.request({ send() {} });
  await assert.rejects(broker.request({ send() {} }), /busy/);
  await assert.rejects(timeout, /timeout/);
  const disconnected = broker.request({ send() {} });
  broker.disconnect();
  await assert.rejects(disconnected, /disconnected/);
});
