import { test } from "node:test";
import assert from "node:assert/strict";
import { handleMcp } from "../src/mcp.ts";
import type { Env } from "../src/types.ts";

const env = { GITHUB_TOKEN: "t", GITHUB_REPO: "me/vault" } as unknown as Env;
const post = (body: unknown) =>
  handleMcp(new Request("https://x.test/mcp", { method: "POST", body: JSON.stringify(body), headers: { "Content-Type": "application/json" } }), env);

test("initialize negotiates a known version", async () => {
  const res = await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "2025-06-18" } });
  const j = (await res.json()) as any;
  assert.equal(j.result.protocolVersion, "2025-06-18");
  assert.ok(j.result.capabilities.tools);
  assert.match(j.result.instructions, /start_session/);
});

test("unknown protocol version falls back to a supported one", async () => {
  const j = (await (await post({ jsonrpc: "2.0", id: 1, method: "initialize", params: { protocolVersion: "1999-01-01" } })).json()) as any;
  assert.equal(j.result.protocolVersion, "2025-06-18");
});

test("tools/list exposes the five tools with schemas", async () => {
  const j = (await (await post({ jsonrpc: "2.0", id: 2, method: "tools/list" })).json()) as any;
  assert.deepEqual(j.result.tools.map((t: any) => t.name), ["start_session", "read_notes", "search", "backlinks", "save_changes"]);
  for (const t of j.result.tools) assert.equal(t.inputSchema.type, "object");
});

test("notifications get 202 and no body", async () => {
  const res = await post({ jsonrpc: "2.0", method: "notifications/initialized" });
  assert.equal(res.status, 202);
});

test("server/discover is answered with an error so new clients fall back to initialize", async () => {
  const j = (await (await post({ jsonrpc: "2.0", id: 3, method: "server/discover" })).json()) as any;
  assert.equal(j.error.code, -32601);
});

test("batches work and GET is refused", async () => {
  const j = (await (await post([{ jsonrpc: "2.0", id: 1, method: "ping" }, { jsonrpc: "2.0", id: 2, method: "ping" }])).json()) as any[];
  assert.equal(j.length, 2);
  const res = await handleMcp(new Request("https://x.test/mcp"), env);
  assert.equal(res.status, 405);
});

test("tool errors come back as isError results, not protocol errors", async () => {
  // no GitHub reachable: the call must fail gracefully
  const j = (await (await post({ jsonrpc: "2.0", id: 4, method: "tools/call", params: { name: "search", arguments: {} } })).json()) as any;
  assert.ok(j.result);
  assert.equal(j.result.isError, true);
});
