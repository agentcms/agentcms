// ============================================================================
// GET /robots.txt — Dynamic Robots.txt
// ============================================================================

import type { APIRoute } from "astro";
import { generateRobotsTxt } from "../utils/sitemap.js";

export const GET: APIRoute = async ({ request }) => {
  const siteUrl = new URL(request.url).origin;
  const additionalSitemaps = globalThis.__AGENTCMS_CONFIG__?.additionalSitemaps;

  const txt = generateRobotsTxt(siteUrl, {
    additionalSitemaps,
  });

  return new Response(txt, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
