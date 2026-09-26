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
  entrypoint: string;
  /** Files in src/pages that would make the project own this path. */
  pages: string[];
  /** Files in public/ that would make the project own this path. */
  assets: string[];
}

const SEO_ROUTES: Record<SeoRouteKind, SeoRouteSpec> = {
  sitemap: {
    pattern: "/sitemap.xml",
    entrypoint: "@agentcms/agentcms/routes/sitemap.xml.ts",
    pages: ["sitemap.xml.ts", "sitemap.xml.js", "sitemap.xml.astro"],
    assets: ["sitemap.xml"],
  },
  robots: {
    pattern: "/robots.txt",
    entrypoint: "@agentcms/agentcms/routes/robots.txt.ts",
    pages: ["robots.txt.ts", "robots.txt.js"],
    assets: ["robots.txt"],
  },
  feed: {
    pattern: "/feed.xml",
    entrypoint: "@agentcms/agentcms/routes/feed.xml.ts",
    pages: ["feed.xml.ts", "feed.xml.js"],
    assets: ["feed.xml"],
  },
};

/**
 * Which SEO paths the project already answers for itself.
 *
 * Deliberately a filesystem probe rather than a look at Astro's resolved routes: `injectRoute`
 * happens in `astro:config:setup`, long before routes are resolved, so by the time Astro could
 * tell us it is too late to decide. `existsSync` is injectable for tests.
 */
export async function detectProjectSeoRoutes(
  dirs: { srcDir?: URL | string; publicDir?: URL | string },
  existsSync?: (path: string) => boolean
): Promise<Set<SeoRouteKind>> {
  const owned = new Set<SeoRouteKind>();

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
      ...(pagesDir ? spec.pages.map((f) => join(pagesDir, f)) : []),
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
  origin?: string;
}

export interface StaticPageEntry {
  loc: string;
  changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
  priority?: number;
}

/**
 * The project's own indexable pages, for the injected sitemap.
 *
 * Without this, an injected sitemap in headless mode would list `/`, the blog base and the posts
 * and nothing else — so a site whose own pages are the point (raisolo's /privacy and /terms,
 * como.travel's guides) would get a sitemap that looks complete and is not. An incomplete
 * sitemap is a worse failure than a missing one, because nothing reports it.
 *
 * Dynamic routes are excluded: a route with params has no single URL, and guessing one is how a
 * sitemap ends up full of 404s. Posts are added by the endpoint from the KV index instead.
 */
export function collectSitePages(
  routes: readonly ResolvedRouteLike[],
  basePath: string
): StaticPageEntry[] {
  const base = basePath.replace(/\/$/, "") || "/blog";
  const skip = new Set(["/404", "/500", "/sitemap.xml", "/robots.txt", "/feed.xml"]);

  const locs: string[] = [];
  for (const route of routes ?? []) {
    if (route.type !== "page") continue; // endpoints, redirects and fallbacks are not content
    if (route.params?.length) continue; // dynamic — no single URL to list
    const pattern = route.pattern;
    if (!pattern || !pattern.startsWith("/")) continue;
    const loc = pattern.length > 1 ? pattern.replace(/\/$/, "") : "/";
    if (skip.has(loc)) continue;
    if (loc.startsWith(`${base}/`)) continue; // individual posts come from the KV index
    locs.push(loc);
  }

  // `/` and the blog index always belong, whether or not the project declares them as its own
  // pages (in auto mode AgentCMS owns the blog index itself).
  const entries: StaticPageEntry[] = [
    { loc: "/", changefreq: "weekly", priority: 1.0 },
    { loc: base, changefreq: "daily", priority: 0.8 },
  ];
  const seen = new Set(entries.map((e) => e.loc));
  for (const loc of locs.sort()) {
    if (seen.has(loc)) continue;
    seen.add(loc);
    // No changefreq or priority: we do not know how often someone else's page changes, and a
    // number we made up is worse than an absent one.
    entries.push({ loc });
  }
  return entries;
}

// ---------------------------------------------------------------------------
// Generated sitemap route
// ---------------------------------------------------------------------------
//
// The sitemap needs two things an SSR endpoint cannot get for itself: the project's own pages, and
// the configured basePath (`globalThis.__AGENTCMS_CONFIG__` comes from `page-ssr`, which never runs
// for a .ts endpoint — the footgun documented below). So the integration generates a real module
// in Astro's codegen dir that calls the handler factory with both baked in.
//
// Deliberately NOT a Vite virtual module: Vite pre-bundles with esbuild, that pass does not go
// through a plugin's resolveId, and the injected endpoint lives inside node_modules — so a virtual
// id fails with 'Could not resolve "virtual:agentcms/site-pages"' as soon as the route is really
// injected, and neither optimizeDeps.exclude nor an esbuild resolver plugin reliably fixes it. A
// file on disk resolves like any other source file.

/** The generated module, written to Astro's codegen dir and used as the route's entrypoint. */
export function renderSitemapRouteModule(config: {
  basePath: string;
  staticPages: StaticPageEntry[];
  kvBinding?: string;
  kvPrefix?: string;
}): string {
  return `// Generated by @agentcms/agentcms. Do not edit.
import { createSitemapRoute } from "@agentcms/agentcms/routes/sitemap-handler.ts";

export const GET = createSitemapRoute(${JSON.stringify(config, null, 2)});
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
  // Where the generated sitemap route is written, and what goes in it. The file is written twice:
  // once in astro:config:setup so the entrypoint exists when Astro resolves routes, then again in
  // astro:routes:resolved once the project's own pages are known. If that second hook never runs,
  // the first version still serves -- with the blog only, which is what this route could do before.
  let sitemapModuleUrl: URL | undefined;
  let writeSitemapModule: ((pages: StaticPageEntry[]) => Promise<void>) | undefined;

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
          }),
        });
        // The sitemap is generated rather than injected from the package — see
        // renderSitemapRouteModule. Set up before the loop so the entrypoint exists first.
        if (seoPlan.sitemap === "agentcms") {
          try {
            const { writeFile, mkdir } = await import("node:fs/promises");
            const dir = createCodegenDir();
            await mkdir(dir, { recursive: true });
            sitemapModuleUrl = new URL("sitemap.xml.ts", dir);
            writeSitemapModule = async (pages) => {
              await writeFile(
                sitemapModuleUrl!,
                renderSitemapRouteModule({
                  basePath: base || "/blog",
                  staticPages: pages,
                  kvBinding,
                  ...(kvPrefix ? { kvPrefix } : {}),
                }),
                "utf-8"
              );
            };
            await writeSitemapModule([]);
          } catch (err) {
            // Could not generate it (no writable codegen dir, non-Node builder). Fall back to the
            // package route: blog-only, but a served sitemap beats a 404 — and say so, because a
            // silent downgrade here is the exact failure this release exists to remove.
            sitemapModuleUrl = undefined;
            logger.warn(
              `Could not generate the sitemap route (${err instanceof Error ? err.message : String(err)}). ` +
                "Falling back to the built-in route, which lists the blog only — your own pages will be missing. " +
                "Add src/pages/sitemap.xml.ts to take it over."
            );
          }
        }

        for (const kind of Object.keys(SEO_ROUTES) as SeoRouteKind[]) {
          if (seoPlan[kind] !== "agentcms") continue;
          injectRoute({
            pattern: SEO_ROUTES[kind].pattern,
            entrypoint:
              kind === "sitemap" && sitemapModuleUrl
                ? sitemapModuleUrl
                : SEO_ROUTES[kind].entrypoint,
          });
        }
        if (seoPlan.sitemap === "disabled") {
          logger.warn(
            "sitemap: false and no src/pages/sitemap.xml — nothing will serve /sitemap.xml. " +
              "A site with no fetchable sitemap is a site search engines have to guess at."
          );
        }

        // ---------------------------------------------------------------
        // Virtual module: config that .ts endpoints can actually import
        // ---------------------------------------------------------------

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

      // Runs after config:setup and before the Vite build, so the virtual module below is loaded
      // with these pages already in hand.
      "astro:routes:resolved": async ({ routes }: { routes: readonly ResolvedRouteLike[] }) => {
        await writeSitemapModule?.(collectSitePages(routes, base || "/blog"));
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
