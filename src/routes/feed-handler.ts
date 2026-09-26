// ============================================================================
// /feed.xml — handler factory
// ============================================================================
//
// A factory for the same reason as the sitemap: `globalThis.__AGENTCMS_CONFIG__` comes from
// `injectScript("page-ssr", …)`, which never runs for a .ts endpoint. The old route read basePath
// from it and so emitted `/blog/<slug>` permalinks whatever the site had configured, and it reached
// KV through getAgentCMSPosts, whose prefix fallback is that same global — meaning a site that sets
// `kvPrefix` as an integration option rather than an AGENTCMS_PREFIX binding read the un-prefixed
// shared keys and served ANOTHER site's posts. That is the 0.8.1-0.8.3 prefix regression, and it
// mattered more once /feed.xml started being served in headless mode too.
//
// So the integration bakes basePath, kvBinding and kvPrefix in, and this talks to KV directly with
// an explicit prefix rather than through the helpers that guess.
//
// ============================================================================

import type { APIRoute } from "astro";
import { getConfig } from "../utils/kv.js";
import { queryPosts } from "../utils/query.js";
import { stripHtml } from "../utils/sanitize.js";
import type { FeedRouteConfig } from "../types.js";

// Titles and descriptions are agent-written. They used to sit in CDATA, which
// is not an escape: a title containing "]]>" closes the section and injects
// arbitrary XML into the feed. Escaping is.
function escapeXml(s: string): string {
  return String(s ?? "")
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

export function createFeedRoute(config: FeedRouteConfig = {}): APIRoute {
  return async ({ request }) => {
    const { env } = await import("cloudflare:workers");
    const kv = (env as Record<string, unknown>)[
      config.kvBinding || "AGENTCMS_KV"
    ] as KVNamespace;
    // Env binding first, matching getKvPrefix(); the baked-in value is the fallback, and unlike the
    // page-ssr global it actually reaches this endpoint.
    const prefix =
      ((env as Record<string, unknown>).AGENTCMS_PREFIX as string | undefined) ?? config.kvPrefix;
    const basePath = config.basePath || "/blog";
    const siteUrl = new URL(request.url).origin;

    // A KV outage returns an empty feed rather than a 500: a reader that gets a 500 may drop the
    // subscription, and an empty channel is a transient no-news.
    let posts: Awaited<ReturnType<typeof queryPosts>>["posts"] = [];
    let siteConfig: Awaited<ReturnType<typeof getConfig>> = null;
    let degraded = false;
    try {
      [{ posts }, siteConfig] = await Promise.all([
        queryPosts(kv, { limit: 50 }, prefix),
        getConfig(kv, prefix),
      ]);
    } catch (err) {
      degraded = true;
      // Said out loud: a silently post-less feed is indistinguishable from a site with no posts.
      console.error("[agentcms] /feed.xml could not read KV:", err);
    }

    const siteName = siteConfig?.name || config.site?.name || "Blog";
    const siteDescription = siteConfig?.description || config.site?.description || "";

    const items = posts
      .map((post) => {
        const url = `${siteUrl}${basePath}/${encodeURIComponent(post.slug)}${
          config.trailingSlash ? "/" : ""
        }`;
        return `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${url}</link>
      <guid isPermaLink="true">${url}</guid>
      <description>${escapeXml(stripHtml(post.description))}</description>
      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>
      <author>${escapeXml(post.author)}</author>
      ${(post.tags ?? []).map((t) => `<category>${escapeXml(t)}</category>`).join("\n      ")}
    </item>`;
      })
      .join("\n");

    const xml = `<?xml version="1.0" encoding="UTF-8"?>
<rss version="2.0" xmlns:atom="http://www.w3.org/2005/Atom">
  <channel>
    <title>${escapeXml(siteName)}</title>
    <description>${escapeXml(siteDescription)}</description>
    <link>${siteUrl}${basePath}</link>
    <atom:link href="${siteUrl}/feed.xml" rel="self" type="application/rss+xml" />
    <lastBuildDate>${new Date().toUTCString()}</lastBuildDate>
    <generator>AgentCMS</generator>
    ${items}
  </channel>
</rss>`;

    return new Response(xml, {
      headers: {
        "Content-Type": "application/rss+xml; charset=utf-8",
        "Cache-Control": degraded ? "public, max-age=60" : "public, max-age=600",
      },
    });
  };
}
