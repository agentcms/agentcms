// ============================================================================
// GET /api/posts — Published posts, paginated and filterable (public)
// ============================================================================

import type { APIRoute } from "astro";
import { handleListPosts } from "../../handlers/public.js";
import { agentcmsEnv } from "./_env.js";

export const GET: APIRoute = ({ request }) => handleListPosts(request, agentcmsEnv());
