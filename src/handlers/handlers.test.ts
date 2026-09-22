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
