// ============================================================================
// Handler env for the Astro API routes
// ============================================================================
//
// The Astro routes are thin wrappers over the framework-agnostic handlers in
// src/handlers, so there is one implementation of each endpoint. This builds
// the env those handlers take from the Worker bindings.

import { env } from "cloudflare:workers";
import type { AgentCMSEnv } from "../../handlers/public.js";

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
