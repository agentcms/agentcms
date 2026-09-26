import { describe, it, expect, beforeEach, vi, afterEach } from "vitest";
import { handleGetPost, handleListPosts, handleImage } from "./public.js";
import {
  handlePublish,
  handleAgentUpdatePost,
  handleAgentDeletePost,
  handleAgentContext,
  handleAgentListPosts,
} from "./agent.js";
import { hashApiKey, KEYS, getIndex } from "../utils/kv.js";
import type { AgentKeyScope } from "../types.js";
import type { AgentCMSEnv } from "./public.js";
import { createAgentCMSRouter } from "../cloudflare/index.js";
import { createAgentCMSWorker } from "../worker/index.js";
import { agentcmsLoader } from "../loader/index.js";
import { detectProjectApiRoutes } from "../integration/index.js";
import { join, normalize } from "node:path";

function createKV(): KVNamespace {
  const store = new Map<string, string>();
  return {
    get: async (key: string, type?: string) => {
      const v = store.get(key);
      if (v === undefined) return null;
      return type === "json" ? JSON.parse(v) : v;
    },
    put: async (key: string, value: string) => void store.set(key, value),
    delete: async (key: string) => void store.delete(key),
  } as unknown as KVNamespace;
}

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON bodies
const read = (res: Response | Promise<Response | null>): Promise<any> =>
  Promise.resolve(res).then((r) => r!.json());

const BODY = "This body is long enough to pass the fifty character minimum length.";
let env: AgentCMSEnv;

async function addKey(key: string, scope: AgentKeyScope) {
  const keyHash = await hashApiKey(key);
  await env.AGENTCMS_KV.put(
    KEYS.agent(keyHash),
    JSON.stringify({ name: scope, keyHash, scope, createdAt: "", rateLimit: 1000 })
  );
}

const req = (method: string, path: string, key?: string, body?: unknown) =>
  new Request(`https://site.example${path}`, {
    method,
    headers: {
      "Content-Type": "application/json",
      ...(key ? { Authorization: `Bearer ${key}` } : {}),
    },
    body: body === undefined ? undefined : JSON.stringify(body),
  });

const publish = (body: Record<string, unknown>, key = "pub") =>
  handlePublish(req("POST", "/api/agent/publish", key, body), env);
const update = (slug: string, body: unknown, key = "pub") =>
  handleAgentUpdatePost(req("PUT", `/api/agent/posts/${slug}`, key, body), env, slug);
const list = (query = "") => read(handleListPosts(req("GET", `/api/posts${query}`), env));

async function setLanguages(languages: string[]) {
  await env.AGENTCMS_KV.put(KEYS.config, JSON.stringify({ name: "Site", languages }));
}

beforeEach(async () => {
  env = { AGENTCMS_KV: createKV() };
  await addKey("pub", "publish");
  await addKey("admin", "admin");
});

describe("translations", () => {
  it("links language versions through translationKey and lists them on each", async () => {
    await setLanguages(["en", "de"]);
    await publish({ title: "Hello world", slug: "hello", content: BODY, lang: "en", translationKey: "hello" });
    await publish({ title: "Hallo Welt", slug: "hallo", content: BODY, lang: "de", translationKey: "hello" });

    const post = await read(handleGetPost(req("GET", "/api/posts/hallo"), env, "hallo"));
    expect(post.lang).toBe("de");
    expect(post.translations).toEqual([
      { lang: "de", slug: "hallo", title: "Hallo Welt" },
      { lang: "en", slug: "hello", title: "Hello world" },
    ]);
  });

  it("rejects a second post in the same language for one article", async () => {
    await publish({ title: "Hello world", slug: "hello", content: BODY, lang: "en", translationKey: "hello" });
    const res = await publish({ title: "Hello again", slug: "hello-2", content: BODY, lang: "en", translationKey: "hello" });
    expect(res.status).toBe(409);
    expect((await read(res)).slug).toBe("hello");
  });

  it("counts a post without lang as the site's default language", async () => {
    await setLanguages(["en", "de"]);
    await publish({ title: "Hello world", slug: "hello", content: BODY, translationKey: "hello" });
    expect((await publish({ title: "Hello again", slug: "hello-2", content: BODY, lang: "en", translationKey: "hello" })).status).toBe(409);
    expect((await list("?lang=en")).posts.map((p: { slug: string }) => p.slug)).toEqual(["hello"]);
  });

  it("rejects a language the site does not publish in", async () => {
    await setLanguages(["en", "de"]);
    expect((await publish({ title: "Bonjour monde", content: BODY, lang: "fr" })).status).toBe(422);
  });

  it("rejects a malformed language tag", async () => {
    expect((await publish({ title: "Hello world", content: BODY, lang: "english" })).status).toBe(422);
  });

  it("an update may not move a post into a language its article already has", async () => {
    await publish({ title: "Hello world", slug: "hello", content: BODY, lang: "en", translationKey: "hello" });
    await publish({ title: "Hallo Welt", slug: "hallo", content: BODY, lang: "de", translationKey: "hello" });
    expect((await update("hallo", { lang: "en" })).status).toBe(409);
    // Re-saving a post in its own language is not a clash with itself.
    expect((await update("hallo", { title: "Hallo, Welt" })).status).toBe(200);
  });

  it("null clears lang and translationKey on update", async () => {
    await publish({ title: "Hello world", slug: "hello", content: BODY, lang: "en", translationKey: "hello" });
    expect((await update("hello", { lang: null, translationKey: null })).status).toBe(200);
    const post = await read(handleGetPost(req("GET", "/api/posts/hello"), env, "hello"));
    expect(post.lang).toBeUndefined();
    expect(post.translationKey).toBeUndefined();
    expect((await getIndex(env.AGENTCMS_KV)).posts[0].translationKey).toBeUndefined();
  });

  it("filters the agent list by lang and translationKey", async () => {
    await publish({ title: "Hello world", slug: "hello", content: BODY, lang: "en", translationKey: "hello" });
    await publish({ title: "Hallo Welt", slug: "hallo", content: BODY, lang: "de", translationKey: "hello" });
    await publish({ title: "Other post", slug: "other", content: BODY, lang: "de" });
    const res = await read(handleAgentListPosts(req("GET", "/api/agent/posts?lang=de&translationKey=hello", "pub"), env));
    expect(res.posts.map((p: { slug: string }) => p.slug)).toEqual(["hallo"]);
  });
});

describe("public list: since and full", () => {
  it("since keeps posts updated at or after the date", async () => {
    await publish({ title: "Old post one", slug: "old", content: BODY, publishedAt: "2020-01-01T00:00:00Z" }, "admin");
    await publish({ title: "New post one", slug: "new", content: BODY });
    expect((await list("?since=2024-01-01T00:00:00Z")).posts.map((p: { slug: string }) => p.slug)).toEqual(["new"]);
  });

  it("an unparsable since is a 400", async () => {
    expect((await handleListPosts(req("GET", "/api/posts?since=yesterday"), env)).status).toBe(400);
  });

  it("full=1 includes rendered, sanitized contentHtml for every post", async () => {
    await publish({ title: "Hello world", slug: "hello", content: `${BODY}\n\n<script>x</script>` });
    const [post] = (await list("?full=1")).posts;
    expect(post.contentHtml).toContain("<p>");
    expect(post.contentHtml).not.toContain("<script");
  });
});

describe("metadata, images and URLs", () => {
  it("stores metadata and replaces it whole on update", async () => {
    await publish({ title: "Hello world", slug: "hello", content: BODY, metadata: { source: "a", n: 1 } });
    let post = await read(handleGetPost(req("GET", "/api/posts/hello"), env, "hello"));
    expect(post.metadata).toEqual({ source: "a", n: 1 });
    await update("hello", { metadata: { source: "b" } });
    post = await read(handleGetPost(req("GET", "/api/posts/hello"), env, "hello"));
    expect(post.metadata).toEqual({ source: "b" });
  });

  it("rejects metadata over 16KB", async () => {
    const res = await publish({ title: "Hello world", content: BODY, metadata: { blob: "x".repeat(17_000) } });
    expect(res.status).toBe(422);
  });

  it("image URLs must be absolute http(s)", async () => {
    for (const featuredImage of ["/images/abc.png", "javascript:alert(1)", "ftp://x/y.png"]) {
      expect((await publish({ title: "Hello world", content: BODY, featuredImage })).status).toBe(422);
    }
    expect((await publish({ title: "Hello world", content: BODY, ogImage: "https://cdn.example/x.png" })).status).toBe(201);
  });

  it("the public post route never reads a non-slug key", async () => {
    await publish({ title: "Hello world", slug: "hello", content: BODY });
    expect((await handleGetPost(req("GET", "/api/posts/index"), env, "index")).status).toBe(404);
    expect((await handleGetPost(req("GET", "/api/posts/x"), env, "draft:hello")).status).toBe(404);
  });

  it("serves only upload-shaped image keys", async () => {
    const r2 = {
      get: vi.fn(async () => ({ body: "img", httpMetadata: { contentType: "image/png" }, httpEtag: '"e"' })),
    } as unknown as R2Bucket;
    const withR2 = { ...env, AGENTCMS_R2: r2 };
    expect((await handleImage(req("GET", "/"), withR2, "0123abcd-cat.png")).status).toBe(200);
    expect((await handleImage(req("GET", "/"), withR2, "secret.txt")).status).toBe(404);
  });

  it("context reports the site's languages and the real content limit", async () => {
    await setLanguages(["de", "en"]);
    const ctx = await read(handleAgentContext(req("GET", "/api/agent/context", "pub"), env));
    expect(ctx.site.language).toBe("de");
    expect(ctx.site.languages).toEqual(["de", "en"]);
    expect(ctx.capabilities.maxContentLength).toBe(200_000);
  });

  it("context falls back to the inline site config", async () => {
    const ctx = await read(
      handleAgentContext(req("GET", "/api/agent/context", "pub"), env, { site: { name: "Inline" } as never })
    );
    expect(ctx.site.name).toBe("Inline");
  });
});

describe("webhook delivery outlives the response", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("hands the delivery to waitUntil on publish, update and delete", async () => {
    await env.AGENTCMS_KV.put(
      KEYS.config,
      JSON.stringify({ name: "Site", moderation: { notifyOnPublish: "https://hooks.example/x" } })
    );
    vi.stubGlobal("fetch", vi.fn(async () => new Response("ok")));
    const waitUntil = vi.fn();
    const options = { waitUntil };

    await handlePublish(req("POST", "/api/agent/publish", "pub", { title: "Hello world", slug: "hello", content: BODY }), env, options);
    await handleAgentUpdatePost(req("PUT", "/api/agent/posts/hello", "pub", { title: "Hello there" }), env, "hello", options);
    await handleAgentDeletePost(req("DELETE", "/api/agent/posts/hello", "pub"), env, "hello", options);

    expect(waitUntil).toHaveBeenCalledTimes(3);
    // The promise handed over never rejects, so a failed hook can't surface as an unhandled rejection.
    await Promise.all(waitUntil.mock.calls.map(([p]) => p));
  });
});

describe("router and Worker entry", () => {
  it("routes public reads and agent writes, and returns null for anything else", async () => {
    const route = createAgentCMSRouter({ blogBase: "/news" });
    const res = await read(route(req("POST", "/api/agent/publish", "pub", { title: "Hello world", slug: "hello", content: BODY }), env));
    expect(res.url).toBe("https://site.example/news/hello");
    expect((await read(route(req("GET", "/api/posts"), env))).totalPosts).toBe(1);
    expect(await route(req("GET", "/about"), env)).toBeNull();
  });

  it("adds CORS to public reads for an allowed origin only", async () => {
    const route = createAgentCMSRouter({ cors: "https://front.example" });
    const allowed = new Request("https://site.example/api/posts", { headers: { Origin: "https://front.example" } });
    expect((await route(allowed, env))!.headers.get("Access-Control-Allow-Origin")).toBe("https://front.example");
    const other = new Request("https://site.example/api/posts", { headers: { Origin: "https://evil.example" } });
    expect((await route(other, env))!.headers.get("Access-Control-Allow-Origin")).toBeNull();
    const agent = new Request("https://site.example/api/agent/posts", { headers: { Origin: "https://front.example" } });
    expect((await route(agent, env))!.headers.get("Access-Control-Allow-Origin")).toBeNull();
  });

  it("the Worker 404s what it does not own and passes waitUntil through", async () => {
    await env.AGENTCMS_KV.put(
      KEYS.config,
      JSON.stringify({ name: "Site", moderation: { notifyOnPublish: "https://hooks.example/x" } })
    );
    const fetchStub = vi.fn(async () => new Response("ok"));
    vi.stubGlobal("fetch", fetchStub);
    const worker = createAgentCMSWorker();
    const ctx = { waitUntil: vi.fn(), passThroughOnException: () => {} } as unknown as ExecutionContext;
    const call = (r: Request) => worker.fetch!(r as never, env, ctx) as Promise<Response>;

    expect((await call(req("GET", "/nope"))).status).toBe(404);
    expect((await call(req("POST", "/api/agent/publish", "pub", { title: "Hello world", content: BODY }))).status).toBe(201);
    expect(ctx.waitUntil).toHaveBeenCalledTimes(1);
    vi.unstubAllGlobals();
  });
});

describe("live loader over HTTP", () => {
  afterEach(() => vi.unstubAllGlobals());

  it("loads entries with rendered HTML and cache tags from a remote AgentCMS", async () => {
    await publish({ title: "Hello world", slug: "hello", content: BODY, tags: ["x"] });
    const route = createAgentCMSRouter();
    const seen: string[] = [];
    vi.stubGlobal("fetch", async (url: string) => {
      seen.push(url);
      return (await route(new Request(url), env)) ?? new Response(null, { status: 404 });
    });

    const loader = agentcmsLoader({ url: "https://cms.example/" });
    const collection = await loader.loadCollection({ collection: "posts", filter: { tag: "x", lang: "en" } });
    if ("error" in collection) throw collection.error;
    expect(seen[0]).toBe("https://cms.example/api/posts?full=1&limit=100&tag=x&lang=en");
    expect(collection.entries[0].id).toBe("hello");
    expect(collection.entries[0].rendered?.html).toContain("<p>");
    expect(collection.cacheHint?.tags).toEqual(["agentcms:posts"]);

    const entry = await loader.loadEntry({ collection: "posts", filter: { id: "hello" } });
    expect(entry && "id" in entry && entry.cacheHint?.tags).toEqual(["agentcms:posts", "agentcms:post:hello"]);
    expect(await loader.loadEntry({ collection: "posts", filter: { id: "missing" } })).toBeUndefined();
    expect(await loader.loadEntry({ collection: "posts", filter: { id: "../x" } })).toBeUndefined();
  });

  it("returns an error, not a throw, when the API fails", async () => {
    vi.stubGlobal("fetch", async () => new Response("boom", { status: 500 }));
    const result = await agentcmsLoader({ url: "https://cms.example" }).loadCollection({ collection: "posts" });
    expect("error" in result && result.error.message).toContain("HTTP 500");
  });
});

describe("detectProjectApiRoutes", () => {
  it("leaves /api/posts to a project that has any page under it", async () => {
    const files = new Set([join("/p/src/pages/api/posts"), join("/p/src/pages/api/tags.ts")]);
    const owned = await detectProjectApiRoutes("/p/src", (f) => files.has(normalize(f)));
    expect([...owned].sort()).toEqual(["posts", "tags"]);
  });
});
