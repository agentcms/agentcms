// ============================================================================
// Handler env for the Astro API routes
// ============================================================================
//
// The Astro routes are thin wrappers over the framework-agnostic handlers in
// src/handlers, so there is one implementation of each endpoint. This builds
// the env those handlers take from the Worker bindings.

import type { APIContext } from "astro";
import * as workers from "cloudflare:workers";
import type { HandlerOptions } from "../../handlers/agent.js";
import type { AgentCMSEnv } from "../../handlers/public.js";
import { POSTS_TAG, postTag } from "../../utils/cache-tags.js";

const { env } = workers;

export function agentcmsEnv(): AgentCMSEnv {
  const bindings = env as Record<string, unknown>;
  const config = globalThis.__AGENTCMS_CONFIG__;
  return {
    AGENTCMS_KV: bindings[config?.kvBinding || "AGENTCMS_KV"] as KVNamespace,
    AGENTCMS_R2: bindings[config?.r2Binding || "AGENTCMS_R2"] as R2Bucket | undefined,
    // API endpoints don't get the integration's page-ssr global, so prefer the env var
    // (set via wrangler [vars] AGENTCMS_PREFIX); fall back to the global for the option-only case.
    AGENTCMS_PREFIX: (bindings.AGENTCMS_PREFIX as string | undefined) ?? config?.kvPrefix,
  };
}

// `waitUntil` keeps the Worker alive for work after the response (webhook
// delivery). Read off the namespace, because a named import of an export the
// runtime lacks fails the whole module.
export function handlerOptions(): HandlerOptions {
  const waitUntil = (workers as { waitUntil?: (p: Promise<unknown>) => void }).waitUntil;
  return {
    basePath: globalThis.__AGENTCMS_CONFIG__?.basePath || "/blog",
    ...(waitUntil ? { waitUntil } : {}),
  };
}

export { POSTS_TAG, postTag };

/**
 * After a successful write, purge the pages that show the post from Astro's
 * route cache (Astro 6.4+ with a cache provider; a no-op otherwise). A purge
 * failure never fails the write — the content is saved either way.
 */
export async function purgeAfterWrite(
  context: APIContext,
  response: Response,
  slug?: string
): Promise<Response> {
  const cache = (context as { cache?: APIContext["cache"] }).cache;
  if (!response.ok || !cache?.enabled) return response;
  let target = slug;
  if (!target) {
    try {
      target = ((await response.clone().json()) as { slug?: string }).slug;
    } catch {}
  }
  const tags = [POSTS_TAG, ...(target ? [postTag(target)] : [])];
  try {
    await cache.invalidate({ tags });
  } catch {}
  return response;
}
