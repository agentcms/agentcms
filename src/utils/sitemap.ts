// ============================================================================
// AgentCMS — Sitemap & Robots.txt Generation
// ============================================================================
//
// Pure functions — no KV or framework dependencies.
// Takes PostIndexEntry[] (slug + publishedAt) to avoid fetching full content.
//
// ============================================================================

import type { PostIndexEntry, SitemapOptions, RobotsTxtOptions } from "../types.js";

/**
 * A `loc` must be a valid URL before it is XML-escaped: the sitemap spec requires non-ASCII and
 * reserved characters to be percent-encoded, and a page file like `src/pages/über.astro` (entirely
 * plausible on the German-language properties) otherwise emits a raw non-ASCII loc. encodeURI, not
 * encodeURIComponent: this is a path, so the slashes must survive.
 */
function encodePath(path: string): string {
  // A path that already carries a percent-escape is left alone: encoding it again would turn
  // /%C3%BCber into /%25C3%25BCber.
  if (/%[0-9A-Fa-f]{2}/.test(path)) return path;
  try {
    return encodeURI(path);
  } catch {
    // A lone surrogate makes encodeURI throw. An unencoded loc beats no sitemap.
    return path;
  }
}

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
  const { basePath = "/blog", staticPages = [], trailingSlash = false } = options;
  const origin = siteUrl.replace(/\/$/, "");
  const slash = trailingSlash ? "/" : "";

  const staticEntries = staticPages
    .map((page) => {
      const loc = `${origin}${encodePath(page.loc)}`;
      const parts = [`    <loc>${escapeXml(loc)}</loc>`];
      if (page.lastmod) parts.push(`    <lastmod>${escapeXml(page.lastmod)}</lastmod>`);
      if (page.changefreq) parts.push(`    <changefreq>${page.changefreq}</changefreq>`);
      if (page.priority != null) parts.push(`    <priority>${page.priority}</priority>`);
      return `  <url>\n${parts.join("\n")}\n  </url>`;
    })
    .join("\n");

  const postEntries = posts
    .filter((p) => p.slug && !p.noindex)
    .map((post) => {
      const loc = `${origin}${basePath}/${encodeURIComponent(post.slug)}${slash}`;
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
  const {
    additionalSitemaps = [],
    disallow = ["/api/"],
    // Pointing robots at a sitemap nobody serves is the same class of lie as logging a route that
    // was never injected, so the caller says whether this site actually has one.
    includeSitemap = true,
    sitemapPath = "/sitemap.xml",
  } = options;
  const origin = siteUrl.replace(/\/$/, "");

  const lines: string[] = [
    "User-agent: *",
    "Allow: /",
  ];

  for (const path of disallow) {
    lines.push(`Disallow: ${path}`);
  }

  lines.push("");

  if (includeSitemap) lines.push(`Sitemap: ${origin}${sitemapPath}`);

  // Additional external sitemaps
  for (const url of additionalSitemaps) {
    lines.push(`Sitemap: ${url}`);
  }

  lines.push("");

  return lines.join("\n");
}
