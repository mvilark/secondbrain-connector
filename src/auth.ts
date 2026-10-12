import type { Env } from "./types.ts";

const MAX_FAILURES = 5;
const LOCKOUT_SECONDS = 900;

const esc = (s: string) =>
  s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;").replace(/"/g, "&quot;").replace(/'/g, "&#39;");

const ICON =
  "data:image/svg+xml," +
  encodeURIComponent(
    `<svg xmlns='http://www.w3.org/2000/svg' viewBox='0 0 64 64'><rect width='64' height='64' rx='14' fill='#1f2937'/><g stroke='#93c5fd' stroke-width='3' fill='#bfdbfe'><line x1='20' y1='22' x2='44' y2='20'/><line x1='20' y1='22' x2='30' y2='44'/><line x1='44' y1='20' x2='30' y2='44'/><circle cx='20' cy='22' r='6'/><circle cx='44' cy='20' r='6'/><circle cx='30' cy='44' r='6'/></g></svg>`,
  );

function page(title: string, body: string, status = 200, extra?: Headers): Response {
  const headers = new Headers(extra);
  headers.set("Content-Type", "text/html; charset=utf-8");
  headers.set("Cache-Control", "no-store");
  headers.set("X-Frame-Options", "DENY");
  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(title)}</title><link rel="icon" href="${ICON}">
<style>
:root{color-scheme:light dark}
body{font:16px/1.5 system-ui,sans-serif;max-width:30rem;margin:12vh auto;padding:0 1.25rem}
h1{font-size:1.3rem;margin:0 0 .75rem}
.card{border:1px solid #8885;border-radius:12px;padding:1.25rem}
.meta{color:#888;font-size:.9rem}
.warn{background:#fef3c7;color:#78350f;border-radius:8px;padding:.6rem .8rem;margin:.75rem 0}
.err{background:#fee2e2;color:#7f1d1d;border-radius:8px;padding:.6rem .8rem;margin:.75rem 0}
input[type=password]{width:100%;box-sizing:border-box;font:inherit;padding:.6rem;border-radius:8px;border:1px solid #8888;margin:.5rem 0 1rem}
button{font:inherit;padding:.6rem 1.1rem;border-radius:8px;border:1px solid #8888;background:#2563eb;color:#fff;cursor:pointer}
button.secondary{background:transparent;color:inherit;margin-left:.5rem}
</style></head><body><div class="card">${body}</div></body></html>`;
  return new Response(html, { status, headers });
}

async function sha256(s: string): Promise<Uint8Array> {
  return new Uint8Array(await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s)));
}

async function passphraseMatches(given: string, expected: string): Promise<boolean> {
  const [a, b] = await Promise.all([sha256(given), sha256(expected)]);
  let diff = 0;
  for (let i = 0; i < a.length; i++) diff |= a[i] ^ b[i];
  return diff === 0;
}

function clientIp(request: Request): string {
  return request.headers.get("CF-Connecting-IP") ?? "unknown";
}

async function failures(env: Env, ip: string): Promise<number> {
  return Number((await env.OAUTH_KV.get(`sb-fail:${ip}`)) ?? 0);
}

async function renderAuthorize(request: Request, env: Env, errorMsg?: string): Promise<Response> {
  if (!env.OWNER_PASSPHRASE || env.OWNER_PASSPHRASE.length < 12) {
    return page(
      "Setup needed",
      `<h1>Setup needed</h1><p>The <code>OWNER_PASSPHRASE</code> secret must be set to at least 12 characters in your Cloudflare Worker settings.</p>`,
      500,
    );
  }
  let authReq;
  try {
    authReq = await env.OAUTH_PROVIDER.parseAuthRequest(request);
  } catch (e) {
    return page("Invalid request", `<h1>Invalid request</h1><p>${esc(e instanceof Error ? e.message : "Bad authorization request.")}</p>`, 400);
  }
  const desc = await env.OAUTH_PROVIDER.describeConsent(authReq);
  const tx = await env.OAUTH_PROVIDER.beginConsent(authReq);
  const returnTo = new URL(request.url);
  returnTo.searchParams.delete("sb_error");
  const body = `<h1>Connect to your vault?</h1>
<p><strong>${esc(desc.clientName)}</strong> wants to read and write your second-brain vault.</p>
<p class="meta">It will be sent back to <strong>${esc(desc.redirectHost)}</strong>.</p>
${desc.redirectIsLoopback ? `<div class="warn">This returns to an app on your own device. Only continue if you started this connection yourself.</div>` : ""}
${errorMsg ? `<div class="err">${esc(errorMsg)}</div>` : ""}
<form method="post" action="/authorize">
<input type="hidden" name="handle" value="${esc(tx.handle)}">
<input type="hidden" name="return_to" value="${esc(returnTo.toString())}">
<label for="p">Your vault passphrase</label>
<input id="p" type="password" name="passphrase" autocomplete="current-password" required autofocus>
<button type="submit" name="action" value="approve">Allow</button>
<button type="submit" name="action" value="deny" class="secondary" formnovalidate>Deny</button>
</form>`;
  return page("Connect your vault", body, 200, tx.headers);
}

function safeReturn(raw: string, request: Request): string | null {
  try {
    const u = new URL(raw);
    const self = new URL(request.url);
    if (u.origin !== self.origin || u.pathname !== "/authorize") return null;
    return u.toString();
  } catch {
    return null;
  }
}

async function submitAuthorize(request: Request, env: Env): Promise<Response> {
  const form = await request.formData();
  const handle = String(form.get("handle") ?? "");
  const action = String(form.get("action") ?? "");
  const pass = String(form.get("passphrase") ?? "");
  const returnTo = safeReturn(String(form.get("return_to") ?? ""), request);
  if (!handle) return page("Invalid request", `<h1>Invalid request</h1><p>Start the connection again from Claude.</p>`, 400);

  if (action === "deny") {
    const denied = await env.OAUTH_PROVIDER.denyConsent(request, handle);
    const h = new Headers(denied.headers);
    h.set("Location", denied.redirectTo);
    return new Response(null, { status: 302, headers: h });
  }

  const ip = clientIp(request);
  const failed = await failures(env, ip);
  if (failed >= MAX_FAILURES) {
    return page("Too many attempts", `<h1>Too many attempts</h1><p>Wait about 15 minutes and try again.</p>`, 429);
  }
  if (!env.OWNER_PASSPHRASE || env.OWNER_PASSPHRASE.length < 12 || !(await passphraseMatches(pass, env.OWNER_PASSPHRASE))) {
    await env.OAUTH_KV.put(`sb-fail:${ip}`, String(failed + 1), { expirationTtl: LOCKOUT_SECONDS });
    if (returnTo) {
      const u = new URL(returnTo);
      u.searchParams.set("sb_error", "1");
      return new Response(null, { status: 303, headers: { Location: u.toString() } });
    }
    return page("Wrong passphrase", `<h1>Wrong passphrase</h1><p>Go back to Claude and start the connection again.</p>`, 403);
  }
  if (failed) await env.OAUTH_KV.delete(`sb-fail:${ip}`);

  const approved = await env.OAUTH_PROVIDER.approveConsent(request, handle);
  const { redirectTo } = await env.OAUTH_PROVIDER.completeAuthorization({
    request: approved.request,
    userId: "vault-owner",
    metadata: { label: "Vault owner" },
    scope: approved.request.scope,
    props: { owner: true },
  });
  const h = new Headers(approved.headers);
  h.set("Location", redirectTo);
  return new Response(null, { status: 302, headers: h });
}

export const authHandler: ExportedHandler<Env> = {
  async fetch(request, env) {
    const url = new URL(request.url);
    try {
      if (url.pathname === "/authorize") {
        if (request.method === "GET") {
          return await renderAuthorize(request, env, url.searchParams.has("sb_error") ? "That passphrase was not right." : undefined);
        }
        if (request.method === "POST") return await submitAuthorize(request, env);
        return new Response("Method not allowed", { status: 405 });
      }
      if (url.pathname === "/" || url.pathname === "/index.html") {
        return page(
          "Second Brain connector",
          `<h1>Second Brain connector</h1><p>This is running. Add <code>${esc(url.origin)}/mcp</code> as a custom connector in Claude.</p>`,
        );
      }
      return new Response("Not found", { status: 404 });
    } catch (e) {
      console.error("auth handler error", e instanceof Error ? e.message : e);
      return page("Something went wrong", `<h1>Something went wrong</h1><p>Start the connection again from Claude.</p>`, 500);
    }
  },
};
