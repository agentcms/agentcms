import { describe, it, expect, beforeEach } from "vitest";
import { handleGetPost, handleListPosts } from "./public.js";
import {
  handlePublish,
  handleAgentGetPost,
  handleAgentUpdatePost,
  handleAgentDeletePost,
} from "./agent.js";
import { hashApiKey, KEYS } from "../utils/kv.js";
import type { AgentKeyScope } from "../types.js";
import type { AgentCMSEnv } from "./public.js";

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
    list: async ({ prefix = "" }: { prefix?: string } = {}) => ({
      keys: [...store.keys()].filter((k) => k.startsWith(prefix)).map((name) => ({ name })),
      list_complete: true,
    }),
  } as unknown as KVNamespace;
}

// biome-ignore lint/suspicious/noExplicitAny: test reads arbitrary JSON bodies
const read = (res: Response | Promise<Response>): Promise<any> => Promise.resolve(res).then((r) => r.json());

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

async function publish(key: string, body: Record<string, unknown>) {
  return handlePublish(req("POST", "/api/agent/publish", key, body), env);
}
const update = (key: string, slug: string, body: unknown) =>
  handleAgentUpdatePost(req("PUT", `/api/agent/posts/${slug}`, key, body), env, slug);
const publicGet = (slug: string) => handleGetPost(req("GET", `/api/posts/${slug}`), env, slug);

beforeEach(async () => {
  env = { AGENTCMS_KV: createKV() };
  await addKey("pub", "publish");
  await addKey("draft", "draft-only");
});

describe("public handlers sanitize what they serve", () => {
  it("renders markdown and strips raw HTML from the body", async () => {
    await publish("pub", {
      title: "Hello world",
      slug: "hello",
      content: `${BODY}\n\n<img src=x onerror="alert(1)"><script>alert(2)</script>`,
    });
    const post = await read(publicGet("hello"));
    expect(post.contentHtml).toContain("<p>");
    expect(post.contentHtml).not.toMatch(/onerror|<script/i);
  });

  it("sanitizes a contentHtml stored through PUT instead of trusting it", async () => {
    await publish("pub", { title: "Hello world", slug: "hello", content: BODY });
    await update("pub", "hello", { contentHtml: '<p>ok</p><iframe src="https://x"></iframe>' });
    const post = await read(publicGet("hello"));
    expect(post.contentHtml).toBe("<p>ok</p>");

    const list = await read(handleListPosts(req("GET", "/api/posts"), env));
    expect(list.posts[0].contentHtml).toBe("<p>ok</p>");
  });
});

describe("draft lifecycle through the handlers", () => {
  it("demoting a published post takes it off its public URL", async () => {
    await publish("pub", { title: "Hello world", slug: "hello", content: BODY });
    expect((await publicGet("hello")).status).toBe(200);

    expect((await update("pub", "hello", { status: "draft" })).status).toBe(200);
    expect((await publicGet("hello")).status).toBe(404);
  });

  it("a draft-only key cannot edit, and so cannot unpublish, a published post", async () => {
    await publish("pub", { title: "Hello world", slug: "hello", content: BODY });
    const res = await update("draft", "hello", { title: "Defaced title" });
    expect(res.status).toBe(403);
    const post = await read(publicGet("hello"));
    expect(post.title).toBe("Hello world");
  });

  it("a draft-only key can read and revise its own draft", async () => {
    await publish("draft", { title: "My draft post", slug: "mine", content: BODY });
    expect((await publicGet("mine")).status).toBe(404);

    expect((await update("draft", "mine", { title: "Revised draft" })).status).toBe(200);
    const res = await handleAgentGetPost(req("GET", "/api/agent/posts/mine", "draft"), env, "mine");
    expect(await read(res)).toMatchObject({ title: "Revised draft", status: "draft" });
  });

  it("a draft-only key cannot publish its draft", async () => {
    await publish("draft", { title: "My draft post", slug: "mine", content: BODY });
    await update("draft", "mine", { status: "published" });
    expect((await publicGet("mine")).status).toBe(404);
  });

  it("publishing over an existing draft's slug is a 409, not an overwrite", async () => {
    await publish("draft", { title: "My draft post", slug: "mine", content: BODY });
    expect((await publish("draft", { title: "Another one", slug: "mine", content: BODY })).status).toBe(409);
  });

  it("drafts can be deleted", async () => {
    await publish("draft", { title: "My draft post", slug: "mine", content: BODY });
    const res = await handleAgentDeletePost(req("DELETE", "/api/agent/posts/mine", "pub"), env, "mine");
    expect(res.status).toBe(200);
  });
});

describe("original dates on publish and update", () => {
  const OLD = "2021-03-04T05:06:07.000Z";
  const stored = (slug: string) =>
    read(handleAgentGetPost(req("GET", `/api/agent/posts/${slug}`, "admin"), env, slug));

  beforeEach(() => addKey("admin", "admin"));

  it("an admin key keeps the original publishedAt, and updatedAt defaults to it", async () => {
    const res = await publish("admin", { title: "An old post", slug: "old", content: BODY, publishedAt: OLD });
    expect(res.status).toBe(201);
    expect(await stored("old")).toMatchObject({ publishedAt: OLD, updatedAt: OLD });
  });

  it("normalizes an offset date to UTC", async () => {
    await publish("admin", { title: "An old post", slug: "old", content: BODY, publishedAt: "2021-03-04T07:06:07+02:00" });
    expect((await stored("old")).publishedAt).toBe(OLD);
  });

  it("a backdated post sorts by its date in listings, not by when it was imported", async () => {
    await publish("pub", { title: "A new post", slug: "new", content: BODY });
    await publish("admin", { title: "An old post", slug: "old", content: BODY, publishedAt: OLD });
    const list = await read(handleListPosts(req("GET", "/api/posts"), env));
    expect(list.posts.map((p: { slug: string }) => p.slug)).toEqual(["new", "old"]);
  });

  it("a publish key cannot set dates, and nothing is written", async () => {
    const res = await publish("pub", { title: "An old post", slug: "old", content: BODY, publishedAt: OLD });
    expect(res.status).toBe(403);
    expect((await publicGet("old")).status).toBe(404);
    expect((await update("pub", "old", { updatedAt: OLD })).status).toBe(404);
  });

  it("rejects a future date and an updatedAt before publishedAt", async () => {
    const future = new Date(Date.now() + 86_400_000).toISOString();
    expect((await publish("admin", { title: "Future post", slug: "f", content: BODY, publishedAt: future })).status).toBe(422);
    const res = await publish("admin", {
      title: "Backwards post",
      slug: "b",
      content: BODY,
      publishedAt: OLD,
      updatedAt: "2020-01-01T00:00:00Z",
    });
    expect(res.status).toBe(422);
  });

  it("an admin can correct the dates of an existing post; others cannot", async () => {
    await publish("pub", { title: "Imported post", slug: "imp", content: BODY });
    expect((await update("pub", "imp", { publishedAt: OLD })).status).toBe(403);
    expect((await update("admin", "imp", { publishedAt: OLD, updatedAt: OLD })).status).toBe(200);
    expect(await stored("imp")).toMatchObject({ publishedAt: OLD, updatedAt: OLD });
    expect((await update("admin", "imp", { updatedAt: "2020-01-01T00:00:00Z" })).status).toBe(422);
  });

  it("rejects updatedAt when there is no publish date to order it after", async () => {
    const res = await publish("admin", { title: "New post", slug: "n", content: BODY, updatedAt: OLD });
    expect(res.status).toBe(422);
    await publish("admin", { title: "Draft post", slug: "d", content: BODY, status: "draft" });
    expect((await update("admin", "d", { status: "published", updatedAt: OLD })).status).toBe(422);
    expect((await publicGet("d")).status).toBe(404);
  });

  it("publishing a draft keeps a publishedAt given in the same update", async () => {
    await publish("admin", { title: "Draft post", slug: "d", content: BODY, status: "draft" });
    await update("admin", "d", { status: "published", publishedAt: OLD });
    expect((await stored("d")).publishedAt).toBe(OLD);
  });

  it("stores contentHtml given on publish, and serves it sanitized", async () => {
    await publish("pub", { title: "Html post", slug: "h", content: BODY, contentHtml: "<p>hi</p><script>x</script>" });
    expect((await read(publicGet("h"))).contentHtml).toBe("<p>hi</p>");
  });
});
