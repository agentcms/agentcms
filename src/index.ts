// ============================================================================
// AgentCMS — Main Entry Point
// ============================================================================
//
// Default export: Astro integration
// Named exports: Data helper functions for use in .astro pages
//
// ============================================================================

// --- Integration (default export) ---
export { default } from "./integration/index.js";

// --- Config helper ---
import type { AgentCMSOptions } from "./types.js";

/**
 * Typed helper for defining AgentCMS config in a separate file.
 *
 * Usage in agentcms.config.ts:
 *   import { defineAgentCMSConfig } from "@agentcms/core";
 *   export default defineAgentCMSConfig({ mode: "auto", site: { ... } });
 *
 * Then in astro.config.mjs:
 *   import agentcms from "@agentcms/core";
 *   import config from "./agentcms.config";
 *   export default defineConfig({ integrations: [agentcms(config)] });
 */
export function defineAgentCMSConfig(config: AgentCMSOptions): AgentCMSOptions {
  return config;
}

// --- Types ---
export type {
  AgentCMSPost,
  AgentCMSOptions,
  AgentCMSSiteConfig,
  PostIndex,
  PostIndexEntry,
  GetPostsOptions,
  GetPostsResult,
  AgentMetadata,
  AgentKeyRecord,
  AgentKeyScope,
  AgentSkillDefinition,
  X402Config,
  X402SubmissionRecord,
} from "./types.js";

// --- Utils ---
export {
  slugify,
  calculateReadingTime,
  generateDescription,
  extractHeadings,
} from "./utils/content.js";

// --- Data Helpers ---
// These are the primary API for reading posts in .astro pages.
// They read from KV via the cloudflare:workers env binding.
//
// Usage in an .astro file:
//   import { getAgentCMSPosts, getAgentCMSPost } from "agentcms";
//   const { posts } = await getAgentCMSPosts({ limit: 10 });

import type {
  AgentCMSPost,
  GetPostsOptions,
  GetPostsResult,
  AgentCMSSiteConfig,
} from "./types.js";
import { getIndex, getPost, getConfig } from "./utils/kv.js";

/**
 * Get the KV namespace binding.
 * Works in both Astro 6 (cloudflare:workers) and older patterns.
 */
async function getKV(): Promise<KVNamespace> {
  // Astro 6 + Cloudflare: direct import
  const { env } = await import("cloudflare:workers");
  const bindingName =
    globalThis.__AGENTCMS_CONFIG__?.kvBinding || "AGENTCMS_KV";
  const kv = (env as Record<string, unknown>)[bindingName] as KVNamespace;
  if (!kv) {
    throw new Error(
      `AgentCMS: KV binding "${bindingName}" not found. ` +
        "Add it to your wrangler.toml: [[kv_namespaces]] binding = " +
        `"${bindingName}"`
    );
  }
  return kv;
}

/**
 * Get paginated, filterable posts
 */
export async function getAgentCMSPosts(
  options: GetPostsOptions = {}
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

  const kv = await getKV();
  const index = await getIndex(kv);

  let filtered = index.posts;

  // Apply filters
  if (status !== "all") {
    // Index only contains published posts by default
    // Draft filtering would need separate KV list
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

  // Fetch full posts for this page
  const posts = await Promise.all(
    pageEntries.map((entry) => getPost(kv, entry.slug))
  );

  return {
    posts: posts.filter((p): p is AgentCMSPost => p !== null),
    totalPages,
    totalPosts,
    currentPage: page,
  };
}

/**
 * Get a single post by slug
 */
export async function getAgentCMSPost(
  slug: string
): Promise<AgentCMSPost | null> {
  const kv = await getKV();
  return getPost(kv, slug);
}

/**
 * Get all unique tags with counts
 */
export async function getAgentCMSTags(): Promise<
  Array<{ tag: string; count: number }>
> {
  const kv = await getKV();
  const index = await getIndex(kv);

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
 * Get all unique categories with counts
 */
export async function getAgentCMSCategories(): Promise<
  Array<{ category: string; count: number }>
> {
  const kv = await getKV();
  const index = await getIndex(kv);

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
 * Get site configuration
 */
export async function getAgentCMSConfig(): Promise<AgentCMSSiteConfig | null> {
  const kv = await getKV();
  return getConfig(kv);
}

// --- Global config type (set by integration via injectScript) ---
declare global {
  // biome-ignore lint: global augmentation
  var __AGENTCMS_CONFIG__:
    | {
        mode: string;
        basePath: string;
        postsPerPage: number;
        kvBinding: string;
        r2Binding: string;
        site?: import("./types.js").AgentCMSSiteConfig;
      }
    | undefined;
}
