// ============================================================================
// GET /images/[...path] — Serve images from R2
// ============================================================================

import type { APIRoute } from "astro";
import { handleImage } from "../handlers/public.js";
import { agentcmsEnv } from "./api/_env.js";

export const GET: APIRoute = ({ params, request }) =>
  handleImage(request, agentcmsEnv(), params.path ?? "");
