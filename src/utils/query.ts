// ============================================================================
// AgentCMS — Pure Query Functions (framework-agnostic)
// ============================================================================
//
// These functions take a KVNamespace directly — no cloudflare:workers import,
// no globalThis config. Used by both Astro data helpers and standalone handlers.
//
// ============================================================================

import type {
  AgentCMSPost,
  GetPostsOptions,
  GetPostsResult,
  AgentCMSSiteConfig,
} from "../types.js";
import { getIndex, getPost, getConfig } from "./kv.js";

/**
 * Get paginated, filterable posts from KV.
 */
export async function queryPosts(
  kv: KVNamespace,
  options: GetPostsOptions = {},
  prefix?: string
): Promise<GetPostsResult> {
  const {
    page = 1,
    limit = 12,
    tag,
    category,
    status = "published",
    featured,
    author,
    authorType,
  } = options;

  const index = await getIndex(kv, prefix);
  let filtered = index.posts;

  // Apply filters
  if (status !== "all") {
    // Index only contains published posts by default
  }
  if (tag) {
    filtered = filtered.filter((p) => p.tags.includes(tag));
  }
  if (category) {
    filtered = filtered.filter((p) => p.category === category);
  }
  if (featured !== undefined) {
    filtered = filtered.filter((p) => p.featured === featured);
  }
  if (author) {
    filtered = filtered.filter((p) => p.author === author);
  }
  if (authorType) {
    filtered = filtered.filter((p) => p.authorType === authorType);
  }

  const totalPosts = filtered.length;
  const totalPages = Math.ceil(totalPosts / limit);
  const offset = (page - 1) * limit;
  const pageEntries = filtered.slice(offset, offset + limit);

  const posts = await Promise.all(
    pageEntries.map((entry) => getPost(kv, entry.slug, prefix))
  );

  return {
    posts: posts.filter((p): p is AgentCMSPost => p !== null),
    totalPages,
    totalPosts,
    currentPage: page,
  };
}

/**
 * Get all unique tags with counts.
 */
export async function queryTags(
  kv: KVNamespace,
  prefix?: string
): Promise<Array<{ tag: string; count: number }>> {
  const index = await getIndex(kv, prefix);

  const tagMap = new Map<string, number>();
  for (const post of index.posts) {
    for (const tag of post.tags) {
      tagMap.set(tag, (tagMap.get(tag) || 0) + 1);
    }
  }

  return Array.from(tagMap.entries())
    .map(([tag, count]) => ({ tag, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get all unique categories with counts.
 */
export async function queryCategories(
  kv: KVNamespace,
  prefix?: string
): Promise<Array<{ category: string; count: number }>> {
  const index = await getIndex(kv, prefix);

  const catMap = new Map<string, number>();
  for (const post of index.posts) {
    if (post.category) {
      catMap.set(post.category, (catMap.get(post.category) || 0) + 1);
    }
  }

  return Array.from(catMap.entries())
    .map(([category, count]) => ({ category, count }))
    .sort((a, b) => b.count - a.count);
}

/**
 * Get site configuration from KV.
 */
export async function queryConfig(
  kv: KVNamespace,
  prefix?: string
): Promise<AgentCMSSiteConfig | null> {
  return getConfig(kv, prefix);
}
