// ============================================================================
// GET /.well-known/agent-skill.json — Machine-readable skill definition
// ============================================================================

import type { APIRoute } from "astro";
import { handleSkill } from "../handlers/agent.js";

export const GET: APIRoute = ({ request }) => handleSkill(request);
