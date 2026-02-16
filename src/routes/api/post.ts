// ============================================================================
// /api/agent/posts/[slug] — GET, PUT, DELETE a single post
// ============================================================================

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import { validateApiKey, checkRateLimit, getPost, putPost, deletePost, updateIndex } from "../../utils/kv.js";
import { sendWebhook } from "../../utils/webhook.js";
import { calculateReadingTime, generateDescription } from "../../utils/content.js";
import type { AgentCMSPost } from "../../types.js";

const UpdateSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  content: z.string().min(50).optional(),
  description: z.string().max(300).optional(),
  tags: z.array(z.string()).max(10).optional(),
  category: z.string().optional(),
  status: z.enum(["published", "draft", "scheduled"]).optional(),
  scheduledFor: z.string().datetime().optional(),
  featuredImage: z.string().url().optional().nullable(),
  ogImage: z.string().url().optional().nullable(),
  featured: z.boolean().optional(),
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SLUG_REGEX = /^[a-z0-9-]+$/;
const SLUG_MAX_LEN = 80;

function isValidSlug(slug: string | undefined): slug is string {
  return typeof slug === "string" && slug.length > 0 && slug.length <= SLUG_MAX_LEN && SLUG_REGEX.test(slug);
}

function getKV(): KVNamespace {
  const bindingName = globalThis.__AGENTCMS_CONFIG__?.kvBinding || "AGENTCMS_KV";
  return (env as Record<string, unknown>)[bindingName] as KVNamespace;
}

// --- GET ---

export const GET: APIRoute = async ({ params, request }) => {
  if (!isValidSlug(params.slug)) {
    return json({ error: "Invalid slug" }, 400);
  }
  const kv = getKV();
  const agent = await validateApiKey(kv, request.headers.get("Authorization"));
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  const post = await getPost(kv, params.slug);
  if (!post) return json({ error: "Post not found" }, 404);

  return json(post);
};

// --- PUT ---

export const PUT: APIRoute = async ({ params, request }) => {
  if (!isValidSlug(params.slug)) {
    return json({ error: "Invalid slug" }, 400);
  }
  const kv = getKV();
  const agent = await validateApiKey(kv, request.headers.get("Authorization"));
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  if (agent.scope === "read-only") {
    return json({ error: "API key does not have write access" }, 403);
  }

  // --- Rate limit ---
  const { allowed, remaining } = await checkRateLimit(
    kv,
    agent.keyHash,
    agent.rateLimit
  );
  if (!allowed) {
    return json({ error: "Rate limit exceeded" }, 429);
  }

  const existing = await getPost(kv, params.slug);
  if (!existing) return json({ error: "Post not found" }, 404);

  // --- Parse & validate ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = UpdateSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: "Validation failed", details: parsed.error.flatten() },
      422
    );
  }

  const data = parsed.data;

  // --- Enforce draft-only scope ---
  if (agent.scope === "draft-only") {
    data.status = "draft";
  }

  // --- Merge updates ---
  const now = new Date().toISOString();
  const updated: AgentCMSPost = {
    ...existing,
    ...data,
    // Nullables: allow clearing featuredImage/ogImage by passing null
    featuredImage: data.featuredImage === null ? undefined : (data.featuredImage ?? existing.featuredImage),
    ogImage: data.ogImage === null ? undefined : (data.ogImage ?? existing.ogImage),
    slug: existing.slug, // slug is immutable
    author: existing.author, // author is immutable
    authorType: existing.authorType,
    updatedAt: now,
  };

  // Recompute derived fields if content changed
  if (data.content) {
    updated.readingTime = calculateReadingTime(data.content);
    if (!data.description) {
      updated.description = existing.description || generateDescription(data.content);
    }
  }

  // Set publishedAt if transitioning to published
  if (data.status === "published" && !existing.publishedAt) {
    updated.publishedAt = now;
  }

  await putPost(kv, updated);
  await updateIndex(kv, updated);

  const siteUrl = new URL(request.url).origin;

  // Webhook — fire and forget
  sendWebhook(kv, "post.updated", updated, siteUrl).catch(() => {});

  return json({
    success: true,
    slug: updated.slug,
    status: updated.status,
    remainingRequests: remaining,
  });
};

// --- DELETE ---

export const DELETE: APIRoute = async ({ params, request }) => {
  if (!isValidSlug(params.slug)) {
    return json({ error: "Invalid slug" }, 400);
  }
  const kv = getKV();
  const agent = await validateApiKey(kv, request.headers.get("Authorization"));
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  if (agent.scope !== "admin" && agent.scope !== "publish") {
    return json({ error: "Requires publish or admin scope" }, 403);
  }

  // --- Rate limit ---
  const { allowed, remaining } = await checkRateLimit(
    kv,
    agent.keyHash,
    agent.rateLimit
  );
  if (!allowed) {
    return json({ error: "Rate limit exceeded" }, 429);
  }

  const existing = await getPost(kv, params.slug);
  if (!existing) return json({ error: "Post not found" }, 404);

  await deletePost(kv, params.slug);
  await updateIndex(kv, existing, "remove");

  const siteUrl = new URL(request.url).origin;

  // Webhook — fire and forget
  sendWebhook(kv, "post.deleted", existing, siteUrl).catch(() => {});

  return json({
    success: true,
    deleted: params.slug,
    remainingRequests: remaining,
  });
};
