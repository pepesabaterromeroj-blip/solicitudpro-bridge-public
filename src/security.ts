export type SafeSandbox = "read-only" | "workspace-write";
export type SafeApprovalPolicy = "untrusted" | "on-request";

export interface StartTaskInput {
  project: string;
  prompt: string;
  model?: string;
  reasoning?: string;
  permissions?: string;
  sandbox?: SafeSandbox;
  approvalPolicy?: SafeApprovalPolicy;
}

const SECRET_PATTERNS: Array<[RegExp, string]> = [
  [/\b(Bearer)\s+[A-Za-z0-9._~+\/-]+=*/gi, "$1 [REDACTED]"],
  [/\b(sk-[A-Za-z0-9_-]{6,})\b/g, "[REDACTED]"],
  [/\b((?:OPENAI_)?API_KEY|TOKEN|PASSWORD|SECRET)\s*[:=]\s*[^\s,;]+/gi, "$1=[REDACTED]"],
  [/\b(authorization)\s*:\s*[^\r\n]+/gi, "$1: [REDACTED]"],
];

export function sanitizeForOutput(value: string, maxLength = 20_000): string {
  let result = value;
  for (const [pattern, replacement] of SECRET_PATTERNS) result = result.replace(pattern, replacement);
  return result.slice(0, maxLength);
}

export function sanitizeValue<T>(value: T): T {
  const json = JSON.stringify(value, (key, item) => {
    if (/token|password|secret|authorization|api.?key/i.test(key)) return "[REDACTED]";
    return typeof item === "string" ? sanitizeForOutput(item) : item;
  });
  return JSON.parse(json) as T;
}

export function validateStartTaskInput(input: StartTaskInput): Required<Pick<StartTaskInput, "project" | "prompt">> & StartTaskInput {
  if (!input.project || !/^[a-z0-9][a-z0-9_-]{1,63}$/i.test(input.project)) throw new Error("A valid project id is required");
  const prompt = input.prompt?.trim();
  if (!prompt || prompt.length > 40_000) throw new Error("Prompt must contain between 1 and 40000 characters");
  if (input.sandbox && !["read-only", "workspace-write"].includes(input.sandbox)) throw new Error("Unsupported sandbox");
  if (input.approvalPolicy && !["untrusted", "on-request"].includes(input.approvalPolicy)) throw new Error("Unsupported approval policy");
  if (input.model && !/^[a-zA-Z0-9._-]{1,80}$/.test(input.model)) throw new Error("Invalid model name");
  if (input.reasoning && !["low", "medium", "high", "xhigh", "max", "ultra"].includes(input.reasoning)) throw new Error("Unsupported reasoning effort");
  if (input.permissions && !/^[a-zA-Z0-9._-]{1,80}$/.test(input.permissions)) throw new Error("Invalid permissions profile");
  return { ...input, prompt };
}
