import assert from "node:assert/strict";
import { mkdtemp, mkdir, realpath, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import path from "node:path";
import test from "node:test";
import { ProjectRegistry } from "../src/project-registry.js";

test("registry resolves only configured project ids", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-registry-"));
  const repo = path.join(root, "repo");
  await mkdir(repo);
  const config = path.join(root, "local.json");
  await writeFile(config, JSON.stringify({ projects: { solicitudpro: { path: repo } } }));
  const registry = await ProjectRegistry.load(config);
  assert.equal(registry.resolve("solicitudpro").path, await realpath(repo));
  assert.throws(() => registry.resolve("unknown"), /not authorized/i);
  assert.throws(() => registry.resolve("..\\repo"), /not authorized/i);
});

test("registry rejects a missing configured path", async () => {
  const root = await mkdtemp(path.join(tmpdir(), "bridge-registry-"));
  const config = path.join(root, "local.json");
  await writeFile(config, JSON.stringify({ projects: { solicitudpro: { path: path.join(root, "missing") } } }));
  await assert.rejects(ProjectRegistry.load(config), /does not exist/i);
});
