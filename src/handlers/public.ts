// ============================================================================
// AgentCMS — Public Read Handlers (no auth, cacheable)
// ============================================================================
//
// Framework-agnostic HTTP handlers for blog frontends.
// Each takes (request, env) and returns a Response with JSON + cache headers.
//
// ============================================================================

import type { AgentCMSPost, SitemapOptions, RobotsTxtOptions } from "../types.js";
import { getPost, getIndex } from "../utils/kv.js";
import { queryPosts, queryTags, queryCategories } from "../utils/query.js";
import { generateSitemapXml, generateRobotsTxt } from "../utils/sitemap.js";
import { Marked } from "marked";

export interface AgentCMSEnv {
  AGENTCMS_KV: KVNamespace;
  AGENTCMS_R2?: R2Bucket;
  /** Optional KV key prefix to isolate data when sharing a namespace. */
  AGENTCMS_PREFIX?: string;
}

const marked = new Marked();

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=60",
    },
  });
}

/**
 * GET /api/posts — List published posts with pagination and filtering.
 *
 * Query params: page, limit, tag, category, featured, author, authorType
 */
export async function handleListPosts(
  request: Request,
  env: AgentCMSEnv
): Promise<Response> {
  const url = new URL(request.url);
  const page = Math.max(1, parseInt(url.searchParams.get("page") ?? "1", 10) || 1);
  const limit = Math.min(100, Math.max(1, parseInt(url.searchParams.get("limit") ?? "12", 10) || 12));
  const tag = url.searchParams.get("tag") || undefined;
  const category = url.searchParams.get("category") || undefined;
  const featuredParam = url.searchParams.get("featured");
  const featured = featuredParam === "true" ? true : featuredParam === "false" ? false : undefined;
  const author = url.searchParams.get("author") || undefined;
  const authorTypeParam = url.searchParams.get("authorType");
  const authorType = authorTypeParam === "agent" || authorTypeParam === "human" ? authorTypeParam : undefined;

  const result = await queryPosts(env.AGENTCMS_KV, {
    page,
    limit,
    tag,
    category,
    featured,
    author,
    authorType,
  }, env.AGENTCMS_PREFIX);

  return json(result);
}

/**
 * GET /api/posts/:slug — Get a single published post by slug.
 *
 * Renders markdown to HTML if contentHtml is not already set.
 */
export async function handleGetPost(
  request: Request,
  env: AgentCMSEnv,
  slug: string
): Promise<Response> {
  const post = await getPost(env.AGENTCMS_KV, slug, env.AGENTCMS_PREFIX);
  if (!post) {
    return json({ error: "Post not found" }, 404);
  }
  if (post.status !== "published") {
    return json({ error: "Post not found" }, 404);
  }

  // Ensure contentHtml is present
  if (!post.contentHtml && post.content) {
    (post as AgentCMSPost).contentHtml = await marked.parse(post.content);
  }

  return json(post);
}

/**
 * GET /api/categories — List all categories with post counts.
 */
export async function handleListCategories(
  request: Request,
  env: AgentCMSEnv
): Promise<Response> {
  const categories = await queryCategories(env.AGENTCMS_KV, env.AGENTCMS_PREFIX);
  return json({ categories });
}

/**
 * GET /api/tags — List all tags with post counts.
 */
export async function handleListTags(
  request: Request,
  env: AgentCMSEnv
): Promise<Response> {
  const tags = await queryTags(env.AGENTCMS_KV, env.AGENTCMS_PREFIX);
  return json({ tags });
}

/**
 * GET /sitemap.xml — Dynamic XML sitemap from post index.
 */
export async function handleSitemap(
  request: Request,
  env: AgentCMSEnv,
  options: SitemapOptions = {}
): Promise<Response> {
  const siteUrl = new URL(request.url).origin;
  const index = await getIndex(env.AGENTCMS_KV, env.AGENTCMS_PREFIX);
  const xml = generateSitemapXml(siteUrl, index.posts, options);

  return new Response(xml, {
    headers: {
      "Content-Type": "application/xml; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}

/**
 * GET /robots.txt — Dynamic robots.txt with Sitemap directives.
 */
export async function handleRobotsTxt(
  request: Request,
  _env: AgentCMSEnv,
  options: RobotsTxtOptions = {}
): Promise<Response> {
  const siteUrl = new URL(request.url).origin;
  const txt = generateRobotsTxt(siteUrl, options);

  return new Response(txt, {
    headers: {
      "Content-Type": "text/plain; charset=utf-8",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
