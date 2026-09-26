// ============================================================================
// AgentCMS — Public Read Handlers (no auth, cacheable)
// ============================================================================
//
// Framework-agnostic HTTP handlers for blog frontends.
// Each takes (request, env) and returns a Response with JSON + cache headers.
//
// ============================================================================

import type { AgentCMSPost, SitemapOptions, RobotsTxtOptions } from "../types.js";
import { getPost, getIndex, getConfig } from "../utils/kv.js";
import {
  queryPosts,
  queryTags,
  queryCategories,
  queryTranslations,
  defaultLanguage,
} from "../utils/query.js";
import { generateSitemapXml, generateRobotsTxt } from "../utils/sitemap.js";
import { toSafePost, toSafeListPost } from "../utils/sanitize.js";

export interface AgentCMSEnv {
  AGENTCMS_KV: KVNamespace;
  AGENTCMS_R2?: R2Bucket;
  /** Optional KV key prefix to isolate data when sharing a namespace. */
  AGENTCMS_PREFIX?: string;
}

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
 * Query params: page, limit, tag, category, featured, author, authorType,
 * lang, translationKey, since (ISO 8601, on updatedAt), full.
 *
 * `full=1` renders every post's `contentHtml` (sanitized), for consumers that
 * build pages from this list — a static site pulling its articles at build
 * time. Without it, `contentHtml` is present only where it was stored.
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
  const lang = url.searchParams.get("lang") || undefined;
  const translationKey = url.searchParams.get("translationKey") || undefined;
  const since = url.searchParams.get("since") || undefined;
  if (since && Number.isNaN(Date.parse(since))) {
    return json({ error: "since must be an ISO 8601 date-time" }, 400);
  }
  const full = ["1", "true"].includes(url.searchParams.get("full") ?? "");
  const defaultLang = lang ? await siteLanguage(env) : undefined;

  const result = await queryPosts(env.AGENTCMS_KV, {
    page,
    limit,
    tag,
    category,
    featured,
    author,
    authorType,
    lang,
    defaultLang,
    translationKey,
    since,
  }, env.AGENTCMS_PREFIX);

  const posts = full
    ? await Promise.all(result.posts.map((p) => toSafePost(p)))
    : result.posts.map(toSafeListPost);
  return json({ ...result, posts });
}

/** The site's default language (see defaultLanguage). */
async function siteLanguage(env: AgentCMSEnv): Promise<string> {
  const config = await getConfig(env.AGENTCMS_KV, env.AGENTCMS_PREFIX);
  return defaultLanguage(config);
}

/**
 * GET /api/posts/:slug — Get a single published post by slug.
 *
 * `contentHtml` is always present and sanitized; `content` is the raw
 * agent-written markdown and must not be inserted as HTML.
 */
export async function handleGetPost(
  request: Request,
  env: AgentCMSEnv,
  slug: string
): Promise<Response> {
  // A slug is [a-z0-9-]; anything else ("draft:x", "index") would address another KV key.
  if (!/^[a-z0-9-]{1,80}$/.test(slug)) {
    return json({ error: "Post not found" }, 404);
  }
  const post = await getPost(env.AGENTCMS_KV, slug, env.AGENTCMS_PREFIX);
  if (!post) {
    return json({ error: "Post not found" }, 404);
  }
  if (post.status !== "published") {
    return json({ error: "Post not found" }, 404);
  }

  // The article's other language versions, for a switcher and hreflang.
  const translations = post.translationKey
    ? await queryTranslations(
        env.AGENTCMS_KV,
        post.translationKey,
        env.AGENTCMS_PREFIX,
        await siteLanguage(env)
      )
    : [];
  return json({ ...(await toSafePost(post)), translations });
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

/**
 * GET /images/:key — Serve an uploaded image from R2.
 *
 * Only keys of the shape upload writes ({8 hex}-{sanitized name}) are read, so
 * this can't be pointed at anything else in the bucket.
 */
export async function handleImage(
  _request: Request,
  env: AgentCMSEnv,
  key: string
): Promise<Response> {
  const r2 = env.AGENTCMS_R2;
  if (!r2) return new Response("Image storage not configured", { status: 500 });
  if (key.length > 120 || !/^[a-f0-9]{8}-[a-z0-9._-]+$/i.test(key) || key.includes("..")) {
    return new Response("Not found", { status: 404 });
  }
  const object = await r2.get(key);
  if (!object) return new Response("Not found", { status: 404 });
  return new Response(object.body as ReadableStream, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      ETag: object.httpEtag,
    },
  });
}
