// ============================================================================
// AgentCMS — Astro Integration
// ============================================================================
//
// Usage:
//   import agentcms from "@agentcms/agentcms";
//   export default defineConfig({
//     integrations: [agentcms({ mode: "auto" })],
//   });
//
// ============================================================================

import type { AstroIntegration } from "astro";
import type { AgentCMSOptions } from "../types.js";

/**
 * Resolve the KV key prefix used to isolate this site's data when several sites
 * share one KV namespace. Resolution order:
 *   1. explicit `kvPrefix` integration option
 *   2. `AGENTCMS_PREFIX` environment variable (e.g. CI)
 *   3. `AGENTCMS_PREFIX` declared in the project's wrangler config
 *      (wrangler.toml / wrangler.jsonc / wrangler.json)
 *
 * Returns the RAW prefix (no trailing colon) — the KV helpers append the colon.
 * This is what makes the headless data helpers (getAgentCMSPosts, etc.) read
 * `<prefix>:posts:*` instead of the shared, un-prefixed `posts:*` keys.
 */
export async function resolveKvPrefix(
  explicit?: string
): Promise<string | undefined> {
  if (explicit) return explicit;
  if (process.env.AGENTCMS_PREFIX) return process.env.AGENTCMS_PREFIX;
  try {
    const { readFileSync } = await import("node:fs");
    for (const file of ["wrangler.toml", "wrangler.jsonc", "wrangler.json"]) {
      try {
        const text = readFileSync(file, "utf-8");
        // Matches TOML  AGENTCMS_PREFIX = "x"  and JSON  "AGENTCMS_PREFIX": "x"
        const match = text.match(/AGENTCMS_PREFIX"?\s*[:=]\s*"([^"]+)"/);
        if (match) return match[1];
      } catch {
        // file not present — try the next candidate
      }
    }
  } catch {
    // node:fs unavailable (non-Node builder) — no auto-detection
  }
  return undefined;
}

// ---------------------------------------------------------------------------
// SEO routes: /sitemap.xml, /robots.txt, /feed.xml
// ---------------------------------------------------------------------------
//
// These used to be injected only in `auto` mode, while the build log announced them in every
// mode. A headless site therefore shipped no sitemap and the one place anybody would look said
// it had one. Three sites ran that way for months: www.raisolo.com and www.como.travel both
// 404ed on /sitemap.xml and /feed.xml, and www.agentcms.dev only worked because it hand-wrote
// its own copies.
//
// So mode no longer decides this. What decides it is whether the PROJECT already answers the
// path — a page under src/pages or a file in public/ — because that is the one case where
// injecting would collide with something the site author wrote on purpose.

export type SeoRouteKind = "sitemap" | "robots" | "feed";

/** Where a given SEO route comes from once the integration has decided. */
export type SeoRouteSource =
  /** AgentCMS injected its own endpoint. */
  | "agentcms"
  /** The project answers this path itself; AgentCMS stayed out of the way. */
  | "project"
  /** Switched off by an integration option. Nothing serves it. */
  | "disabled";

interface SeoRouteSpec {
  pattern: string;
  /** Fallback entrypoint, used only when the generated module cannot be written. */
  entrypoint: string;
  /** Module + factory the generated route calls, with this site's config baked in. */
  handlerModule: string;
  factory: string;
  /** File name for the generated module inside Astro's codegen dir. */
  fileName: string;
  /** Bare route names under src/pages that would make the project own this path. */
  pageNames: string[];
  /** Files in public/ that would make the project own this path. */
  assets: string[];
}

/**
 * Page file forms that make a project own a route. All of them matter, because a probe MISS is not
 * a harmless duplicate: Astro sorts an `endpoint` ahead of a `page` when everything else ties
 * (core/routing/priority.js) and the router returns the first match, so an injected endpoint would
 * WIN and the site's own file would quietly stop serving.
 *
 * `<name>/index.<ext>` is the directory-index form, which resolves to the same route.
 */
const PAGE_EXTENSIONS = ["ts", "js", "mjs", "astro", "md", "mdx"];

function pageCandidates(routeName: string): string[] {
  const out: string[] = [];
  for (const ext of PAGE_EXTENSIONS) {
    out.push(`${routeName}.${ext}`);
    out.push(`${routeName}/index.${ext}`);
  }
  return out;
}

const SEO_ROUTES: Record<SeoRouteKind, SeoRouteSpec> = {
  sitemap: {
    pattern: "/sitemap.xml",
    entrypoint: "@agentcms/agentcms/routes/sitemap.xml.ts",
    handlerModule: "@agentcms/agentcms/routes/sitemap-handler.ts",
    factory: "createSitemapRoute",
    fileName: "sitemap.xml.ts",
    pageNames: ["sitemap.xml"],
    assets: ["sitemap.xml"],
  },
  robots: {
    pattern: "/robots.txt",
    entrypoint: "@agentcms/agentcms/routes/robots.txt.ts",
    handlerModule: "@agentcms/agentcms/routes/robots-handler.ts",
    factory: "createRobotsRoute",
    fileName: "robots.txt.ts",
    pageNames: ["robots.txt"],
    assets: ["robots.txt"],
  },
  feed: {
    pattern: "/feed.xml",
    entrypoint: "@agentcms/agentcms/routes/feed.xml.ts",
    handlerModule: "@agentcms/agentcms/routes/feed-handler.ts",
    factory: "createFeedRoute",
    fileName: "feed.xml.ts",
    pageNames: ["feed.xml"],
    assets: ["feed.xml"],
  },
};

/**
 * Which SEO paths the project already answers for itself.
 *
 * Deliberately a filesystem probe rather than a look at Astro's resolved routes: `injectRoute`
 * happens in `astro:config:setup`, long before routes are resolved, so by the time Astro could
 * tell us it is too late to decide. `existsSync` is injectable for tests.
 *
 * `redirects` counts too: `redirects: { "/sitemap.xml": "/sitemap-index.xml" }` is the standard
 * pairing with @astrojs/sitemap, and Astro only drops a *file-based* route shadowed by a redirect,
 * not an injected one — so without this the injected endpoint would win and silently kill the
 * redirect.
 *
 * What it cannot see: a Cloudflare zone redirect, a bulk redirect, or a hand-written `functions/`
 * handler. Those live outside the repo, so the log line states our intent, not a verified fetch.
 */
export type PublicApiRoute = "posts" | "tags" | "categories";

/**
 * Which of the public read routes (/api/posts, /api/tags, /api/categories) the project
 * serves itself. Conservative: any page file or directory under `src/pages/api/<name>`
 * counts, whatever its param is called, because an injected `/api/posts/[slug]` beside
 * the project's `/api/posts/[id].ts` would make Astro pick one of the two.
 */
export async function detectProjectApiRoutes(
  srcDir: URL | string | undefined,
  existsSync?: (path: string) => boolean
): Promise<Set<PublicApiRoute>> {
  const owned = new Set<PublicApiRoute>();
  if (!srcDir) return owned;
  try {
    const path = await import("node:path");
    const url = await import("node:url");
    const exists = existsSync ?? (await import("node:fs")).existsSync;
    const apiDir = path.join(typeof srcDir === "string" ? srcDir : url.fileURLToPath(srcDir), "pages", "api");
    for (const name of ["posts", "tags", "categories"] as const) {
      const candidates = [path.join(apiDir, name), ...pageCandidates(name).map((f) => path.join(apiDir, f))];
      if (candidates.some((c) => exists(c))) owned.add(name);
    }
  } catch {
    // No node:fs: inject, and let Astro report a collision rather than serve nothing.
  }
  return owned;
}

export async function detectProjectSeoRoutes(
  dirs: {
    srcDir?: URL | string;
    publicDir?: URL | string;
    redirects?: Record<string, unknown>;
  },
  existsSync?: (path: string) => boolean
): Promise<Set<SeoRouteKind>> {
  const owned = new Set<SeoRouteKind>();

  for (const [kind, spec] of Object.entries(SEO_ROUTES) as [SeoRouteKind, SeoRouteSpec][]) {
    if (dirs.redirects && Object.hasOwn(dirs.redirects, spec.pattern)) owned.add(kind);
  }

  let exists = existsSync;
  let join: ((...parts: string[]) => string) | undefined;
  let toPath: ((u: URL | string) => string) | undefined;
  try {
    const path = await import("node:path");
    const url = await import("node:url");
    join = path.join;
    toPath = (u) => (typeof u === "string" ? u : url.fileURLToPath(u));
    if (!exists) exists = (await import("node:fs")).existsSync;
  } catch {
    // node:fs / node:path unavailable (non-Node builder). We cannot tell what the project owns,
    // so report nothing owned: injecting and letting Astro report a collision is a louder
    // failure than silently serving no sitemap, which is the bug this whole section fixes.
    return owned;
  }
  if (!exists || !join || !toPath) return owned;

  const pagesDir = dirs.srcDir ? join(toPath(dirs.srcDir), "pages") : undefined;
  const publicPath = dirs.publicDir ? toPath(dirs.publicDir) : undefined;

  for (const [kind, spec] of Object.entries(SEO_ROUTES) as [SeoRouteKind, SeoRouteSpec][]) {
    const candidates = [
      ...(pagesDir
        ? spec.pageNames.flatMap((n) => pageCandidates(n).map((f) => join(pagesDir, f)))
        : []),
      ...(publicPath ? spec.assets.map((f) => join(publicPath, f)) : []),
    ];
    try {
      if (candidates.some((c) => exists!(c))) owned.add(kind);
    } catch {
      // An unreadable directory is not evidence that the project owns the route.
    }
  }

  return owned;
}

/**
 * Decides where each SEO route comes from. Pure, so the decision can be tested without a build.
 *
 * Note what is NOT a parameter: `mode`. That is the fix — a headless site needs a sitemap exactly
 * as much as an auto one, and the only reason to skip injection is that the project already
 * answers the path.
 */
export function planSeoRoutes(opts: {
  sitemap: boolean;
  robots: boolean;
  rss: boolean;
  projectOwned: Iterable<SeoRouteKind>;
}): Record<SeoRouteKind, SeoRouteSource> {
  const owned = new Set(opts.projectOwned);
  const enabled: Record<SeoRouteKind, boolean> = {
    sitemap: opts.sitemap,
    robots: opts.robots,
    feed: opts.rss,
  };

  const plan = {} as Record<SeoRouteKind, SeoRouteSource>;
  for (const kind of Object.keys(SEO_ROUTES) as SeoRouteKind[]) {
    // The project's own file wins even when the option is off: reporting "disabled" for a path
    // the site actually serves would be the same kind of lie this section exists to remove.
    if (owned.has(kind)) plan[kind] = "project";
    else if (!enabled[kind]) plan[kind] = "disabled";
    else plan[kind] = "agentcms";
  }
  return plan;
}

/** One line per SEO route, saying what actually happened. Never announces a route that was not injected. */
export function describeSeoRoutes(
  plan: Record<SeoRouteKind, SeoRouteSource>
): string[] {
  const label: Record<SeoRouteKind, string> = {
    sitemap: "Sitemap: /sitemap.xml",
    robots: "Robots:  /robots.txt",
    feed: "Feed:    /feed.xml",
  };
  return (Object.keys(SEO_ROUTES) as SeoRouteKind[]).map((kind) => {
    switch (plan[kind]) {
      case "agentcms":
        return `  ${label[kind]}`;
      case "project":
        return `  ${label[kind]} (your own — AgentCMS did not inject one)`;
      case "disabled":
        return `  ${label[kind]} NOT SERVED (disabled by option)`;
    }
  });
}

// ---------------------------------------------------------------------------
// The pages the injected sitemap should list besides the CMS posts
// ---------------------------------------------------------------------------

/** A route as Astro reports it in `astro:routes:resolved`, narrowed to what we need. */
export interface ResolvedRouteLike {
  type?: string;
  pattern?: string;
  params?: readonly string[];
  /** 'project' | 'internal' | 'external' — who contributed the route. */
  origin?: string;
  isPrerendered?: boolean;
}

export interface StaticPageEntry {
  loc: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

export interface CollectSitePagesOptions {
  /** The blog base path (the AgentCMS `basePath` option), e.g. "/blog". */
  basePath: string;
  /**
   * Astro's `base`. It has to be applied here because `IntegrationResolvedRoute.pattern` is
   * `RouteData.route`, which is built from the path segments alone — base is only ever applied to
   * the matching regex. Without this, every URL in the sitemap of a based site is a 404.
   */
  base?: string;
  /** Astro's `trailingSlash`. With "always" a URL without one redirects, so the sitemap needs it. */
  trailingSlash?: "always" | "never" | "ignore";
  /**
   * True when AgentCMS injected the blog index itself (auto mode). Its route's origin is
   * "internal", not "project", so it has to be admitted by name.
   */
  blogIndexInjected?: boolean;
}

export interface SitePages {
  pages: StaticPageEntry[];
  /**
   * Prerendered dynamic routes that were dropped. `astro:routes:resolved` gives the pattern
   * (`/guides/[slug]`), never the generated paths, so these cannot be listed — but they are the
   * whole content of some sites, so the caller says so out loud instead of shipping a sitemap that
   * looks complete.
   */
  droppedPrerendered: string[];
}

/** Canonical form for comparison: leading slash, no trailing slash, no base, no locale games. */
function canonicalLoc(pattern: string): string | undefined {
  if (!pattern.startsWith("/")) return undefined;
  return pattern.length > 1 ? pattern.replace(/\/$/, "") : "/";
}

/** The URL a crawler should actually fetch: base applied, trailing slash as the site serves it. */
function publicLoc(
  loc: string,
  base: string | undefined,
  trailingSlash: "always" | "never" | "ignore" | undefined
): string {
  const b = (base ?? "").replace(/\/+$/, "");
  const withBase = loc === "/" ? b || "/" : `${b}${loc}`;
  if (trailingSlash !== "always") return withBase;
  return withBase.endsWith("/") ? withBase : `${withBase}/`;
}

/**
 * The project's own indexable pages, for the injected sitemap.
 *
 * Without this, an injected sitemap in headless mode would list `/`, the blog base and the posts
 * and nothing else — so a site whose own pages are the point (raisolo's /privacy and /terms,
 * como.travel's guides) would get a sitemap that looks complete and is not. An incomplete
 * sitemap is a worse failure than a missing one, because nothing reports it.
 *
 * What is deliberately left out:
 *  - Dynamic routes. A route with params has no single URL, and guessing one is how a sitemap ends
 *    up full of 404s. CMS posts are added by the endpoint from the KV index instead; prerendered
 *    dynamic pages are reported in `droppedPrerendered` so the build can say they are missing.
 *  - Routes another integration contributed (`origin !== "project"`). Keystatic's admin UI and a
 *    web-vitals endpoint are not this site's content. AgentCMS's own blog index is the one
 *    exception, admitted by name via `blogIndexInjected`.
 *  - `/` and the blog base when nothing actually serves them. The previous version added both
 *    unconditionally, so a headless site whose blog lives at /news still advertised /blog.
 */
export function collectSitePages(
  routes: readonly ResolvedRouteLike[],
  opts: CollectSitePagesOptions
): SitePages {
  const base = (opts.basePath || "/blog").replace(/\/$/, "") || "/blog";
  const skip = new Set(["/404", "/500", "/sitemap.xml", "/robots.txt", "/feed.xml"]);
  /** Patterns AgentCMS injected that ARE this site's content, despite origin "internal". */
  const ownContent = new Set<string>(opts.blogIndexInjected ? [base] : []);

  const locs = new Set<string>();
  const droppedPrerendered: string[] = [];

  for (const route of routes ?? []) {
    if (route.type !== "page") continue; // endpoints, redirects and fallbacks are not content
    const loc = route.pattern ? canonicalLoc(route.pattern) : undefined;
    if (!loc) continue;
    if (route.params?.length) {
      // Reported, never guessed at. Only prerendered ones are a real gap: an on-demand dynamic
      // route has no fixed set of URLs at build time even in principle.
      if (route.isPrerendered) droppedPrerendered.push(route.pattern!);
      continue;
    }
    if (skip.has(loc)) continue;
    if (route.origin && route.origin !== "project" && !ownContent.has(loc)) continue;
    locs.add(loc);
  }

  // `/` and the blog index get a changefreq and a priority because we do know something about
  // them. Every other page gets neither: a number we made up for someone else's page is worse
  // than an absent one.
  const hints: Record<string, Omit<StaticPageEntry, "loc">> = {
    "/": { changefreq: "weekly", priority: 1.0 },
    [base]: { changefreq: "daily", priority: 0.8 },
  };

  const ordered: string[] = [];
  for (const head of ["/", base]) if (locs.has(head)) ordered.push(head);
  for (const loc of [...locs].sort()) if (!ordered.includes(loc)) ordered.push(loc);

  const pages = ordered.map((loc) => ({
    loc: publicLoc(loc, opts.base, opts.trailingSlash),
    ...(hints[loc] ?? {}),
  }));

  return { pages, droppedPrerendered };
}

// ---------------------------------------------------------------------------
// Generated SEO routes
// ---------------------------------------------------------------------------
//
// All three routes need something an SSR endpoint cannot get for itself: the project's own pages, and
// the configured basePath (`globalThis.__AGENTCMS_CONFIG__` comes from `page-ssr`, which never runs
// for a .ts endpoint — the footgun documented below). So the integration generates a real module
// in Astro's codegen dir that calls the handler factory with both baked in.
//
// Deliberately NOT a Vite virtual module: Vite pre-bundles with esbuild, that pass does not go
// through a plugin's resolveId, and the injected endpoint lives inside node_modules — so a virtual
// id fails with 'Could not resolve "virtual:agentcms/site-pages"' as soon as the route is really
// injected, and neither optimizeDeps.exclude nor an esbuild resolver plugin reliably fixes it. A
// file on disk resolves like any other source file.

/**
 * The generated module, written to Astro's codegen dir and used as the route's entrypoint.
 *
 * The specifier is the package's own `./routes/*` export, which resolves because AgentCMS is
 * detected as a framework package (it declares `peerDependencies.astro` and the `astro` keyword),
 * so the raw .ts lands in ssr.noExternal rather than being externalized.
 */
export function renderSeoRouteModule(
  kind: SeoRouteKind,
  config: Record<string, unknown>
): string {
  const { handlerModule, factory } = SEO_ROUTES[kind];
  return `// Generated by @agentcms/agentcms. Do not edit.
import { ${factory} } from "${handlerModule}";

export const GET = ${factory}(${JSON.stringify(config, null, 2)});
`;
}

export default function agentcms(
  options: AgentCMSOptions = {}
): AstroIntegration {
  const {
    mode = "auto",
    basePath = "/blog",
    postsPerPage = 12,
    rss = true,
    sitemap = true,
    robots = true,
    additionalSitemaps,
    skillEndpoint = true,
    publicApi = true,
    theme = "default",
    kvBinding = "AGENTCMS_KV",
    r2Binding = "AGENTCMS_R2",
    kvPrefix: kvPrefixOption,
    site,
  } = options;

  // Normalize basePath (no trailing slash)
  const base = basePath.replace(/\/$/, "");

  // Decided in astro:config:setup, reported in astro:build:done. Held here so the build summary
  // states what was injected rather than what the options asked for.
  let seoPlan: Record<SeoRouteKind, SeoRouteSource> = {
    sitemap: "disabled",
    robots: "disabled",
    feed: "disabled",
  };
  // The sitemap module is written twice: once in astro:config:setup so the entrypoint exists when
  // Astro resolves routes, then again in astro:routes:resolved once the project's own pages are
  // known. If that second hook never runs, the first version still serves -- with the blog only,
  // which is what this route could do before.
  //
  // `writeSitemapModule` is cleared alongside `sitemapModuleUrl` whenever generation fails, because
  // a closure that survives its target is how the "graceful fallback" path came to throw
  // ERR_INVALID_ARG_TYPE out of astro:routes:resolved -- and Astro rethrows hook errors, so the
  // supposed degrade failed the whole build.
  let sitemapModuleUrl: URL | undefined;
  let writeSitemapModule: ((pages: SitePages) => Promise<void>) | undefined;
  /** `base` and `trailingSlash`, read in config:setup — see the note at their assignment. */
  let astroConfig: { base?: string; trailingSlash?: "always" | "never" | "ignore" } | undefined;

  return {
    name: "agentcms",
    hooks: {
      "astro:config:setup": async ({
        config,
        createCodegenDir,
        injectRoute,
        injectScript,
        updateConfig,
        logger,
      }) => {
        logger.info(`AgentCMS initializing in "${mode}" mode`);

        // Resolve the KV prefix that isolates this site's data in a shared namespace.
        const kvPrefix = await resolveKvPrefix(kvPrefixOption);

        // ---------------------------------------------------------------
        // Always inject: Agent write API
        // ---------------------------------------------------------------
        injectRoute({
          pattern: "/api/agent/publish",
          entrypoint: "@agentcms/agentcms/routes/api/publish.ts",
        });
        injectRoute({
          pattern: "/api/agent/posts",
          entrypoint: "@agentcms/agentcms/routes/api/list.ts",
        });
        injectRoute({
          pattern: "/api/agent/posts/[slug]",
          entrypoint: "@agentcms/agentcms/routes/api/post.ts",
        });
        injectRoute({
          pattern: "/api/agent/context",
          entrypoint: "@agentcms/agentcms/routes/api/context.ts",
        });
        injectRoute({
          pattern: "/api/agent/upload",
          entrypoint: "@agentcms/agentcms/routes/api/upload.ts",
        });

        // ---------------------------------------------------------------
        // Public read API — the JSON a static frontend, an app or another
        // site's live loader reads. Skipped per path the project owns.
        // ---------------------------------------------------------------
        if (publicApi) {
          const owned = await detectProjectApiRoutes(config.srcDir);
          const injected: string[] = [];
          if (!owned.has("posts")) {
            injectRoute({
              pattern: "/api/posts",
              entrypoint: "@agentcms/agentcms/routes/api/public-posts.ts",
            });
            injectRoute({
              pattern: "/api/posts/[slug]",
              entrypoint: "@agentcms/agentcms/routes/api/public-post.ts",
            });
            injected.push("/api/posts", "/api/posts/[slug]");
          }
          if (!owned.has("tags")) {
            injectRoute({
              pattern: "/api/tags",
              entrypoint: "@agentcms/agentcms/routes/api/public-tags.ts",
            });
            injected.push("/api/tags");
          }
          if (!owned.has("categories")) {
            injectRoute({
              pattern: "/api/categories",
              entrypoint: "@agentcms/agentcms/routes/api/public-categories.ts",
            });
            injected.push("/api/categories");
          }
          if (injected.length) logger.info(`Public API: ${injected.join(", ")}`);
          if (owned.size) {
            logger.info(`Public API: the project serves /api/${[...owned].join(", /api/")} itself`);
          }
        }

        // ---------------------------------------------------------------
        // Always inject: Image serving from R2
        // ---------------------------------------------------------------
        injectRoute({
          pattern: "/images/[...path]",
          entrypoint: "@agentcms/agentcms/routes/images.ts",
        });

        // ---------------------------------------------------------------
        // Always inject: Skill discovery endpoint
        // ---------------------------------------------------------------
        if (skillEndpoint) {
          injectRoute({
            pattern: "/.well-known/agent-skill.json",
            entrypoint: "@agentcms/agentcms/routes/skill.ts",
          });
        }

        // ---------------------------------------------------------------
        // Auto mode: inject blog pages
        // ---------------------------------------------------------------
        if (mode === "auto") {
          injectRoute({
            pattern: base || "/blog",
            entrypoint: "@agentcms/agentcms/routes/blog/index.astro",
          });
          injectRoute({
            pattern: `${base || "/blog"}/[slug]`,
            entrypoint: "@agentcms/agentcms/routes/blog/[slug].astro",
          });
          injectRoute({
            pattern: `${base || "/blog"}/tag/[tag]`,
            entrypoint: "@agentcms/agentcms/routes/blog/tag/[tag].astro",
          });

          logger.info(
            `Auto routes: ${base}/, ${base}/[slug], ${base}/tag/[tag]`
          );
        }

        // ---------------------------------------------------------------
        // Both modes: /sitemap.xml, /robots.txt, /feed.xml
        // ---------------------------------------------------------------
        // Outside the `mode === "auto"` block on purpose — see SEO_ROUTES above.
        seoPlan = planSeoRoutes({
          sitemap,
          robots,
          rss,
          projectOwned: await detectProjectSeoRoutes({
            srcDir: config.srcDir,
            publicDir: config.publicDir,
            redirects: config.redirects as Record<string, unknown> | undefined,
          }),
        });

        // Astro's `base`, which none of these routes can discover at request time either. It has
        // to reach the sitemap's own URL in robots.txt as well: a based site serves the sitemap at
        // <base>/sitemap.xml, so an un-based Sitemap: line points at a 404.
        // Captured here, not in astro:config:done: that hook runs AFTER astro:routes:resolved
        // (core/build/index.js calls createRoutesList before createVite), so by then the sitemap
        // module has already been written.
        astroConfig = { base: config.base, trailingSlash: config.trailingSlash };
        const astroBase = (config.base ?? "").replace(/\/+$/, "");

        // All three routes are generated rather than injected from the package, so basePath,
        // kvPrefix and additionalSitemaps are baked in — `page-ssr` never runs for a .ts endpoint,
        // and reading them from that global is what made the feed emit /blog permalinks on every
        // site and made the documented additionalSitemaps option silently inert.
        const routeConfig = (kind: SeoRouteKind): Record<string, unknown> => {
          switch (kind) {
            case "sitemap":
              // The post URLs are built from this, so it carries Astro's base: an un-based
              // basePath lists /blog/<slug> on a site that serves /docs/blog/<slug>.
              return {
                basePath: `${astroBase}${base || "/blog"}`,
                trailingSlash: config.trailingSlash === "always",
                staticPages: [],
                kvBinding,
                ...(kvPrefix ? { kvPrefix } : {}),
              };
            case "feed":
              return {
                basePath: `${astroBase}${base || "/blog"}`,
                trailingSlash: config.trailingSlash === "always",
                kvBinding,
                ...(kvPrefix ? { kvPrefix } : {}),
                ...(site ? { site } : {}),
              };
            case "robots":
              return {
                ...(additionalSitemaps ? { additionalSitemaps } : {}),
                // Never point robots at a sitemap nobody serves. "project" counts: the site's own
                // file answers /sitemap.xml just as well as ours would.
                includeSitemap: seoPlan.sitemap !== "disabled",
                sitemapPath: `${astroBase}/sitemap.xml`,
              };
          }
        };

        // A generated module per route, in Astro's codegen dir (outside srcDir, so writing it
        // cannot loop the dev watcher).
        const generated: Partial<Record<SeoRouteKind, URL>> = {};
        let writeModule:
          | ((kind: SeoRouteKind, cfg: Record<string, unknown>) => Promise<void>)
          | undefined;
        try {
          const { writeFile, mkdir, rename } = await import("node:fs/promises");
          const dir = createCodegenDir();
          await mkdir(dir, { recursive: true });
          writeModule = async (kind, cfg) => {
            const target = new URL(SEO_ROUTES[kind].fileName, dir);
            // Temp file then rename, because Astro's route watcher does not serialize rebuilds:
            // two `writeFile`s to the same path during one dev burst can leave it truncated, and
            // writeFile opens with O_TRUNC. A rename is atomic on the same filesystem.
            const temp = new URL(`${SEO_ROUTES[kind].fileName}.${process.pid}.tmp`, dir);
            await writeFile(temp, renderSeoRouteModule(kind, cfg), "utf-8");
            await rename(temp, target);
          };
          for (const kind of Object.keys(SEO_ROUTES) as SeoRouteKind[]) {
            if (seoPlan[kind] !== "agentcms") continue;
            await writeModule(kind, routeConfig(kind));
            generated[kind] = new URL(SEO_ROUTES[kind].fileName, dir);
          }
          sitemapModuleUrl = generated.sitemap;
          if (sitemapModuleUrl) {
            writeSitemapModule = async ({ pages, droppedPrerendered }) => {
              await writeModule!("sitemap", {
                ...routeConfig("sitemap"),
                staticPages: pages,
              });
              if (droppedPrerendered.length) {
                // The sitemap cannot list these, and nothing else would report it. Said out loud
                // because an incomplete sitemap is a worse failure than a missing one.
                logger.warn(
                  `Sitemap: ${droppedPrerendered.length} prerendered dynamic route(s) are not listed ` +
                    `(${droppedPrerendered.join(", ")}). Astro reports the pattern, not the generated URLs, ` +
                    "so add src/pages/sitemap.xml.ts if those pages need to be in it."
                );
              }
            };
          }
        } catch (err) {
          // Could not generate them (no writable codegen dir, non-Node builder). Fall back to the
          // package routes — less configured, but served — and say so, because a silent downgrade
          // here is the exact failure this release exists to remove.
          //
          // Both handles are cleared: leaving writeSitemapModule alive after sitemapModuleUrl went
          // undefined made astro:routes:resolved throw ERR_INVALID_ARG_TYPE, and Astro rethrows
          // hook errors, so the "fallback" failed the build outright.
          sitemapModuleUrl = undefined;
          writeSitemapModule = undefined;
          writeModule = undefined;
          logger.warn(
            `Could not generate the SEO routes (${err instanceof Error ? err.message : String(err)}). ` +
              "Falling back to the built-in ones: the sitemap will list the blog only, the feed will use " +
              "basePath /blog, and additionalSitemaps will be ignored. " +
              "Add your own src/pages/sitemap.xml.ts to take it over."
          );
        }

        for (const kind of Object.keys(SEO_ROUTES) as SeoRouteKind[]) {
          if (seoPlan[kind] !== "agentcms") continue;
          injectRoute({
            pattern: SEO_ROUTES[kind].pattern,
            entrypoint: generated[kind] ?? SEO_ROUTES[kind].entrypoint,
          });
        }
        if (seoPlan.sitemap === "disabled") {
          logger.warn(
            "sitemap: false and no src/pages/sitemap.xml — nothing will serve /sitemap.xml. " +
              "A site with no fetchable sitemap is a site search engines have to guess at."
          );
        }

        // ---------------------------------------------------------------
        // Inject theme CSS
        // ---------------------------------------------------------------
        if (theme === "default") {
          injectScript("page", `import "@agentcms/agentcms/theme/default.css";`);
        }

        // ---------------------------------------------------------------
        // Inject virtual module with config (available to routes/components)
        // ---------------------------------------------------------------
        // ⚠️ IMPORTANT — `page-ssr` runs ONLY for .astro PAGES, NOT for `.ts` API
        // endpoints (src/routes/api/*, sitemap.xml.ts, feed.xml.ts, etc.). So
        // `globalThis.__AGENTCMS_CONFIG__` (and therefore `.kvPrefix`) is UNDEFINED inside
        // endpoint handlers. Do NOT read the KV prefix from this global in an endpoint —
        // it silently falls back to the shared, un-prefixed keys and serves another site's
        // data on a shared KV namespace. In endpoints, read the prefix from the
        // `AGENTCMS_PREFIX` env binding instead (see src/routes/api/* and the getKvPrefix
        // helper in src/index.ts). This footgun caused the 0.8.1–0.8.3 prefix regressions.
        // TODO: expose config via Astro's virtual module API so endpoints can import it too.
        injectScript(
          "page-ssr",
          `globalThis.__AGENTCMS_CONFIG__ = ${JSON.stringify({
            mode,
            basePath: base || "/blog",
            postsPerPage,
            kvBinding,
            r2Binding,
            ...(kvPrefix ? { kvPrefix } : {}),
            ...(additionalSitemaps ? { additionalSitemaps } : {}),
            ...(site ? { site } : {}),
          })};`
        );

        if (kvPrefix) logger.info(`AgentCMS KV prefix: "${kvPrefix}"`);
        logger.info("AgentCMS ready ✓");
      },

      // Runs after config:setup and before the Vite build (core/build/index.js: createRoutesList
      // then createVite), so the generated module has the real pages in it before Vite reads it.
      "astro:routes:resolved": async ({ routes }) => {
        await writeSitemapModule?.(
          collectSitePages(routes as readonly ResolvedRouteLike[], {
            basePath: base || "/blog",
            base: astroConfig?.base,
            trailingSlash: astroConfig?.trailingSlash,
            blogIndexInjected: mode === "auto",
          })
        );
      },

      "astro:config:done": ({ config, logger }) => {
        // Warn if not using server output (needed for KV reads)
        if (config.output !== "server") {
          logger.warn(
            'AgentCMS requires output: "server" for live KV reads. ' +
              "Add `output: 'server'` to your astro.config.mjs"
          );
        }
      },

      // Every line here must describe a route that exists. The previous version printed
      // "Sitemap: /sitemap.xml" and "Robots: /robots.txt" in headless mode, where neither was
      // injected, and that log is why three sites ran for months without a sitemap.
      "astro:build:done": ({ logger }) => {
        logger.info("──────────────────────────────────────");
        logger.info("AgentCMS build complete");
        logger.info(
          mode === "auto"
            ? `  Blog:    ${base || "/blog"}`
            : `  Blog:    your own routes (headless; AgentCMS injected none)`
        );
        logger.info("  API:     /api/agent/*");
        logger.info("  Images:  /images/*");
        if (skillEndpoint) logger.info("  Skill:   /.well-known/agent-skill.json");
        for (const line of describeSeoRoutes(seoPlan)) logger.info(line);
        logger.info("──────────────────────────────────────");
      },
    },
  };
}
