import type { Env } from "./types.ts";
import { GitHub } from "./github.ts";
import { Vault } from "./vault.ts";
import { TOOLS, callTool } from "./tools.ts";

const SERVER_INFO = { name: "second-brain-vault", version: "0.1.0" };
const SUPPORTED_VERSIONS = ["2025-11-25", "2025-06-18", "2025-03-26", "2024-11-05"];
const INSTRUCTIONS =
  "This server is the user's second-brain vault. Call start_session first in every conversation, use search/read_notes/backlinks as needed, and write with one save_changes call per capture.";

interface RpcRequest {
  jsonrpc: "2.0";
  id?: string | number | null;
  method: string;
  params?: Record<string, unknown>;
}

const rpcError = (id: RpcRequest["id"], code: number, message: string) => ({
  jsonrpc: "2.0" as const,
  id: id ?? null,
  error: { code, message },
});

function makeVault(env: Env): Vault {
  return new Vault(new GitHub(env.GITHUB_TOKEN, env.GITHUB_REPO, env.GITHUB_API_URL || undefined), env.GITHUB_BRANCH || undefined);
}

async function handleOne(msg: RpcRequest, env: Env): Promise<unknown | null> {
  const isNotification = msg.id === undefined || msg.id === null;
  switch (msg.method) {
    case "initialize": {
      const asked = typeof msg.params?.protocolVersion === "string" ? msg.params.protocolVersion : "";
      return {
        jsonrpc: "2.0",
        id: msg.id,
        result: {
          protocolVersion: SUPPORTED_VERSIONS.includes(asked) ? asked : SUPPORTED_VERSIONS[1],
          capabilities: { tools: { listChanged: false } },
          serverInfo: SERVER_INFO,
          instructions: INSTRUCTIONS,
        },
      };
    }
    case "ping":
      return { jsonrpc: "2.0", id: msg.id, result: {} };
    case "tools/list":
      return { jsonrpc: "2.0", id: msg.id, result: { tools: TOOLS } };
    case "tools/call": {
      const name = typeof msg.params?.name === "string" ? msg.params.name : "";
      const args = (msg.params?.arguments ?? {}) as Record<string, unknown>;
      const result = await callTool(makeVault(env), name, args);
      return { jsonrpc: "2.0", id: msg.id, result };
    }
    default:
      if (isNotification || msg.method.startsWith("notifications/")) return null;
      // Includes the 2026-07-28 `server/discover` probe: an error tells new clients to fall back to `initialize`.
      return rpcError(msg.id, -32601, `Method not found: ${msg.method}`);
  }
}

export async function handleMcp(request: Request, env: Env): Promise<Response> {
  if (request.method !== "POST") {
    return new Response("This endpoint only accepts POST (MCP over Streamable HTTP).", {
      status: 405,
      headers: { Allow: "POST" },
    });
  }
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return Response.json(rpcError(null, -32700, "Parse error"), { status: 400 });
  }
  const batch = Array.isArray(body);
  const messages = (batch ? body : [body]) as RpcRequest[];
  const replies: unknown[] = [];
  for (const m of messages) {
    if (!m || typeof m !== "object" || typeof m.method !== "string") {
      replies.push(rpcError(null, -32600, "Invalid Request"));
      continue;
    }
    try {
      const r = await handleOne(m, env);
      if (r !== null) replies.push(r);
    } catch (e) {
      replies.push(rpcError(m.id, -32603, e instanceof Error ? e.message : "Internal error"));
    }
  }
  if (!replies.length) return new Response(null, { status: 202 });
  return Response.json(batch ? replies : replies[0]);
}
