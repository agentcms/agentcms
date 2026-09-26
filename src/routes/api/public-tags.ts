// ============================================================================
// GET /api/tags — Tags with post counts (public)
// ============================================================================

import type { APIRoute } from "astro";
import { handleListTags } from "../../handlers/public.js";
import { agentcmsEnv } from "./_env.js";

export const GET: APIRoute = ({ request }) => handleListTags(request, agentcmsEnv());
