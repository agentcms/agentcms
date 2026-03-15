// ============================================================================
// AgentCMS — Cloudflare Pages Middleware
// ============================================================================
//
// Drop-in middleware for non-Astro projects using Cloudflare Pages Functions.
// Instead of creating 10+ boilerplate function files, use a single middleware:
//
//   // functions/_middleware.ts
//   import { agentcmsMiddleware } from "@agentcms/agentcms/cloudflare";
//   export const onRequest = agentcmsMiddleware();
//
// ============================================================================

import {
  handleListPosts,
  handleGetPost,
  handleListCategories,
  handleListTags,
  handleSitemap,
  handleRobotsTxt,
} from "../handlers/public.js";

import {
  handlePublish,
  handleAgentListPosts,
  handleAgentGetPost,
  handleAgentUpdatePost,
  handleAgentDeletePost,
  handleAgentContext,
  handleAgentUpload,
  handleSkill,
} from "../handlers/agent.js";

import type { AgentCMSEnv } from "../handlers/public.js";
import type { SitemapOptions, RobotsTxtOptions } from "../types.js";

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface AgentCMSMiddlewareOptions {
  /** Base path for public API routes (default: "/api") */
  apiBase?: string;
  /** Base path for agent routes (default: "/api/agent") */
  agentBase?: string;
  /** Enable sitemap.xml handler (default: true) */
  sitemap?: boolean | SitemapOptions;
  /** Enable robots.txt handler (default: true) */
  robots?: boolean | RobotsTxtOptions;
  /** Enable /.well-known/agent-skill.json (default: true) */
  skillEndpoint?: boolean;
}

type PagesContext = {
  request: Request;
  env: AgentCMSEnv;
  params: Record<string, string | string[]>;
  next: () => Promise<Response>;
};

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

type RouteHandler = (ctx: PagesContext) => Promise<Response>;

interface Route {
  method: string | null; // null = any method
  pattern: RegExp;
  handler: RouteHandler;
}

function buildRoutes(opts: Required<AgentCMSMiddlewareOptions>): Route[] {
  const api = opts.apiBase.replace(/\/$/, "");
  const agent = opts.agentBase.replace(/\/$/, "");
  const routes: Route[] = [];

  // --- Agent routes (auth-required) ---
  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(agent)}/context$`),
    handler: (ctx) => handleAgentContext(ctx.request, ctx.env),
  });

  routes.push({
    method: "POST",
    pattern: new RegExp(`^${escRe(agent)}/publish$`),
    handler: (ctx) => handlePublish(ctx.request, ctx.env),
  });

  routes.push({
    method: "POST",
    pattern: new RegExp(`^${escRe(agent)}/upload$`),
    handler: (ctx) => handleAgentUpload(ctx.request, ctx.env),
  });

  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(agent)}/posts$`),
    handler: (ctx) => handleAgentListPosts(ctx.request, ctx.env),
  });

  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(agent)}/posts/(?<slug>[a-z0-9-]+)$`),
    handler: (ctx) => handleAgentGetPost(ctx.request, ctx.env, ctx.params.slug as string),
  });

  routes.push({
    method: "PUT",
    pattern: new RegExp(`^${escRe(agent)}/posts/(?<slug>[a-z0-9-]+)$`),
    handler: (ctx) => handleAgentUpdatePost(ctx.request, ctx.env, ctx.params.slug as string),
  });

  routes.push({
    method: "DELETE",
    pattern: new RegExp(`^${escRe(agent)}/posts/(?<slug>[a-z0-9-]+)$`),
    handler: (ctx) => handleAgentDeletePost(ctx.request, ctx.env, ctx.params.slug as string),
  });

  // --- Public read routes ---
  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(api)}/posts$`),
    handler: (ctx) => handleListPosts(ctx.request, ctx.env),
  });

  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(api)}/posts/(?<slug>[a-z0-9-]+)$`),
    handler: (ctx) => handleGetPost(ctx.request, ctx.env, ctx.params.slug as string),
  });

  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(api)}/categories$`),
    handler: (ctx) => handleListCategories(ctx.request, ctx.env),
  });

  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(api)}/tags$`),
    handler: (ctx) => handleListTags(ctx.request, ctx.env),
  });

  // --- Sitemap ---
  if (opts.sitemap !== false) {
    const sitemapOpts = typeof opts.sitemap === "object" ? opts.sitemap : {};
    routes.push({
      method: "GET",
      pattern: /^\/sitemap\.xml$/,
      handler: (ctx) => handleSitemap(ctx.request, ctx.env, sitemapOpts),
    });
  }

  // --- Robots.txt ---
  if (opts.robots !== false) {
    const robotsOpts = typeof opts.robots === "object" ? opts.robots : {};
    routes.push({
      method: "GET",
      pattern: /^\/robots\.txt$/,
      handler: (ctx) => handleRobotsTxt(ctx.request, ctx.env, robotsOpts),
    });
  }

  // --- Skill endpoint ---
  if (opts.skillEndpoint !== false) {
    routes.push({
      method: "GET",
      pattern: /^\/\.well-known\/agent-skill\.json$/,
      handler: (ctx) => handleSkill(ctx.request),
    });
  }

  return routes;
}

function escRe(str: string): string {
  return str.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

// ---------------------------------------------------------------------------
// Middleware factory
// ---------------------------------------------------------------------------

/**
 * Creates a Cloudflare Pages middleware that handles all AgentCMS routes.
 *
 * Non-matching requests are passed through to `ctx.next()`.
 *
 * @example
 * ```ts
 * // functions/_middleware.ts
 * import { agentcmsMiddleware } from "@agentcms/agentcms/cloudflare";
 * export const onRequest = agentcmsMiddleware();
 * ```
 *
 * @example
 * ```ts
 * // Custom base paths
 * export const onRequest = agentcmsMiddleware({
 *   apiBase: "/cms/api",
 *   agentBase: "/cms/api/agent",
 * });
 * ```
 */
export function agentcmsMiddleware(
  options: AgentCMSMiddlewareOptions = {}
): (ctx: PagesContext) => Promise<Response> {
  const opts: Required<AgentCMSMiddlewareOptions> = {
    apiBase: options.apiBase ?? "/api",
    agentBase: options.agentBase ?? "/api/agent",
    sitemap: options.sitemap ?? true,
    robots: options.robots ?? true,
    skillEndpoint: options.skillEndpoint ?? true,
  };

  const routes = buildRoutes(opts);

  return async (ctx: PagesContext): Promise<Response> => {
    const url = new URL(ctx.request.url);
    const pathname = url.pathname;
    const method = ctx.request.method.toUpperCase();

    for (const route of routes) {
      if (route.method && route.method !== method) continue;

      const match = route.pattern.exec(pathname);
      if (!match) continue;

      // Extract named groups into ctx.params
      if (match.groups) {
        ctx.params = { ...ctx.params, ...match.groups };
      }

      return route.handler(ctx);
    }

    // Not an AgentCMS route — pass through
    return ctx.next();
  };
}

// Re-export env type for convenience
export type { AgentCMSEnv } from "../handlers/public.js";
