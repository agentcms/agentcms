// ============================================================================
// /sitemap.xml — handler factory
// ============================================================================
//
// The endpoint is a factory rather than a route so the integration can generate a tiny real file
// that calls it with the site's own pages baked in (see createSitemapRoute's caller in
// src/integration/index.ts). Two reasons it is done that way:
//
//  1. `globalThis.__AGENTCMS_CONFIG__` is injected via `page-ssr`, which never runs for a .ts
//     endpoint, so the old route read basePath from it and silently got "/blog" whatever the site
//     had configured.
//  2. An SSR endpoint cannot enumerate the project's routes at request time. Without them, a
//     sitemap on a headless site would list `/`, the blog base and the posts and call that
//     complete -- and an incomplete sitemap is a worse failure than a missing one, because
//     nothing reports it.
//
// ============================================================================

import type { APIRoute } from "astro";
import { getIndex } from "../utils/kv.js";
import { generateSitemapXml } from "../utils/sitemap.js";
import type { SitemapRouteConfig } from "../types.js";

export function createSitemapRoute(config: SitemapRouteConfig): APIRoute {
  return async ({ request }) => {
    const { env } = await import("cloudflare:workers");
    const bindingName = config.kvBinding || "AGENTCMS_KV";
    const kv = (env as Record<string, unknown>)[bindingName] as KVNamespace;
    // The env binding, not the page-ssr global: on a shared namespace the wrong prefix serves
    // another site's posts. This is the 0.8.1-0.8.3 prefix regression.
    const prefix =
      ((env as Record<string, unknown>).AGENTCMS_PREFIX as string | undefined) ??
      config.kvPrefix;
    const basePath = config.basePath || "/blog";
    const siteUrl = new URL(request.url).origin;

    // `?? default`, not `?.length ? … : default`: an empty array is the integration saying it
    // looked at the project's routes and found none to list. Inventing "/" and the blog base there
    // is how a headless site whose blog lives at /news ended up advertising /blog.
    const staticPages =
      config.staticPages ??
      [
        { loc: "/", changefreq: "weekly" as const, priority: 1.0 },
        { loc: basePath, changefreq: "daily" as const, priority: 0.8 },
      ];

    // A KV outage must not 500. A sitemap that errors teaches Search Console the sitemap is
    // broken and it stops asking; the static tree still gets crawled either way.
    let posts: Awaited<ReturnType<typeof getIndex>>["posts"] = [];
    let degraded = false;
    try {
      posts = (await getIndex(kv, prefix)).posts;
    } catch (err) {
      degraded = true;
      // Said out loud: a permanently wrong kvBinding otherwise yields a permanently post-less 200
      // with no signal anywhere, which is the silent downgrade this release exists to remove.
      console.error("[agentcms] /sitemap.xml could not read KV:", err);
    }

    return new Response(
      generateSitemapXml(siteUrl, posts, {
        basePath,
        staticPages,
        trailingSlash: config.trailingSlash,
      }),
      {
        headers: {
          "Content-Type": "application/xml; charset=utf-8",
          // Shorter while degraded, so a blip is not cached as the sitemap for an hour.
          "Cache-Control": degraded ? "public, max-age=60" : "public, max-age=3600",
        },
      }
    );
  };
}
