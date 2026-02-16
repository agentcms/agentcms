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

// --- KV Key Prefixes ---
export const KEYS = {
  post: (slug: string) => `posts:${slug}`,
  draft: (slug: string) => `posts:draft:${slug}`,
  index: "posts:index",
  config: "config:site",
  agent: (keyHash: string) => `agents:${keyHash}`,
  rateLimit: (keyHash: string, hour: string) => `ratelimit:${keyHash}:${hour}`,
} as const;

// --- Post Operations ---

export async function getPost(
  kv: KVNamespace,
  slug: string
): Promise<AgentCMSPost | null> {
  return kv.get(KEYS.post(slug), "json");
}

export async function putPost(
  kv: KVNamespace,
  post: AgentCMSPost
): Promise<void> {
  const key =
    post.status === "draft" ? KEYS.draft(post.slug) : KEYS.post(post.slug);
  await kv.put(key, JSON.stringify(post));
}

export async function deletePost(
  kv: KVNamespace,
  slug: string
): Promise<void> {
  await kv.delete(KEYS.post(slug));
  await kv.delete(KEYS.draft(slug));
}

// --- Index Operations ---

export async function getIndex(kv: KVNamespace): Promise<PostIndex> {
  const index = await kv.get<PostIndex>(KEYS.index, "json");
  return index || { posts: [], totalCount: 0, lastUpdated: "" };
}

export async function updateIndex(
  kv: KVNamespace,
  post: AgentCMSPost,
  action: "upsert" | "remove" = "upsert"
): Promise<void> {
  const index = await getIndex(kv);

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

  await kv.put(KEYS.index, JSON.stringify(index));
}

// --- Config ---

export async function getConfig(
  kv: KVNamespace
): Promise<AgentCMSSiteConfig | null> {
  return kv.get<AgentCMSSiteConfig>(KEYS.config, "json");
}

export async function putConfig(
  kv: KVNamespace,
  config: AgentCMSSiteConfig
): Promise<void> {
  await kv.put(KEYS.config, JSON.stringify(config));
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
  authHeader: string | null
): Promise<AgentKeyRecord | null> {
  if (!authHeader?.startsWith("Bearer ")) return null;

  const apiKey = authHeader.slice(7);
  const keyHash = await hashApiKey(apiKey);
  const record = await kv.get<AgentKeyRecord>(KEYS.agent(keyHash), "json");

  if (record) {
    // Update last used (fire and forget)
    record.lastUsedAt = new Date().toISOString();
    kv.put(KEYS.agent(keyHash), JSON.stringify(record)).catch(() => {});
  }

  return record;
}

// --- Rate Limiting ---

export async function checkRateLimit(
  kv: KVNamespace,
  keyHash: string,
  limit: number
): Promise<{ allowed: boolean; remaining: number }> {
  const hour = new Date().toISOString().slice(0, 13);
  const key = KEYS.rateLimit(keyHash, hour);
  const current = parseInt((await kv.get(key)) || "0");

  if (current >= limit) {
    return { allowed: false, remaining: 0 };
  }

  await kv.put(key, String(current + 1), { expirationTtl: 3600 });
  return { allowed: true, remaining: limit - current - 1 };
}
