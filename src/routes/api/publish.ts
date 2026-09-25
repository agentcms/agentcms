// ============================================================================
// POST /api/agent/publish — Create a new blog post
// ============================================================================

import type { APIRoute } from "astro";
import { handlePublish } from "../../handlers/agent.js";
import { agentcmsEnv } from "./_env.js";

export const POST: APIRoute = ({ request }) =>
  handlePublish(request, agentcmsEnv(), {
    basePath: globalThis.__AGENTCMS_CONFIG__?.basePath || "/blog",
  });
