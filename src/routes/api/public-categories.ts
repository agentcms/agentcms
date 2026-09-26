// ============================================================================
// GET /api/categories — Categories with post counts (public)
// ============================================================================

import type { APIRoute } from "astro";
import { handleListCategories } from "../../handlers/public.js";
import { agentcmsEnv } from "./_env.js";

export const GET: APIRoute = ({ request }) => handleListCategories(request, agentcmsEnv());
