// ============================================================================
// GET /api/posts/[slug] — One published post, sanitized (public)
// ============================================================================

import type { APIRoute } from "astro";
import { handleGetPost } from "../../handlers/public.js";
import { agentcmsEnv } from "./_env.js";

export const GET: APIRoute = ({ params, request }) =>
  handleGetPost(request, agentcmsEnv(), params.slug ?? "");
