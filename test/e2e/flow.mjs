// Walks the same OAuth + MCP flow Claude uses, against a locally running Worker.
import crypto from "node:crypto";
const BASE = "http://127.0.0.1:8787";
const PASS = "correct horse battery";
const b64u = (b) => Buffer.from(b).toString("base64url");
let failures = 0;
const check = (name, cond, extra = "") => { console.log(`${cond ? "PASS" : "FAIL"}  ${name}${cond ? "" : "  " + extra}`); if (!cond) failures++; };

// 1. unauthenticated MCP call -> 401 with resource_metadata
let r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: "initialize" }) });
check("unauthenticated /mcp returns 401", r.status === 401, String(r.status));
const wwwAuth = r.headers.get("www-authenticate") ?? "";
check("401 carries resource_metadata", /resource_metadata=/.test(wwwAuth), wwwAuth);

// 2. discovery documents
r = await fetch(`${BASE}/.well-known/oauth-protected-resource/mcp`);
const prm = await r.json();
check("protected resource metadata names the /mcp resource", prm.resource === `${BASE}/mcp`, JSON.stringify(prm));
r = await fetch(`${BASE}/.well-known/oauth-authorization-server`);
const asm = await r.json();
check("auth server metadata advertises S256 + registration", asm.code_challenge_methods_supported?.includes("S256") && !!asm.registration_endpoint, JSON.stringify(asm));

// 3. dynamic client registration (what Claude does)
const redirect = "https://claude.ai/api/mcp/auth_callback";
r = await fetch(`${BASE}/register`, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ client_name: "Claude", redirect_uris: [redirect], grant_types: ["authorization_code", "refresh_token"], response_types: ["code"], token_endpoint_auth_method: "none" }) });
const client = await r.json();
check("client registered", r.status === 201 && !!client.client_id, JSON.stringify(client));

// 4. authorize page (with PKCE)
const verifier = b64u(crypto.randomBytes(32));
const challenge = b64u(crypto.createHash("sha256").update(verifier).digest());
const authUrl = new URL(`${BASE}/authorize`);
for (const [k, v] of Object.entries({ response_type: "code", client_id: client.client_id, redirect_uri: redirect, code_challenge: challenge, code_challenge_method: "S256", state: "xyz", scope: "mcp", resource: `${BASE}/mcp` })) authUrl.searchParams.set(k, v);
r = await fetch(authUrl);
let html = await r.text();
check("authorize page renders with the passphrase form", r.status === 200 && /name="passphrase"/.test(html), `${r.status} ${html.slice(0, 200)}`);
check("authorize page shows client name and redirect host", /Claude/.test(html) && /claude\.ai/.test(html));
const cookie = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const handle = /name="handle" value="([^"]+)"/.exec(html)?.[1];
const returnTo = /name="return_to" value="([^"]+)"/.exec(html)?.[1]?.replace(/&amp;/g, "&");
check("consent handle and binding cookie issued", !!handle && !!cookie, `handle=${handle} cookie=${cookie}`);

// 5. wrong passphrase
const post = (pass, action = "approve") => fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie }, body: new URLSearchParams({ handle, passphrase: pass, action, return_to: returnTo }) });
r = await post("wrong passphrase!!");
check("wrong passphrase is bounced back with an error flag", r.status === 303 && /sb_error=1/.test(r.headers.get("location") ?? ""), `${r.status} ${r.headers.get("location")}`);
r = await fetch(r.headers.get("location"));
html = await r.text();
check("error is shown on the retry page", /not right/.test(html));
const cookie2 = (r.headers.getSetCookie?.() ?? []).map((c) => c.split(";")[0]).join("; ");
const handle2 = /name="handle" value="([^"]+)"/.exec(html)?.[1];

// 6. right passphrase
r = await fetch(`${BASE}/authorize`, { method: "POST", redirect: "manual", headers: { "content-type": "application/x-www-form-urlencoded", cookie: cookie2 }, body: new URLSearchParams({ handle: handle2, passphrase: PASS, action: "approve", return_to: returnTo }) });
const loc = r.headers.get("location") ?? "";
check("correct passphrase redirects to Claude with a code", r.status === 302 && loc.startsWith(redirect) && /code=/.test(loc) && /state=xyz/.test(loc), `${r.status} ${loc}`);
const code = new URL(loc).searchParams.get("code");

// 7. token exchange
r = await fetch(`${BASE}/token`, { method: "POST", headers: { "content-type": "application/x-www-form-urlencoded" }, body: new URLSearchParams({ grant_type: "authorization_code", code, redirect_uri: redirect, client_id: client.client_id, code_verifier: verifier, resource: `${BASE}/mcp` }) });
const tok = await r.json();
check("token issued", r.status === 200 && !!tok.access_token, JSON.stringify(tok));
const auth = { authorization: `Bearer ${tok.access_token}`, "content-type": "application/json", accept: "application/json, text/event-stream" };

// 8. MCP calls with the token
const rpc = async (id, method, params) => (await (await fetch(`${BASE}/mcp`, { method: "POST", headers: auth, body: JSON.stringify({ jsonrpc: "2.0", id, method, params }) })).json());
let j = await rpc(1, "initialize", { protocolVersion: "2025-06-18", capabilities: {}, clientInfo: { name: "test", version: "1" } });
check("initialize works with bearer token", j.result?.serverInfo?.name === "second-brain-vault", JSON.stringify(j));
j = await rpc(2, "tools/list");
check("5 tools listed", j.result?.tools?.length === 5);
j = await rpc(3, "tools/call", { name: "start_session", arguments: { today: "2026-10-12" } });
const t = j.result?.content?.[0]?.text ?? "";
check("start_session reads the vault through GitHub", /Values\/Values priority\.md/.test(t) && /Started the vault/.test(t), t.slice(0, 300));
j = await rpc(4, "tools/call", { name: "save_changes", arguments: { message: "e2e capture", changes: [{ op: "write", path: "Thoughts/E2E works.md", content: "---\ntype: thought\ncertainty: settled\ntags: [area/mind]\n---\nThe whole chain works, linked to [[Honesty]].\n" }] } });
check("save_changes commits to GitHub", /Saved in one commit/.test(j.result?.content?.[0]?.text ?? ""), JSON.stringify(j));
j = await rpc(5, "tools/call", { name: "backlinks", arguments: { title: "Honesty" } });
check("backlinks sees the new note", /E2E works/.test(j.result?.content?.[0]?.text ?? ""), JSON.stringify(j));
const dbg = await (await fetch("http://127.0.0.1:8799/__debug/files")).json();
check("repo contains the note and the index", dbg.files.includes("Thoughts/E2E works.md") && dbg.files.includes("System/index.json"), JSON.stringify(dbg));

// 9. a bad token is rejected
r = await fetch(`${BASE}/mcp`, { method: "POST", headers: { ...auth, authorization: "Bearer nope" }, body: "{}" });
check("bad token is rejected", r.status === 401, String(r.status));

console.log(failures ? `\n${failures} FAILED` : "\nALL PASSED");
process.exit(failures ? 1 : 0);
