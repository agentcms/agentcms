// ============================================================================
// /robots.txt — handler factory
// ============================================================================
//
// A factory for the same reason as the sitemap and the feed: the old route read
// `additionalSitemaps` from `globalThis.__AGENTCMS_CONFIG__`, which `page-ssr` never populates for
// a .ts endpoint -- so the documented `additionalSitemaps` option was silently inert in the very
// route it configures. The integration bakes it in instead, along with whether this site actually
// serves a sitemap: pointing robots at a /sitemap.xml nobody serves is the same class of lie as
// logging a route that was never injected.
//
// ============================================================================

import type { APIRoute } from "astro";
import { generateRobotsTxt } from "../utils/sitemap.js";
import type { RobotsRouteConfig } from "../types.js";

export function createRobotsRoute(config: RobotsRouteConfig = {}): APIRoute {
  return async ({ request }) => {
    const siteUrl = new URL(request.url).origin;

    const txt = generateRobotsTxt(siteUrl, {
      additionalSitemaps: config.additionalSitemaps,
      ...(config.disallow ? { disallow: config.disallow } : {}),
      includeSitemap: config.includeSitemap ?? true,
      ...(config.sitemapPath ? { sitemapPath: config.sitemapPath } : {}),
    });

    return new Response(txt, {
      headers: {
        "Content-Type": "text/plain; charset=utf-8",
        "Cache-Control": "public, max-age=3600",
      },
    });
  };
}
