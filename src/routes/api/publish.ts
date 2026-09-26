// ============================================================================
// POST /api/agent/publish — Create a new blog post
// ============================================================================

import type { APIRoute } from "astro";
import { handlePublish } from "../../handlers/agent.js";
import { agentcmsEnv, handlerOptions, purgeAfterWrite } from "./_env.js";

export const POST: APIRoute = async (context) =>
  purgeAfterWrite(
    context,
    await handlePublish(context.request, agentcmsEnv(), handlerOptions())
  );
