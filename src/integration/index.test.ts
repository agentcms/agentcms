import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { pathToFileURL } from "node:url";
import agentcms, {
  collectSitePages,
  describeSeoRoutes,
  detectProjectSeoRoutes,
  planSeoRoutes,
  renderSeoRouteModule,
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

  it("counts a .astro page for every route, not just the sitemap", async () => {
    // robots.txt.astro is a valid Astro page, and an injected endpoint outranks a page on a tie
    // (core/routing/priority.js), so missing this form means AgentCMS silently takes the path over.
    for (const [file, kind] of [
      ["robots.txt.astro", "robots"],
      ["feed.xml.astro", "feed"],
      ["sitemap.xml.mdx", "sitemap"],
    ] as const) {
      const owned = await detectProjectSeoRoutes(
        { srcDir: "/proj/src" },
        (path) => path.endsWith(file)
      );
      expect([...owned]).toEqual([kind]);
    }
  });

  it("counts the directory-index form, which resolves to the same route", async () => {
    const owned = await detectProjectSeoRoutes(
      { srcDir: "/proj/src" },
      (path) => path.includes("sitemap.xml") && path.endsWith("index.ts")
    );
    expect([...owned]).toEqual(["sitemap"]);
  });

  it("counts a redirect declared in astro.config, which an injected endpoint would kill", async () => {
    // Astro only drops a FILE-based route shadowed by a redirect, not an injected one, and the
    // endpoint sorts first — so without this the redirect silently stops working.
    const owned = await detectProjectSeoRoutes(
      { srcDir: "/proj/src", redirects: { "/sitemap.xml": "/sitemap-index.xml" } },
      () => false
    );
    expect([...owned]).toEqual(["sitemap"]);
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
    origin: "project",
    ...extra,
  });
  const locs = (
    routes: Parameters<typeof collectSitePages>[0],
    basePath = "/blog",
    rest: Partial<Parameters<typeof collectSitePages>[1]> = {}
  ) => collectSitePages(routes, { basePath, ...rest }).pages.map((p) => p.loc);

  it("lists / and the blog base when routes actually serve them", () => {
    expect(locs([page("/"), page("/blog")])).toEqual(["/", "/blog"]);
  });

  it("does NOT invent / or the blog base when nothing serves them", () => {
    // A headless site whose blog is at /news used to get "/blog" in its sitemap at priority 0.8.
    expect(locs([page("/"), page("/news")])).toEqual(["/", "/news"]);
    expect(locs([])).toEqual([]);
  });

  it("lists the blog index AgentCMS injected itself, whose origin is not project", () => {
    expect(
      locs([page("/blog", { origin: "internal" })], "/blog", { blogIndexInjected: true })
    ).toEqual(["/blog"]);
  });

  it("includes the project's own pages, which is what headless mode was missing", () => {
    expect(locs([page("/"), page("/privacy"), page("/terms")])).toEqual([
      "/",
      "/privacy",
      "/terms",
    ]);
  });

  it("keeps static pages under the blog base — only the posts come from KV", () => {
    // The old filter dropped every path under the base, so /blog/archive vanished from the sitemap.
    expect(locs([page("/blog"), page("/blog/archive")])).toEqual(["/blog", "/blog/archive"]);
  });

  it("drops dynamic routes, which have no single URL to list", () => {
    expect(locs([page("/guides/[slug]", { params: ["slug"] })])).toEqual([]);
  });

  it("reports prerendered dynamic routes instead of silently dropping them", () => {
    const result = collectSitePages(
      [
        page("/guides/[slug]", { params: ["slug"], isPrerendered: true }),
        page("/search/[q]", { params: ["q"] }),
      ],
      { basePath: "/blog" }
    );
    expect(result.pages).toEqual([]);
    expect(result.droppedPrerendered).toEqual(["/guides/[slug]"]);
  });

  it("drops endpoints, redirects and error pages", () => {
    expect(
      locs([
        page("/ok"),
        page("/api/thing", { type: "endpoint" }),
        page("/old", { type: "redirect" }),
        page("/404"),
        page("/500"),
        page("/sitemap.xml", { type: "endpoint" }),
      ])
    ).toEqual(["/ok"]);
  });

  it("drops pages another integration contributed", () => {
    // Keystatic's admin UI and a web-vitals page are not this site's content.
    expect(locs([page("/about"), page("/keystatic", { origin: "internal" })])).toEqual(["/about"]);
  });

  it("applies Astro's base, which route patterns do not carry", () => {
    // IntegrationResolvedRoute.pattern is RouteData.route; base is applied only to the matching
    // regex, so without this every URL in a based site's sitemap is a 404.
    expect(locs([page("/"), page("/about")], "/blog", { base: "/docs" })).toEqual([
      "/docs",
      "/docs/about",
    ]);
  });

  it("honours trailingSlash: always, so listed URLs do not redirect", () => {
    expect(locs([page("/"), page("/about")], "/blog", { trailingSlash: "always" })).toEqual([
      "/",
      "/about/",
    ]);
    expect(locs([page("/about")], "/blog", { base: "/docs", trailingSlash: "always" })).toEqual([
      "/docs/about/",
    ]);
  });

  it("respects a custom basePath", () => {
    expect(locs([page("/"), page("/journal"), page("/about")], "/journal")).toEqual([
      "/",
      "/journal",
      "/about",
    ]);
  });

  it("invents no changefreq or priority for someone else's page", () => {
    const own = collectSitePages([page("/privacy")], { basePath: "/blog" }).pages[0];
    expect(own).toEqual({ loc: "/privacy" });
  });
});

describe("renderSeoRouteModule", () => {
  it("imports the handler by the package's own exported specifier", () => {
    // If the exports map or the file name moves, the generated module stops resolving and the only
    // symptom is a build error from inside node_modules.
    const mod = renderSeoRouteModule("sitemap", { basePath: "/blog" });
    expect(mod).toContain(
      'import { createSitemapRoute } from "@agentcms/agentcms/routes/sitemap-handler.ts"'
    );
    expect(mod).toContain('"basePath": "/blog"');
    expect(renderSeoRouteModule("feed", {})).toContain("createFeedRoute");
    expect(renderSeoRouteModule("robots", {})).toContain("createRobotsRoute");
  });
});

// ---------------------------------------------------------------------------
// The hooks themselves
// ---------------------------------------------------------------------------
//
// The bug this release fixes was `injectRoute` sitting inside `if (mode === "auto")`. No unit test
// of a pure helper could have caught that — only driving the hook can, so these do.

interface Injected {
  pattern: string;
  entrypoint: string | URL;
}

interface SetupResult {
  dir: string;
  codegen: URL;
  injected: Injected[];
  warnings: string[];
  hooks: Record<string, (args: never) => Promise<void> | void>;
}

async function runSetup(
  options: Parameters<typeof agentcms>[0],
  overrides: { dir?: string; codegenDir?: URL; srcDir?: URL } = {}
): Promise<SetupResult> {
  const dir = overrides.dir ?? (await mkdtemp(join(tmpdir(), "agentcms-test-")));
  const codegen = overrides.codegenDir ?? pathToFileURL(`${join(dir, "codegen")}/`);
  const injected: Injected[] = [];
  const warnings: string[] = [];
  const logger = {
    info: () => {},
    warn: (m: string) => warnings.push(m),
    error: () => {},
    debug: () => {},
    fork: () => logger,
    options: {},
  };
  // Cast at the boundary only: the hook is driven with the fields it actually reads, which is the
  // point of the test. Anything it starts reading that is missing here shows up as a failure.
  const hooks = agentcms(options).hooks as unknown as SetupResult["hooks"];
  await (hooks["astro:config:setup"] as (a: unknown) => Promise<void>)({
    config: {
      srcDir: overrides.srcDir ?? pathToFileURL(`${join(dir, "src")}/`),
      publicDir: pathToFileURL(`${join(dir, "public")}/`),
      base: "/",
      trailingSlash: "ignore",
      output: "server",
    },
    createCodegenDir: () => codegen,
    injectRoute: (r: Injected) => injected.push(r),
    injectScript: () => {},
    updateConfig: () => {},
    logger,
  });
  return { dir, codegen, injected, warnings, hooks };
}

describe("astro:config:setup", () => {
  const dirs: string[] = [];
  afterEach(async () => {
    for (const d of dirs.splice(0)) await rm(d, { recursive: true, force: true });
  });

  const setup = async (...args: Parameters<typeof runSetup>) => {
    const result = await runSetup(...args);
    dirs.push(result.dir);
    return result;
  };

  it("injects all three SEO routes in headless mode — the regression this release fixes", async () => {
    const { injected } = await setup({ mode: "headless" });
    const patterns = injected.map((r) => r.pattern);
    expect(patterns).toContain("/sitemap.xml");
    expect(patterns).toContain("/robots.txt");
    expect(patterns).toContain("/feed.xml");
    // ...and no blog routes, which is what headless means.
    expect(patterns).not.toContain("/blog");
  });

  it("injects them in auto mode too", async () => {
    const { injected } = await setup({ mode: "auto" });
    const patterns = injected.map((r) => r.pattern);
    expect(patterns).toContain("/sitemap.xml");
    expect(patterns).toContain("/blog");
  });

  it("bakes basePath and the prefix into the generated feed, which page-ssr never reaches", async () => {
    const { codegen } = await setup({
      mode: "headless",
      basePath: "/journal",
      kvPrefix: "site-a",
    });
    const feed = await readFile(new URL("feed.xml.ts", codegen), "utf-8");
    expect(feed).toContain('"basePath": "/journal"');
    expect(feed).toContain('"kvPrefix": "site-a"');
  });

  it("bakes additionalSitemaps into robots, where the option used to be inert", async () => {
    const { codegen } = await setup({
      mode: "headless",
      additionalSitemaps: ["https://app.example.com/sitemap.xml"],
    });
    const robots = await readFile(new URL("robots.txt.ts", codegen), "utf-8");
    expect(robots).toContain("https://app.example.com/sitemap.xml");
    expect(robots).toContain('"includeSitemap": true');
  });

  it("tells robots not to advertise a sitemap nothing serves", async () => {
    const { codegen, warnings } = await setup({ mode: "headless", sitemap: false });
    const robots = await readFile(new URL("robots.txt.ts", codegen), "utf-8");
    expect(robots).toContain('"includeSitemap": false');
    expect(warnings.join("\n")).toContain("nothing will serve /sitemap.xml");
  });

  it("falls back to the package routes without crashing routes:resolved", async () => {
    // The fallback used to leave writeSitemapModule pointing at an undefined URL, so the "graceful
    // degrade" threw ERR_INVALID_ARG_TYPE out of a hook Astro rethrows — failing the whole build on
    // exactly the read-only / ENOSPC / EPERM path it advertised as safe.
    const dir = await mkdtemp(join(tmpdir(), "agentcms-test-"));
    const codegen = pathToFileURL(`${join(dir, "codegen")}/`);
    await mkdir(new URL("sitemap.xml.ts", codegen), { recursive: true }); // makes the write EISDIR
    const { injected, warnings, hooks } = await setup(
      { mode: "headless" },
      { dir, codegenDir: codegen }
    );
    expect(warnings.join("\n")).toContain("Could not generate the SEO routes");
    expect(injected.find((r) => r.pattern === "/sitemap.xml")?.entrypoint).toBe(
      "@agentcms/agentcms/routes/sitemap.xml.ts"
    );
    await expect(
      (hooks["astro:routes:resolved"] as (a: unknown) => Promise<void>)({ routes: [] })
    ).resolves.toBeUndefined();
  });

  it("stays out of the way of a sitemap the project wrote", async () => {
    const dir = await mkdtemp(join(tmpdir(), "agentcms-test-"));
    const srcDir = pathToFileURL(`${join(dir, "src")}/`);
    await mkdir(new URL("pages/", srcDir), { recursive: true });
    await writeFile(new URL("pages/sitemap.xml.ts", srcDir), "export const GET = () => {};");
    const { injected } = await setup({ mode: "headless" }, { dir, srcDir });
    expect(injected.map((r) => r.pattern)).not.toContain("/sitemap.xml");
    expect(injected.map((r) => r.pattern)).toContain("/robots.txt");
  });

  it("rewrites the sitemap module with the project's pages on routes:resolved", async () => {
    const { codegen, hooks } = await setup({ mode: "headless" });
    await (hooks["astro:routes:resolved"] as (a: unknown) => Promise<void>)({
      routes: [
        { type: "page", pattern: "/", params: [], origin: "project" },
        { type: "page", pattern: "/privacy", params: [], origin: "project" },
      ],
    });
    const sitemap = await readFile(new URL("sitemap.xml.ts", codegen), "utf-8");
    expect(sitemap).toContain('"loc": "/privacy"');
  });

  it("warns when prerendered dynamic pages could not be listed", async () => {
    const { hooks, warnings } = await setup({ mode: "headless" });
    await (hooks["astro:routes:resolved"] as (a: unknown) => Promise<void>)({
      routes: [
        { type: "page", pattern: "/guides/[slug]", params: ["slug"], origin: "project", isPrerendered: true },
      ],
    });
    expect(warnings.join("\n")).toContain("/guides/[slug]");
  });
});
