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

export default function agentcms(
  options: AgentCMSOptions = {}
): AstroIntegration {
  const {
    mode = "auto",
    basePath = "/blog",
    postsPerPage = 12,
    rss = true,
    sitemap = true,
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

  return {
    name: "agentcms",
    hooks: {
      "astro:config:setup": async ({
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

          if (rss) {
            injectRoute({
              pattern: "/feed.xml",
              entrypoint: "@agentcms/agentcms/routes/feed.xml.ts",
            });
          }

          if (sitemap) {
            injectRoute({
              pattern: "/sitemap.xml",
              entrypoint: "@agentcms/agentcms/routes/sitemap.xml.ts",
            });
          }

          injectRoute({
            pattern: "/robots.txt",
            entrypoint: "@agentcms/agentcms/routes/robots.txt.ts",
          });

          logger.info(
            `Auto routes: ${base}/, ${base}/[slug], ${base}/tag/[tag]`
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

      "astro:config:done": ({ config, logger }) => {
        // Warn if not using server output (needed for KV reads)
        if (config.output !== "server") {
          logger.warn(
            'AgentCMS requires output: "server" for live KV reads. ' +
              "Add `output: 'server'` to your astro.config.mjs"
          );
        }
      },

      "astro:build:done": ({ logger }) => {
        logger.info("──────────────────────────────────────");
        logger.info("AgentCMS build complete");
        logger.info(`  Blog:    ${base || "/blog"}`);
        logger.info("  API:     /api/agent/*");
        logger.info("  Images:  /images/*");
        logger.info("  Skill:   /.well-known/agent-skill.json");
        if (sitemap) logger.info("  Sitemap: /sitemap.xml");
        logger.info("  Robots:  /robots.txt");
        logger.info("──────────────────────────────────────");
      },
    },
  };
}
