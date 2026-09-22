// ============================================================================
// GET /feed.xml — RSS Feed
// ============================================================================

import type { APIRoute } from "astro";
import { getAgentCMSPosts, getAgentCMSConfig, stripHtml } from "@agentcms/agentcms";

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

export const GET: APIRoute = async ({ request }) => {
  const config = await getAgentCMSConfig();
  const { posts } = await getAgentCMSPosts({ limit: 50 });
  const siteUrl = new URL(request.url).origin;
  const basePath = globalThis.__AGENTCMS_CONFIG__?.basePath || "/blog";

  const siteName = config?.name || "Blog";
  const siteDescription = config?.description || "";

  const items = posts
    .map(
      (post) => `
    <item>
      <title>${escapeXml(post.title)}</title>
      <link>${siteUrl}${basePath}/${encodeURIComponent(post.slug)}</link>
      <guid isPermaLink="true">${siteUrl}${basePath}/${encodeURIComponent(post.slug)}</guid>
      <description>${escapeXml(stripHtml(post.description))}</description>
      <pubDate>${new Date(post.publishedAt).toUTCString()}</pubDate>
      <author>${escapeXml(post.author)}</author>
      ${post.tags.map((t) => `<category>${escapeXml(t)}</category>`).join("\n      ")}
    </item>`
    )
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
      "Cache-Control": "public, max-age=600",
    },
  });
};
