// ============================================================================
// AgentCMS — Sitemap & Robots.txt Generation
// ============================================================================
//
// Pure functions — no KV or framework dependencies.
// Takes PostIndexEntry[] (slug + publishedAt) to avoid fetching full content.
//
// ============================================================================

import type { PostIndexEntry, SitemapOptions, RobotsTxtOptions } from "../types.js";

function escapeXml(s: string): string {
  return s
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&apos;");
}

/**
 * Generate a sitemap.xml string from post index entries and optional static pages.
 */
export function generateSitemapXml(
  siteUrl: string,
  posts: PostIndexEntry[],
  options: SitemapOptions = {}
): string {
  const { basePath = "/blog", staticPages = [] } = options;
  const origin = siteUrl.replace(/\/$/, "");

  const staticEntries = staticPages
    .map((page) => {
      const loc = `${origin}${page.loc}`;
      const parts = [`    <loc>${escapeXml(loc)}</loc>`];
      if (page.lastmod) parts.push(`    <lastmod>${escapeXml(page.lastmod)}</lastmod>`);
      if (page.changefreq) parts.push(`    <changefreq>${page.changefreq}</changefreq>`);
      if (page.priority != null) parts.push(`    <priority>${page.priority}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");

  const postEntries = posts
    .filter((p) => p.slug)
    .map((post) => {
      const loc = `${origin}${basePath}/${encodeURIComponent(post.slug)}`;
      const lastmod = post.publishedAt
        ? new Date(post.publishedAt).toISOString().split("T")[0]
        : undefined;
      const parts = [`    <loc>${escapeXml(loc)}</loc>`];
      if (lastmod) parts.push(`    <lastmod>${lastmod}</lastmod>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");

  return `<?xml version="1.0" encoding="UTF-8"?>
<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">
${staticEntries}
${postEntries}
</urlset>`;
}

/**
 * Generate a robots.txt string with Sitemap directives.
 */
export function generateRobotsTxt(
  siteUrl: string,
  options: RobotsTxtOptions = {}
): string {
  const { additionalSitemaps = [], disallow = ["/api/"] } = options;
  const origin = siteUrl.replace(/\/$/, "");

  const lines: string[] = [
    "User-agent: *",
    "Allow: /",
  ];

  for (const path of disallow) {
    lines.push(`Disallow: ${path}`);
  }

  lines.push("");

  // Always include this site's own sitemap
  lines.push(`Sitemap: ${origin}/sitemap.xml`);

  // Additional external sitemaps
  for (const url of additionalSitemaps) {
    lines.push(`Sitemap: ${url}`);
  }

  lines.push("");

  return lines.join("\n");
}
