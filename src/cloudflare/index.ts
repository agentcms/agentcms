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
// For a plain Worker, `@agentcms/agentcms/worker` wraps the same router.
//
// ============================================================================

import {
  handleListPosts,
  handleGetPost,
  handleListCategories,
  handleListTags,
  handleSitemap,
  handleRobotsTxt,
  handleImage,
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
  type HandlerOptions,
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
  /** Where the site shows a post, for the `url` publish returns (default: "/blog") */
  blogBase?: string;
  /** Enable sitemap.xml handler (default: true) */
  sitemap?: boolean | SitemapOptions;
  /** Enable robots.txt handler (default: true) */
  robots?: boolean | RobotsTxtOptions;
  /** Enable /.well-known/agent-skill.json (default: true) */
  skillEndpoint?: boolean;
  /** Serve uploaded images at /images/:key (default: true) */
  images?: boolean;
  /**
   * Allowed origin(s) for browser reads of the public API, e.g. a static
   * frontend on another domain. Off by default; "*" allows any.
   */
  cors?: string | string[];
}

/** What a handler needs from the platform: the env, and a way to outlive the response. */
export interface RouteContext {
  request: Request;
  env: AgentCMSEnv;
  params: Record<string, string>;
  waitUntil?: (promise: Promise<unknown>) => void;
}

type PagesContext = {
  request: Request;
  env: AgentCMSEnv;
  params: Record<string, string | string[]>;
  next: () => Promise<Response>;
  waitUntil?: (promise: Promise<unknown>) => void;
};

type WaitUntil = (promise: Promise<unknown>) => void;

// ---------------------------------------------------------------------------
// Route matching
// ---------------------------------------------------------------------------

type RouteHandler = (ctx: RouteContext, opts: HandlerOptions) => Promise<Response>;

interface Route {
  method: string | null; // null = any method
  pattern: RegExp;
  handler: RouteHandler;
  /** Public read route: gets CORS headers when `cors` is set. */
  public?: boolean;
}

const SLUG = "(?<slug>[a-z0-9-]+)";

function buildRoutes(opts: ResolvedOptions): Route[] {
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
    handler: (ctx, o) => handlePublish(ctx.request, ctx.env, o),
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
    pattern: new RegExp(`^${escRe(agent)}/posts/${SLUG}$`),
    handler: (ctx) => handleAgentGetPost(ctx.request, ctx.env, ctx.params.slug),
  });

  routes.push({
    method: "PUT",
    pattern: new RegExp(`^${escRe(agent)}/posts/${SLUG}$`),
    handler: (ctx, o) => handleAgentUpdatePost(ctx.request, ctx.env, ctx.params.slug, o),
  });

  routes.push({
    method: "DELETE",
    pattern: new RegExp(`^${escRe(agent)}/posts/${SLUG}$`),
    handler: (ctx, o) => handleAgentDeletePost(ctx.request, ctx.env, ctx.params.slug, o),
  });

  // --- Public read routes ---
  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(api)}/posts$`),
    handler: (ctx) => handleListPosts(ctx.request, ctx.env),
    public: true,
  });

  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(api)}/posts/${SLUG}$`),
    handler: (ctx) => handleGetPost(ctx.request, ctx.env, ctx.params.slug),
    public: true,
  });

  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(api)}/categories$`),
    handler: (ctx) => handleListCategories(ctx.request, ctx.env),
    public: true,
  });

  routes.push({
    method: "GET",
    pattern: new RegExp(`^${escRe(api)}/tags$`),
    handler: (ctx) => handleListTags(ctx.request, ctx.env),
    public: true,
  });

  // --- Images (upload returns URLs under /images) ---
  if (opts.images !== false) {
    routes.push({
      method: "GET",
      pattern: /^\/images\/(?<key>[^/]+)$/,
      handler: (ctx) => handleImage(ctx.request, ctx.env, ctx.params.key),
      public: true,
    });
  }

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

type ResolvedOptions = Required<Omit<AgentCMSMiddlewareOptions, "cors">> &
  Pick<AgentCMSMiddlewareOptions, "cors">;

function resolveOptions(options: AgentCMSMiddlewareOptions): ResolvedOptions {
  return {
    apiBase: options.apiBase ?? "/api",
    agentBase: options.agentBase ?? "/api/agent",
    blogBase: options.blogBase ?? "/blog",
    sitemap: options.sitemap ?? true,
    robots: options.robots ?? true,
    skillEndpoint: options.skillEndpoint ?? true,
    images: options.images ?? true,
    cors: options.cors,
  };
}

/** The Access-Control-Allow-Origin value for this request, or null. */
function allowedOrigin(cors: ResolvedOptions["cors"], request: Request): string | null {
  if (!cors) return null;
  const list = Array.isArray(cors) ? cors : [cors];
  if (list.includes("*")) return "*";
  const origin = request.headers.get("Origin");
  return origin && list.includes(origin) ? origin : null;
}

function withCors(response: Response, origin: string): Response {
  const res = new Response(response.body, response);
  res.headers.set("Access-Control-Allow-Origin", origin);
  if (origin !== "*") res.headers.append("Vary", "Origin");
  return res;
}

/**
 * The AgentCMS router: answers a request it owns, or returns null so the
 * caller can fall through to the rest of the app.
 */
export function createAgentCMSRouter(
  options: AgentCMSMiddlewareOptions = {}
): (request: Request, env: AgentCMSEnv, waitUntil?: WaitUntil) => Promise<Response | null> {
  const opts = resolveOptions(options);
  const routes = buildRoutes(opts);

  return async (request, env, waitUntil) => {
    const pathname = new URL(request.url).pathname;
    const method = request.method.toUpperCase();

    for (const route of routes) {
      const match = route.pattern.exec(pathname);
      if (!match) continue;

      const origin = route.public ? allowedOrigin(opts.cors, request) : null;
      if (method === "OPTIONS" && origin) {
        return new Response(null, {
          status: 204,
          headers: {
            "Access-Control-Allow-Origin": origin,
            "Access-Control-Allow-Methods": "GET, HEAD, OPTIONS",
            "Access-Control-Max-Age": "86400",
            ...(origin !== "*" ? { Vary: "Origin" } : {}),
          },
        });
      }
      if (route.method && route.method !== method) continue;

      const ctx: RouteContext = { request, env, params: { ...match.groups }, waitUntil };
      const response = await route.handler(ctx, {
        basePath: opts.blogBase,
        ...(waitUntil ? { waitUntil } : {}),
      });
      return origin ? withCors(response, origin) : response;
    }
    return null;
  };
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
  const route = createAgentCMSRouter(options);

  return async (ctx: PagesContext): Promise<Response> => {
    // Called through ctx, so Pages' waitUntil keeps its `this`.
    const waitUntil: WaitUntil | undefined = ctx.waitUntil
      ? (p) => ctx.waitUntil?.(p)
      : undefined;
    const response = await route(ctx.request, ctx.env, waitUntil);
    // Not an AgentCMS route — pass through
    return response ?? ctx.next();
  };
}

// Re-export env type for convenience
export type { AgentCMSEnv } from "../handlers/public.js";
