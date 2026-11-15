import assert from "node:assert/strict";
import { mkdtemp } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { TaskStore } from "../src/task-store.js";

test("task store persists safe thread mappings", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-store-"));
  const file = path.join(root, "state.json");
  const store = await TaskStore.open(file);
  const task = await store.create({ project: "solicitudpro", codexThreadId: "thread-1", codexTurnId: "turn-1" });
  await store.update(task.id, { status: "completed", finalResult: "safe result" });
  const reopened = await TaskStore.open(file);
  assert.equal(reopened.get(task.id)?.codexThreadId, "thread-1");
  assert.equal(reopened.get(task.id)?.status, "completed");
  assert.equal(reopened.get(task.id)?.finalResult, "safe result");
});

test("task store bounds recent events", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-store-"));
  const store = await TaskStore.open(path.join(root, "state.json"));
  const task = await store.create({ project: "solicitudpro", codexThreadId: "thread-1", codexTurnId: "turn-1" });
  for (let index = 0; index < 80; index += 1) await store.addEvent(task.id, { type: "delta", summary: `event-${index}` });
  assert.equal(store.get(task.id)?.events.length, 50);
  assert.equal(store.get(task.id)?.events[0]?.summary, "event-30");
});

test("concurrent notifications persist without temporary-file races", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-store-"));
  const file = path.join(root, "state.json");
  const store = await TaskStore.open(file);
  const task = await store.create({ project: "solicitudpro", codexThreadId: "thread-1", codexTurnId: "turn-1" });
  await Promise.all(Array.from({ length: 20 }, (_, index) => store.addEvent(task.id, { type: "item", summary: `event-${index}` })));
  assert.equal((await TaskStore.open(file)).get(task.id)?.events.length, 20);
});
