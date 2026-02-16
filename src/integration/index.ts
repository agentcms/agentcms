// ============================================================================
// AgentCMS — Astro Integration
// ============================================================================
//
// Usage:
//   import agentcms from "agentcms";
//   export default defineConfig({
//     integrations: [agentcms({ mode: "auto" })],
//   });
//
// ============================================================================

import type { AstroIntegration } from "astro";
import type { AgentCMSOptions } from "../types.js";

export default function agentcms(
  options: AgentCMSOptions = {}
): AstroIntegration {
  const {
    mode = "auto",
    basePath = "/blog",
    postsPerPage = 12,
    rss = true,
    skillEndpoint = true,
    theme = "default",
    kvBinding = "AGENTCMS_KV",
    r2Binding = "AGENTCMS_R2",
    site,
  } = options;

  // Normalize basePath (no trailing slash)
  const base = basePath.replace(/\/$/, "");

  return {
    name: "agentcms",
    hooks: {
      "astro:config:setup": ({
        injectRoute,
        injectScript,
        updateConfig,
        logger,
      }) => {
        logger.info(`AgentCMS initializing in "${mode}" mode`);

        // ---------------------------------------------------------------
        // Always inject: Agent write API
        // ---------------------------------------------------------------
        injectRoute({
          pattern: "/api/agent/publish",
          entrypoint: "@agentcms/core/routes/api/publish.ts",
        });
        injectRoute({
          pattern: "/api/agent/posts",
          entrypoint: "@agentcms/core/routes/api/list.ts",
        });
        injectRoute({
          pattern: "/api/agent/posts/[slug]",
          entrypoint: "@agentcms/core/routes/api/post.ts",
        });
        injectRoute({
          pattern: "/api/agent/context",
          entrypoint: "@agentcms/core/routes/api/context.ts",
        });
        injectRoute({
          pattern: "/api/agent/upload",
          entrypoint: "@agentcms/core/routes/api/upload.ts",
        });

        // ---------------------------------------------------------------
        // Always inject: Image serving from R2
        // ---------------------------------------------------------------
        injectRoute({
          pattern: "/images/[...path]",
          entrypoint: "@agentcms/core/routes/images.ts",
        });

        // ---------------------------------------------------------------
        // Always inject: Skill discovery endpoint
        // ---------------------------------------------------------------
        if (skillEndpoint) {
          injectRoute({
            pattern: "/.well-known/agent-skill.json",
            entrypoint: "@agentcms/core/routes/skill.ts",
          });
        }

        // ---------------------------------------------------------------
        // Auto mode: inject blog pages
        // ---------------------------------------------------------------
        if (mode === "auto") {
          injectRoute({
            pattern: base || "/blog",
            entrypoint: "@agentcms/core/routes/blog/index.astro",
          });
          injectRoute({
            pattern: `${base || "/blog"}/[slug]`,
            entrypoint: "@agentcms/core/routes/blog/[slug].astro",
          });
          injectRoute({
            pattern: `${base || "/blog"}/tag/[tag]`,
            entrypoint: "@agentcms/core/routes/blog/tag/[tag].astro",
          });

          if (rss) {
            injectRoute({
              pattern: "/feed.xml",
              entrypoint: "@agentcms/core/routes/feed.xml.ts",
            });
          }

          logger.info(
            `Auto routes: ${base}/, ${base}/[slug], ${base}/tag/[tag]`
          );
        }

        // ---------------------------------------------------------------
        // Inject theme CSS
        // ---------------------------------------------------------------
        if (theme === "default") {
          injectScript("page", `import "@agentcms/core/theme/default.css";`);
        }

        // ---------------------------------------------------------------
        // Inject virtual module with config (available to routes/components)
        // ---------------------------------------------------------------
        // TODO: Use Astro's virtual module API to expose config
        // import.meta.env.AGENTCMS_BASE_PATH, etc.
        // For now, config is passed via a global that routes can read.
        injectScript(
          "page-ssr",
          `globalThis.__AGENTCMS_CONFIG__ = ${JSON.stringify({
            mode,
            basePath: base || "/blog",
            postsPerPage,
            kvBinding,
            r2Binding,
            ...(site ? { site } : {}),
          })};`
        );

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
        logger.info(`  Blog:  ${base || "/blog"}`);
        logger.info("  API:   /api/agent/*");
        logger.info("  Images: /images/*");
        logger.info("  Skill: /.well-known/agent-skill.json");
        logger.info("──────────────────────────────────────");
      },
    },
  };
}
