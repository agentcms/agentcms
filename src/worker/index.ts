// ============================================================================
// AgentCMS — standalone Cloudflare Worker
// ============================================================================
//
// The whole CMS as a Worker, for a site that is not Astro or not on Pages:
// a static site that pulls posts at build time, a Next.js or Hono app that
// proxies to it, or a separate cms.example.com.
//
//   // src/index.ts
//   export { default } from "@agentcms/agentcms/worker";
//
// or, with options and your own fallback:
//
//   import { createAgentCMSWorker } from "@agentcms/agentcms/worker";
//   export default createAgentCMSWorker({ cors: "https://example.com" });
//
// Bindings: AGENTCMS_KV (required), AGENTCMS_R2 (for uploads), and the
// AGENTCMS_PREFIX var when the namespace is shared.
//
// ============================================================================

import { createAgentCMSRouter, type AgentCMSMiddlewareOptions } from "../cloudflare/index.js";
import type { AgentCMSEnv } from "../handlers/public.js";

export interface AgentCMSWorkerOptions extends AgentCMSMiddlewareOptions {
  /** Handles every request that is not an AgentCMS route (default: 404). */
  fallback?: (
    request: Request,
    env: AgentCMSEnv,
    ctx: ExecutionContext
  ) => Response | Promise<Response>;
}

export function createAgentCMSWorker(
  options: AgentCMSWorkerOptions = {}
): ExportedHandler<AgentCMSEnv> {
  const { fallback, ...routerOptions } = options;
  const route = createAgentCMSRouter(routerOptions);

  return {
    async fetch(request, env, ctx) {
      const req = request as unknown as Request;
      const response = await route(req, env, (p) => ctx.waitUntil(p));
      if (response) return response;
      return fallback ? fallback(req, env, ctx) : new Response("Not found", { status: 404 });
    },
  };
}

export default createAgentCMSWorker();

export type { AgentCMSEnv } from "../handlers/public.js";
export type { AgentCMSMiddlewareOptions } from "../cloudflare/index.js";
