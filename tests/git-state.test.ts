import assert from "node:assert/strict";
import test from "node:test";
import { parsePorcelainV1 } from "../src/git-state.js";

test("porcelain parser separates staged, unstaged and untracked", () => {
  const parsed = parsePorcelainV1("M  staged.ts\n M unstaged.ts\nMM both.ts\n?? new.txt\n");
  assert.deepEqual(parsed.staged, ["staged.ts", "both.ts"]);
  assert.deepEqual(parsed.unstaged, ["unstaged.ts", "both.ts"]);
  assert.deepEqual(parsed.untracked, ["new.txt"]);
  assert.equal(parsed.clean, false);
});

test("empty porcelain output is clean", () => {
  assert.equal(parsePorcelainV1("").clean, true);
});
