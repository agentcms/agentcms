// ============================================================================
// /api/agent/posts/[slug] — GET, PUT, DELETE a single post
// ============================================================================

import type { APIRoute } from "astro";
import {
  handleAgentGetPost,
  handleAgentUpdatePost,
  handleAgentDeletePost,
} from "../../handlers/agent.js";
import { agentcmsEnv } from "./_env.js";

// The handlers validate the slug (400 on anything that is not [a-z0-9-]{1,80}).
export const GET: APIRoute = ({ params, request }) =>
  handleAgentGetPost(request, agentcmsEnv(), params.slug ?? "");

export const PUT: APIRoute = ({ params, request }) =>
  handleAgentUpdatePost(request, agentcmsEnv(), params.slug ?? "");

export const DELETE: APIRoute = ({ params, request }) =>
  handleAgentDeletePost(request, agentcmsEnv(), params.slug ?? "");
