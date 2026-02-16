import { describe, it, expect, vi, beforeEach } from "vitest";
import {
  KEYS,
  getPost,
  putPost,
  deletePost,
  getIndex,
  updateIndex,
  getConfig,
  putConfig,
  hashApiKey,
  validateApiKey,
  checkRateLimit,
} from "./kv.js";
import type { AgentCMSPost, PostIndex, AgentCMSSiteConfig } from "../types.js";

// --- Mock KVNamespace ---

function createMockKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: vi.fn(async (key: string, type?: string) => {
      const val = store.get(key);
      if (val === undefined) return null;
      if (type === "json") return JSON.parse(val);
      return val;
    }),
    put: vi.fn(async (key: string, value: string) => {
      store.set(key, value);
    }),
    delete: vi.fn(async (key: string) => {
      store.delete(key);
    }),
    list: vi.fn(),
    getWithMetadata: vi.fn(),
  } as unknown as KVNamespace;
}

function makePost(overrides: Partial<AgentCMSPost> = {}): AgentCMSPost {
  return {
    slug: "test-post",
    title: "Test Post",
    description: "A test post",
    content: "# Test\n\nHello world.",
    author: "TestAgent",
    authorType: "agent",
    tags: ["test"],
    publishedAt: "2025-01-01T00:00:00.000Z",
    updatedAt: "2025-01-01T00:00:00.000Z",
    status: "published",
    readingTime: 1,
    featured: false,
    metadata: {},
    ...overrides,
  };
}

// ============================================================================
// KEYS
// ============================================================================

describe("KEYS", () => {
  it("generates correct post key", () => {
    expect(KEYS.post("hello-world")).toBe("posts:hello-world");
  });

  it("generates correct draft key", () => {
    expect(KEYS.draft("hello-world")).toBe("posts:draft:hello-world");
  });

  it("has correct index key", () => {
    expect(KEYS.index).toBe("posts:index");
  });

  it("has correct config key", () => {
    expect(KEYS.config).toBe("config:site");
  });

  it("generates correct agent key", () => {
    expect(KEYS.agent("abc123")).toBe("agents:abc123");
  });

  it("generates correct rate limit key", () => {
    expect(KEYS.rateLimit("abc", "2025-01-01T00")).toBe(
      "ratelimit:abc:2025-01-01T00"
    );
  });
});

// ============================================================================
// Post Operations
// ============================================================================

describe("getPost", () => {
  it("returns a post from KV", async () => {
    const kv = createMockKV();
    const post = makePost();
    await kv.put(KEYS.post("test-post"), JSON.stringify(post));

    const result = await getPost(kv, "test-post");
    expect(result).toEqual(post);
    expect(kv.get).toHaveBeenCalledWith("posts:test-post", "json");
  });

  it("returns null for missing post", async () => {
    const kv = createMockKV();
    const result = await getPost(kv, "nonexistent");
    expect(result).toBeNull();
  });
});

describe("putPost", () => {
  it("stores published post under posts: prefix", async () => {
    const kv = createMockKV();
    const post = makePost({ status: "published" });
    await putPost(kv, post);
    expect(kv.put).toHaveBeenCalledWith(
      "posts:test-post",
      JSON.stringify(post)
    );
  });

  it("stores draft post under posts:draft: prefix", async () => {
    const kv = createMockKV();
    const post = makePost({ status: "draft" });
    await putPost(kv, post);
    expect(kv.put).toHaveBeenCalledWith(
      "posts:draft:test-post",
      JSON.stringify(post)
    );
  });
});

describe("deletePost", () => {
  it("deletes both published and draft keys", async () => {
    const kv = createMockKV();
    await deletePost(kv, "test-post");
    expect(kv.delete).toHaveBeenCalledWith("posts:test-post");
    expect(kv.delete).toHaveBeenCalledWith("posts:draft:test-post");
  });
});

// ============================================================================
// Index Operations
// ============================================================================

describe("getIndex", () => {
  it("returns empty index when KV has no index", async () => {
    const kv = createMockKV();
    const index = await getIndex(kv);
    expect(index).toEqual({ posts: [], totalCount: 0, lastUpdated: "" });
  });

  it("returns stored index", async () => {
    const kv = createMockKV();
    const stored: PostIndex = {
      posts: [
        {
          slug: "a",
          title: "A",
          description: "Desc",
          publishedAt: "2025-01-01T00:00:00.000Z",
          tags: [],
          author: "Agent",
          authorType: "agent",
        },
      ],
      totalCount: 1,
      lastUpdated: "2025-01-01T00:00:00.000Z",
    };
    await kv.put(KEYS.index, JSON.stringify(stored));
    const index = await getIndex(kv);
    expect(index.totalCount).toBe(1);
    expect(index.posts[0].slug).toBe("a");
  });
});

describe("updateIndex", () => {
  it("adds a new published post to the index", async () => {
    const kv = createMockKV();
    const post = makePost({ slug: "new-post", title: "New Post" });
    await updateIndex(kv, post, "upsert");

    const index = JSON.parse(
      (await kv.get(KEYS.index)) as string
    ) as PostIndex;
    expect(index.totalCount).toBe(1);
    expect(index.posts[0].slug).toBe("new-post");
  });

  it("removes a post from the index", async () => {
    const kv = createMockKV();
    // First add
    const post = makePost({ slug: "remove-me" });
    await updateIndex(kv, post, "upsert");
    // Then remove
    await updateIndex(kv, post, "remove");

    const index = JSON.parse(
      (await kv.get(KEYS.index)) as string
    ) as PostIndex;
    expect(index.totalCount).toBe(0);
  });

  it("does not add draft posts to index", async () => {
    const kv = createMockKV();
    const post = makePost({ status: "draft" });
    await updateIndex(kv, post, "upsert");

    const index = JSON.parse(
      (await kv.get(KEYS.index)) as string
    ) as PostIndex;
    expect(index.totalCount).toBe(0);
  });

  it("replaces existing entry on upsert (no duplicates)", async () => {
    const kv = createMockKV();
    const post = makePost({ slug: "dup" });
    await updateIndex(kv, post, "upsert");
    await updateIndex(kv, { ...post, title: "Updated" }, "upsert");

    const index = JSON.parse(
      (await kv.get(KEYS.index)) as string
    ) as PostIndex;
    expect(index.totalCount).toBe(1);
    expect(index.posts[0].title).toBe("Updated");
  });

  it("sorts posts newest first", async () => {
    const kv = createMockKV();
    const old = makePost({
      slug: "old",
      publishedAt: "2024-01-01T00:00:00.000Z",
    });
    const recent = makePost({
      slug: "new",
      publishedAt: "2025-06-01T00:00:00.000Z",
    });

    await updateIndex(kv, old, "upsert");
    await updateIndex(kv, recent, "upsert");

    const index = JSON.parse(
      (await kv.get(KEYS.index)) as string
    ) as PostIndex;
    expect(index.posts[0].slug).toBe("new");
    expect(index.posts[1].slug).toBe("old");
  });
});

// ============================================================================
// Config
// ============================================================================

describe("getConfig / putConfig", () => {
  it("round-trips config through KV", async () => {
    const kv = createMockKV();
    const config: AgentCMSSiteConfig = {
      name: "Test Blog",
      description: "A test blog",
      url: "https://test.com",
      language: "en",
      writingGuidelines: {
        tone: "casual",
        targetAudience: "developers",
        preferredLength: "medium",
      },
      seo: { titleTemplate: "%s | Test" },
      moderation: { autoPublish: true },
    };

    await putConfig(kv, config);
    const result = await getConfig(kv);
    expect(result).toEqual(config);
  });

  it("returns null when no config exists", async () => {
    const kv = createMockKV();
    const result = await getConfig(kv);
    expect(result).toBeNull();
  });
});

// ============================================================================
// Auth
// ============================================================================

describe("hashApiKey", () => {
  it("returns a 64-character hex string", async () => {
    const hash = await hashApiKey("acms_live_test123");
    expect(hash).toMatch(/^[0-9a-f]{64}$/);
  });

  it("returns consistent hashes", async () => {
    const h1 = await hashApiKey("same-key");
    const h2 = await hashApiKey("same-key");
    expect(h1).toBe(h2);
  });

  it("returns different hashes for different keys", async () => {
    const h1 = await hashApiKey("key-a");
    const h2 = await hashApiKey("key-b");
    expect(h1).not.toBe(h2);
  });
});

describe("validateApiKey", () => {
  it("returns null for missing auth header", async () => {
    const kv = createMockKV();
    expect(await validateApiKey(kv, null)).toBeNull();
  });

  it("returns null for non-Bearer auth", async () => {
    const kv = createMockKV();
    expect(await validateApiKey(kv, "Basic abc123")).toBeNull();
  });

  it("returns null for unregistered key", async () => {
    const kv = createMockKV();
    expect(await validateApiKey(kv, "Bearer acms_live_unknown")).toBeNull();
  });

  it("returns the key record for a valid registered key", async () => {
    const kv = createMockKV();
    const apiKey = "acms_live_testkey";
    const keyHash = await hashApiKey(apiKey);
    const record = {
      name: "test",
      keyHash,
      scope: "publish",
      createdAt: "2025-01-01T00:00:00.000Z",
      rateLimit: 10,
    };
    await kv.put(KEYS.agent(keyHash), JSON.stringify(record));

    const result = await validateApiKey(kv, `Bearer ${apiKey}`);
    expect(result).not.toBeNull();
    expect(result!.name).toBe("test");
    expect(result!.scope).toBe("publish");
  });
});

// ============================================================================
// Rate Limiting
// ============================================================================

describe("checkRateLimit", () => {
  it("allows requests under the limit", async () => {
    const kv = createMockKV();
    const result = await checkRateLimit(kv, "test-hash", 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(9);
  });

  it("blocks requests at the limit", async () => {
    const kv = createMockKV();
    // Simulate being at the limit
    const hour = new Date().toISOString().slice(0, 13);
    await kv.put(KEYS.rateLimit("test-hash", hour), "10");

    const result = await checkRateLimit(kv, "test-hash", 10);
    expect(result.allowed).toBe(false);
    expect(result.remaining).toBe(0);
  });

  it("decrements remaining correctly", async () => {
    const kv = createMockKV();
    const hour = new Date().toISOString().slice(0, 13);
    await kv.put(KEYS.rateLimit("test-hash", hour), "7");

    const result = await checkRateLimit(kv, "test-hash", 10);
    expect(result.allowed).toBe(true);
    expect(result.remaining).toBe(2);
  });
});
