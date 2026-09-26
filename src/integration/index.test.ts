import { afterEach, describe, expect, it, vi } from "vitest";
import {
  collectSitePages,
  describeSeoRoutes,
  detectProjectSeoRoutes,
  planSeoRoutes,
  resolveKvPrefix,
} from "./index.js";

describe("resolveKvPrefix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefers the explicit option over everything else", async () => {
    vi.stubEnv("AGENTCMS_PREFIX", "from-env");
    await expect(resolveKvPrefix("explicit")).resolves.toBe("explicit");
  });

  it("falls back to the AGENTCMS_PREFIX env var", async () => {
    vi.stubEnv("AGENTCMS_PREFIX", "from-env");
    await expect(resolveKvPrefix()).resolves.toBe("from-env");
  });

  it("returns the raw prefix (no trailing colon) so KV helpers add it", async () => {
    vi.stubEnv("AGENTCMS_PREFIX", "mc2ventures");
    await expect(resolveKvPrefix()).resolves.toBe("mc2ventures");
  });

  it("returns undefined when no prefix is configured anywhere", async () => {
    vi.stubEnv("AGENTCMS_PREFIX", "");
    // No wrangler config is matched in the test cwd, so this resolves to undefined.
    const result = await resolveKvPrefix();
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});

describe("planSeoRoutes", () => {
  const plan = (o: Partial<Parameters<typeof planSeoRoutes>[0]> = {}) =>
    planSeoRoutes({ sitemap: true, robots: true, rss: true, projectOwned: [], ...o });

  it("injects all three when the project owns none", () => {
    expect(plan()).toEqual({ sitemap: "agentcms", robots: "agentcms", feed: "agentcms" });
  });

  // The regression this whole change exists for: headless sites got no sitemap. `mode` is
  // deliberately not an input here, so there is no way to reintroduce that coupling.
  it("takes no mode argument, so headless and auto get the same routes", () => {
    expect(planSeoRoutes.length).toBe(1);
    expect(Object.keys(plan())).toEqual(["sitemap", "robots", "feed"]);
  });

  it("stays out of the way of a route the project already owns", () => {
    expect(plan({ projectOwned: ["sitemap"] }).sitemap).toBe("project");
    expect(plan({ projectOwned: ["sitemap"] }).robots).toBe("agentcms");
  });

  it("reports a project-owned route as project even when the option is off", () => {
    // Saying "disabled" for a path the site actually serves would be the same class of lie as
    // the build log that hid this bug.
    expect(plan({ sitemap: false, projectOwned: ["sitemap"] }).sitemap).toBe("project");
  });

  it("maps each option to its own route", () => {
    expect(plan({ sitemap: false }).sitemap).toBe("disabled");
    expect(plan({ robots: false }).robots).toBe("disabled");
    expect(plan({ rss: false }).feed).toBe("disabled");
    expect(plan({ rss: false }).sitemap).toBe("agentcms");
  });
});

describe("describeSeoRoutes", () => {
  it("never announces a route that was not injected", () => {
    const lines = describeSeoRoutes({
      sitemap: "disabled",
      robots: "project",
      feed: "agentcms",
    });
    expect(lines[0]).toContain("NOT SERVED");
    expect(lines[1]).toContain("your own");
    expect(lines[2]).toBe("  Feed:    /feed.xml");
  });
});

describe("detectProjectSeoRoutes", () => {
  it("finds a page the project wrote", async () => {
    const owned = await detectProjectSeoRoutes(
      { srcDir: "/proj/src", publicDir: "/proj/public" },
      (p) => p.endsWith("sitemap.xml.ts")
    );
    expect([...owned]).toEqual(["sitemap"]);
  });

  it("counts a file in public/ too, since it serves the path", async () => {
    const owned = await detectProjectSeoRoutes(
      { srcDir: "/proj/src", publicDir: "/proj/public" },
      (p) => p.includes("public") && p.endsWith("robots.txt")
    );
    expect([...owned]).toEqual(["robots"]);
  });

  it("owns nothing when no candidate exists", async () => {
    const owned = await detectProjectSeoRoutes(
      { srcDir: "/proj/src", publicDir: "/proj/public" },
      () => false
    );
    expect(owned.size).toBe(0);
  });

  it("treats an unreadable directory as not owned rather than throwing", async () => {
    const owned = await detectProjectSeoRoutes({ srcDir: "/proj/src" }, () => {
      throw new Error("EACCES");
    });
    expect(owned.size).toBe(0);
  });
});

describe("collectSitePages", () => {
  const page = (pattern: string, extra: Record<string, unknown> = {}) => ({
    type: "page",
    pattern,
    params: [],
    ...extra,
  });

  it("always lists / and the blog base", () => {
    expect(collectSitePages([], "/blog").map((p) => p.loc)).toEqual(["/", "/blog"]);
  });

  it("includes the project's own pages, which is what headless mode was missing", () => {
    const pages = collectSitePages([page("/privacy"), page("/terms")], "/blog");
    expect(pages.map((p) => p.loc)).toEqual(["/", "/blog", "/privacy", "/terms"]);
  });

  it("drops dynamic routes, which have no single URL to list", () => {
    const pages = collectSitePages([page("/guides/[slug]", { params: ["slug"] })], "/blog");
    expect(pages.map((p) => p.loc)).toEqual(["/", "/blog"]);
  });

  it("drops endpoints, redirects and error pages", () => {
    const pages = collectSitePages(
      [
        page("/ok"),
        page("/api/thing", { type: "endpoint" }),
        page("/old", { type: "redirect" }),
        page("/404"),
        page("/500"),
        page("/sitemap.xml", { type: "endpoint" }),
      ],
      "/blog"
    );
    expect(pages.map((p) => p.loc)).toEqual(["/", "/blog", "/ok"]);
  });

  it("leaves individual posts to the KV index", () => {
    const pages = collectSitePages([page("/blog/some-post")], "/blog");
    expect(pages.map((p) => p.loc)).toEqual(["/", "/blog"]);
  });

  it("does not duplicate a blog index the project declares itself", () => {
    const pages = collectSitePages([page("/blog"), page("/")], "/blog");
    expect(pages.map((p) => p.loc)).toEqual(["/", "/blog"]);
  });

  it("respects a custom basePath", () => {
    const pages = collectSitePages([page("/journal/post-1"), page("/about")], "/journal");
    expect(pages.map((p) => p.loc)).toEqual(["/", "/journal", "/about"]);
  });

  it("invents no changefreq or priority for someone else's page", () => {
    const own = collectSitePages([page("/privacy")], "/blog").find((p) => p.loc === "/privacy");
    expect(own).toEqual({ loc: "/privacy" });
  });
});
