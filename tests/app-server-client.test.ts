import assert from "node:assert/strict";
import { EventEmitter } from "node:events";
import test from "node:test";
import { AppServerClient, type AppServerTransport } from "../src/app-server-client.js";

class FakeTransport extends EventEmitter implements AppServerTransport {
  writes: string[] = [];
  alive = true;
  write(line: string) { this.writes.push(line); }
  isAlive() { return this.alive; }
  stop() { this.alive = false; this.emit("exit", 0); }
}

test("client initializes and correlates responses", async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient({ transportFactory: () => transport });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.writes[0] ?? "{}");
  assert.equal(initialize.method, "initialize");
  transport.emit("line", JSON.stringify({ id: initialize.id, result: { userAgent: "test", codexHome: "C:/x", platformFamily: "windows", platformOs: "windows" } }));
  await starting;
  assert.equal(JSON.parse(transport.writes[1] ?? "{}").method, "initialized");
});

test("client surfaces real approval request ids and answers only known requests", async () => {
  const transport = new FakeTransport();
  const client = new AppServerClient({ transportFactory: () => transport });
  const starting = client.start();
  await new Promise((resolve) => setImmediate(resolve));
  const initialize = JSON.parse(transport.writes[0] ?? "{}");
  transport.emit("line", JSON.stringify({ id: initialize.id, result: { userAgent: "test", codexHome: "C:/x", platformFamily: "windows", platformOs: "windows" } }));
  await starting;
  const approvalPromise = new Promise<any>((resolve) => client.once("approval", resolve));
  transport.emit("line", JSON.stringify({ id: 77, method: "item/commandExecution/requestApproval", params: { threadId: "thread-1", turnId: "turn-1", itemId: "item-1", command: "git status" } }));
  const approval = await approvalPromise;
  assert.equal(approval.approvalId, "appserver:77");
  assert.throws(() => client.respondApproval("missing", "accept"), /unknown approval/i);
  client.respondApproval(approval.approvalId, "decline");
  const response = JSON.parse(transport.writes.at(-1) ?? "{}");
  assert.deepEqual(response, { id: 77, result: { decision: "decline" } });
});
