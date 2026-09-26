// ============================================================================
// GET /api/agent/posts — List posts (for agents to check existing content)
// ============================================================================

import type { APIRoute } from "astro";
import { handleAgentListPosts } from "../../handlers/agent.js";
import { agentcmsEnv } from "./_env.js";

export const GET: APIRoute = ({ request }) => handleAgentListPosts(request, agentcmsEnv());
