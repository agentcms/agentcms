// ============================================================================
// GET /api/agent/context — Site context for agents to understand before writing
// ============================================================================

import type { APIRoute } from "astro";
import { handleAgentContext } from "../../handlers/agent.js";
import { agentcmsEnv } from "./_env.js";

// KV config takes precedence; the inline `site` from agentcms.config.ts is the fallback.
export const GET: APIRoute = ({ request }) =>
  handleAgentContext(request, agentcmsEnv(), {
    site: globalThis.__AGENTCMS_CONFIG__?.site,
  });
