// ============================================================================
// GET /sitemap.xml — Dynamic Sitemap
// ============================================================================

import type { APIRoute } from "astro";
import { getIndex } from "../utils/kv.js";
import { generateSitemapXml } from "../utils/sitemap.js";

export const GET: APIRoute = async ({ request }) => {
  const { env } = await import("cloudflare:workers");
  const bindingName = globalThis.__AGENTCMS_CONFIG__?.kvBinding || "AGENTCMS_KV";
  const kv = (env as Record<string, unknown>)[bindingName] as KVNamespace;
  const prefix = globalThis.__AGENTCMS_CONFIG__?.kvPrefix;
  const basePath = globalThis.__AGENTCMS_CONFIG__?.basePath || "/blog";
  const siteUrl = new URL(request.url).origin;

  const index = await getIndex(kv, prefix);

  const xml = generateSitemapXml(siteUrl, index.posts, {
    basePath,
    staticPages: [
      { loc: "/", changefreq: "weekly", priority: 1.0 },
      { loc: basePath, changefreq: "daily", priority: 0.8 },
    ],
  });

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
