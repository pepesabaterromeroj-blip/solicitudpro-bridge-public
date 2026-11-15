import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { StdioServerTransport } from "@modelcontextprotocol/sdk/server/stdio.js";
import { z } from "zod";
import { BridgeService } from "./bridge-service.js";
import { sanitizeForOutput } from "./security.js";

const readAnnotations = { readOnlyHint: true, destructiveHint: false, idempotentHint: true, openWorldHint: false } as const;
// Delegated execution may write, delete or contact external systems depending on
// its prompt and Codex policy. Annotations are hints, never authorization.
const actionAnnotations = { readOnlyHint: false, destructiveHint: true, idempotentHint: false, openWorldHint: true } as const;

function result(value: unknown) {
  const safe = JSON.parse(sanitizeForOutput(JSON.stringify(value)));
  return { content: [{ type: "text" as const, text: JSON.stringify(safe, null, 2) }], structuredContent: safe };
}

function errorResult(error: unknown) {
  const message = sanitizeForOutput(error instanceof Error ? error.message : String(error), 2_000);
  return { isError: true, content: [{ type: "text" as const, text: message }] };
}

export function createMcpServer(service: BridgeService): McpServer {
  const server = new McpServer({ name: "solicitudpro-bridge", version: "1.0.0" }, { capabilities: { logging: {} } });
  const wrap = <T>(handler: () => Promise<T> | T) => async () => { try { return result(await handler()); } catch (error) { return errorResult(error); } };

  server.registerTool("bridge_status", {
    title: "Bridge status",
    description: "Read the local bridge, Codex app-server, tunnel, and authorized project status. Never returns credentials.",
    annotations: readAnnotations,
  }, wrap(() => service.status()));

  server.registerTool("project_state", {
    title: "Authorized project Git state",
    description: "Read Git branch, HEAD, changes, worktrees, remotes, and remote refs for one allowlisted project.",
    inputSchema: z.object({ project: z.string().min(2).max(64) }),
    annotations: readAnnotations,
  }, async ({ project }) => { try { return result(await service.projectState(project)); } catch (error) { return errorResult(error); } });

  server.registerTool("codex_threads", {
    title: "Known Codex threads",
    description: "List safe bridge task/thread mappings and statuses.",
    annotations: readAnnotations,
  }, wrap(() => service.threads()));

  server.registerTool("codex_task_status", {
    title: "Codex task status",
    description: "Read one task's turn status, recent safe events, pending approval, and final result.",
    inputSchema: z.object({ task_id: z.string().uuid() }),
    annotations: readAnnotations,
  }, async ({ task_id }) => { try { return result(service.taskStatus(task_id)); } catch (error) { return errorResult(error); } });

  server.registerTool("codex_start_task", {
    title: "Start Codex task",
    description: "Start a non-blocking Codex app-server task inside one allowlisted project. Defaults to read-only and on-request approvals.",
    inputSchema: z.object({
      project: z.string().min(2).max(64),
      prompt: z.string().min(1).max(40_000),
      model: z.string().max(80).optional(),
      reasoning: z.enum(["low", "medium", "high", "xhigh", "max", "ultra"]).optional(),
      permissions: z.string().max(80).optional(),
      sandbox: z.enum(["read-only", "workspace-write"]).optional(),
      approval_policy: z.enum(["untrusted", "on-request"]).optional(),
    }),
    annotations: actionAnnotations,
  }, async (input) => { try { return result(await service.startTask({ ...input, approvalPolicy: input.approval_policy })); } catch (error) { return errorResult(error); } });

  server.registerTool("codex_continue_task", {
    title: "Continue Codex thread",
    description: "Resume the same durable Codex thread and start a new turn without creating a new conversation.",
    inputSchema: z.object({ task_id: z.string().uuid().optional(), thread_id: z.string().min(1).optional(), message: z.string().min(1).max(40_000) }).refine((value) => value.task_id || value.thread_id, "task_id or thread_id is required"),
    annotations: actionAnnotations,
  }, async ({ task_id, thread_id, message }) => { try { return result(await service.continueTask({ taskId: task_id, threadId: thread_id, message })); } catch (error) { return errorResult(error); } });

  server.registerTool("codex_interrupt_task", {
    title: "Interrupt Codex task",
    description: "Interrupt only the active turn mapped to the supplied bridge task.",
    inputSchema: z.object({ task_id: z.string().uuid() }),
    annotations: actionAnnotations,
  }, async ({ task_id }) => { try { return result(await service.interruptTask(task_id)); } catch (error) { return errorResult(error); } });

  server.registerTool("codex_respond_approval", {
    title: "Respond to Codex approval",
    description: "Respond to a real pending app-server approval that belongs to the specified task. Invented or stale IDs are rejected.",
    inputSchema: z.object({ task_id: z.string().uuid(), approval_id: z.string().min(1), decision: z.enum(["accept", "acceptForSession", "decline", "cancel"]) }),
    annotations: actionAnnotations,
  }, async ({ task_id, approval_id, decision }) => { try { return result(await service.respondApproval(task_id, approval_id, decision)); } catch (error) { return errorResult(error); } });

  server.registerTool("solicitudpro_context", {
    title: "SolicitudPro compact context",
    description: "Reconstruct compact, evidence-labelled SolicitudPro context from local Git and contemporary project documents. Read-only.",
    annotations: readAnnotations,
  }, wrap(() => service.solicitudproContext()));

  return server;
}

export { createSmokeMcpServer } from './smoke-mcp-server.js';

export async function runStdioServer(service: BridgeService): Promise<void> {
  const server = createMcpServer(service);
  const transport = new StdioServerTransport();
  await server.connect(transport);
}
