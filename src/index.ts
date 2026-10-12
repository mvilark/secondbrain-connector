import { OAuthProvider } from "@cloudflare/workers-oauth-provider";
import type { Env } from "./types.ts";
import { handleMcp } from "./mcp.ts";
import { authHandler } from "./auth.ts";

/**
 * The OAuth library needs the connector's public URL up front, but a one-click deploy only learns it at
 * request time. So the provider is built lazily, once per origin (workers.dev name or custom domain).
 */
const providers = new Map<string, OAuthProvider<Env>>();

function providerFor(origin: string): OAuthProvider<Env> {
  let provider = providers.get(origin);
  if (!provider) {
    provider = new OAuthProvider<Env>({
      apiRoute: "/mcp",
      apiHandler: { fetch: (request: Request, env: Env) => handleMcp(request, env) },
      defaultHandler: authHandler,
      authorizeEndpoint: "/authorize",
      tokenEndpoint: "/token",
      clientRegistrationEndpoint: "/register",
      scopesSupported: ["mcp"],
      accessTokenTTL: 3600,
      resourceMetadata: {
        resource: `${origin}/mcp`,
        authorization_servers: [origin],
        resource_name: "Second Brain vault",
      },
    });
    providers.set(origin, provider);
  }
  return provider;
}

export default {
  fetch(request: Request, env: Env, ctx: ExecutionContext): Promise<Response> | Response {
    return providerFor(new URL(request.url).origin).fetch(request, env, ctx);
  },
} satisfies ExportedHandler<Env>;
