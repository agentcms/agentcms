import { describe, expect, it } from "vitest";
import { generateRobotsTxt, generateSitemapXml } from "./sitemap.js";

const post = (slug: string, extra: Record<string, unknown> = {}) => ({
  slug,
  title: slug,
  publishedAt: "2026-09-01T00:00:00.000Z",
  ...extra,
}) as Parameters<typeof generateSitemapXml>[1][number];

describe("generateSitemapXml", () => {
  it("builds post URLs from basePath, which carries Astro's base", () => {
    // An un-based basePath here lists /blog/<slug> on a site that serves /docs/blog/<slug>, so
    // every post in the sitemap is a 404.
    const xml = generateSitemapXml("https://x.test", [post("hello")], {
      basePath: "/docs/blog",
    });
    expect(xml).toContain("<loc>https://x.test/docs/blog/hello</loc>");
  });

  it("appends a trailing slash to post URLs for a trailingSlash: always site", () => {
    const xml = generateSitemapXml("https://x.test", [post("hello")], {
      basePath: "/blog",
      trailingSlash: true,
    });
    expect(xml).toContain("<loc>https://x.test/blog/hello/</loc>");
  });

  it("leaves noindex posts and slugless entries out", () => {
    const xml = generateSitemapXml("https://x.test", [
      post("keep"),
      post("hide", { noindex: true }),
    ]);
    expect(xml).toContain("/blog/keep");
    expect(xml).not.toContain("/blog/hide");
  });

  it("percent-encodes a static page path", () => {
    // src/pages/über.astro is plausible on the German-language properties, and the sitemap spec
    // requires non-ASCII characters in a loc to be escaped.
    const xml = generateSitemapXml("https://x.test", [], {
      staticPages: [{ loc: "/über" }],
    });
    expect(xml).toContain("<loc>https://x.test/%C3%BCber</loc>");
  });

  it("does not double-encode a path that is already escaped", () => {
    const xml = generateSitemapXml("https://x.test", [], {
      staticPages: [{ loc: "/%C3%BCber" }],
    });
    expect(xml).toContain("<loc>https://x.test/%C3%BCber</loc>");
  });
});

describe("generateRobotsTxt", () => {
  it("advertises this site's sitemap by default", () => {
    expect(generateRobotsTxt("https://x.test")).toContain("Sitemap: https://x.test/sitemap.xml");
  });

  it("omits the Sitemap line when nothing serves one", () => {
    // Pointing robots at a 404 is the same class of lie as logging a route that was never injected.
    const txt = generateRobotsTxt("https://x.test", { includeSitemap: false });
    expect(txt).not.toContain("https://x.test/sitemap.xml");
  });

  it("honours a based sitemap path", () => {
    const txt = generateRobotsTxt("https://x.test", { sitemapPath: "/docs/sitemap.xml" });
    expect(txt).toContain("Sitemap: https://x.test/docs/sitemap.xml");
  });

  it("still lists external sitemaps when this site serves none", () => {
    const txt = generateRobotsTxt("https://x.test", {
      includeSitemap: false,
      additionalSitemaps: ["https://app.x.test/sitemap.xml"],
    });
    expect(txt).toContain("Sitemap: https://app.x.test/sitemap.xml");
  });
});
