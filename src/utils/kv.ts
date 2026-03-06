// ============================================================================
// AgentCMS — KV Storage Helpers
// ============================================================================

import type {
  AgentCMSPost,
  PostIndex,
  PostIndexEntry,
  AgentCMSSiteConfig,
  AgentKeyRecord,
} from "../types.js";

// --- KV Key Helpers ---

/**
 * Build prefixed KV keys. When prefix is set (e.g. "raisolo"), keys become
 * "raisolo:posts:slug" instead of "posts:slug". This prevents collisions
 * when multiple sites share a single KV namespace.
 */
export function kvKeys(prefix?: string) {
  const p = prefix ? `${prefix}:` : "";
  return {
    post: (slug: string) => `${p}posts:${slug}`,
    draft: (slug: string) => `${p}posts:draft:${slug}`,
    index: `${p}posts:index`,
    config: `${p}config:site`,
    agent: (keyHash: string) => `${p}agents:${keyHash}`,
    rateLimit: (keyHash: string, hour: string) => `${p}ratelimit:${keyHash}:${hour}`,
  };
}

/** Default keys (no prefix) — backwards compatible. */
export const KEYS = kvKeys();

// --- Post Operations ---

export async function getPost(
  kv: KVNamespace,
  slug: string,
  prefix?: string
): Promise<AgentCMSPost | null> {
  const keys = prefix ? kvKeys(prefix) : KEYS;
  return kv.get(keys.post(slug), "json");
}

export async function putPost(
  kv: KVNamespace,
  post: AgentCMSPost,
  prefix?: string
): Promise<void> {
  const keys = prefix ? kvKeys(prefix) : KEYS;
  const key =
    post.status === "draft" ? keys.draft(post.slug) : keys.post(post.slug);
  await kv.put(key, JSON.stringify(post));
}

export async function deletePost(
  kv: KVNamespace,
  slug: string,
  prefix?: string
): Promise<void> {
  const keys = prefix ? kvKeys(prefix) : KEYS;
  await kv.delete(keys.post(slug));
  await kv.delete(keys.draft(slug));
}

// --- Index Operations ---

export async function getIndex(kv: KVNamespace, prefix?: string): Promise<PostIndex> {
  const keys = prefix ? kvKeys(prefix) : KEYS;
  const index = await kv.get<PostIndex>(keys.index, "json");
  return index || { posts: [], totalCount: 0, lastUpdated: "" };
}

export async function updateIndex(
  kv: KVNamespace,
  post: AgentCMSPost,
  action: "upsert" | "remove" = "upsert",
  prefix?: string
): Promise<void> {
  const keys = prefix ? kvKeys(prefix) : KEYS;
  const index = await getIndex(kv, prefix);

  // Remove existing entry
  index.posts = index.posts.filter((p) => p.slug !== post.slug);

  if (action === "upsert" && post.status === "published") {
    const entry: PostIndexEntry = {
      slug: post.slug,
      title: post.title,
      description: post.description,
      publishedAt: post.publishedAt,
      tags: post.tags,
      category: post.category,
      author: post.author,
      authorType: post.authorType,
      featuredImage: post.featuredImage,
      featured: post.featured,
    };
    index.posts.unshift(entry);
  }

  // Sort newest first
  index.posts.sort(
    (a, b) =>
      new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  index.totalCount = index.posts.length;
  index.lastUpdated = new Date().toISOString();

  await kv.put(keys.index, JSON.stringify(index));
}

// --- Config ---

export async function getConfig(
  kv: KVNamespace,
  prefix?: string
): Promise<AgentCMSSiteConfig | null> {
  const keys = prefix ? kvKeys(prefix) : KEYS;
  return kv.get<AgentCMSSiteConfig>(keys.config, "json");
}

export async function putConfig(
  kv: KVNamespace,
  config: AgentCMSSiteConfig,
  prefix?: string
): Promise<void> {
  const keys = prefix ? kvKeys(prefix) : KEYS;
  await kv.put(keys.config, JSON.stringify(config));
}

// --- Auth ---

export async function hashApiKey(key: string): Promise<string> {
  const encoder = new TextEncoder();
  const data = encoder.encode(key);
  const hash = await crypto.subtle.digest("SHA-256", data);
  return Array.from(new Uint8Array(hash))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

export async function validateApiKey(
  kv: KVNamespace,
  authHeader: string | null,
  prefix?: string
): Promise<AgentKeyRecord | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;

  const keys = prefix ? kvKeys(prefix) : KEYS;
  const apiKey = authHeader.slice(7);
  const keyHash = await hashApiKey(apiKey);
  const record = await kv.get<AgentKeyRecord>(keys.agent(keyHash), "json");

  if (record) {
    // Update last used (fire and forget)
    record.lastUsedAt = new Date().toISOString();
    kv.put(keys.agent(keyHash), JSON.stringify(record)).catch(() => {});
  }

  return record;
}

// --- Rate Limiting ---

export async function checkRateLimit(
  kv: KVNamespace,
  keyHash: string,
  limit: number,
  prefix?: string
): Promise<{ allowed: boolean; remaining: number }> {
  const keys = prefix ? kvKeys(prefix) : KEYS;
  const hour = new Date().toISOString().slice(0, 13);
  const key = keys.rateLimit(keyHash, hour);
  const current = parseInt((await kv.get(key)) || "0");

  if (current >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await kv.put(key, String(current + 1), { expirationTtl: 3600 });
  return { allowed: true, remaining: limit - current - 1 };
}
