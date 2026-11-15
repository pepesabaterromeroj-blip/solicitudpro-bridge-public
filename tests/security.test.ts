import assert from "node:assert/strict";
import test from "node:test";
import { sanitizeForOutput, validateStartTaskInput } from "../src/security.js";

test("sanitizer redacts common secret shapes", () => {
  const result = sanitizeForOutput("Authorization: Bearer abc.def.ghi OPENAI_API_KEY=sk-example password=hunter2");
  assert.doesNotMatch(result, /abc\.def|sk-example|hunter2/);
  assert.match(result, /REDACTED/);
});

test("start task validation rejects empty and oversized prompts", () => {
  assert.throws(() => validateStartTaskInput({ project: "solicitudpro", prompt: "  " }), /prompt/i);
  assert.throws(() => validateStartTaskInput({ project: "solicitudpro", prompt: "x".repeat(40_001) }), /prompt/i);
});

test("start task validation allows only supported permission controls", () => {
  assert.throws(
    () => validateStartTaskInput({ project: "solicitudpro", prompt: "inspect", sandbox: "danger-full-access" } as any),
    /sandbox/i,
  );
  assert.equal(validateStartTaskInput({ project: "solicitudpro", prompt: "inspect", sandbox: "read-only" }).sandbox, "read-only");
});
