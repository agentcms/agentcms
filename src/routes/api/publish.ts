// ============================================================================
// POST /api/agent/publish — Create a new blog post
// ============================================================================

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { z } from "zod";
import type { AgentCMSPost } from "../../types.js";
import { validateApiKey, checkRateLimit, putPost, updateIndex, getPost, KEYS } from "../../utils/kv.js";
import { slugify, calculateReadingTime, generateDescription } from "../../utils/content.js";
import { sendWebhook } from "../../utils/webhook.js";

const PublishSchema = z.object({
  title: z.string().min(5).max(200),
  content: z.string().min(50),
  description: z.string().max(300).optional(),
  tags: z.array(z.string()).max(10).default([]),
  category: z.string().optional(),
  status: z.enum(["published", "draft", "scheduled"]).default("published"),
  scheduledFor: z.string().datetime().optional(),
  featuredImage: z.string().url().optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(80)
    .optional(),
  featured: z.boolean().default(false),
});

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const POST: APIRoute = async ({ request }) => {
  const bindingName = globalThis.__AGENTCMS_CONFIG__?.kvBinding || "AGENTCMS_KV";
  const kv = (env as Record<string, unknown>)[bindingName] as KVNamespace;

  // --- Auth ---
  const agent = await validateApiKey(kv, request.headers.get("Authorization"));
  if (!agent) {
    return json({ error: "Invalid or missing API key" }, 401);
  }

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

  // --- Parse & validate ---
  let body: unknown;
  try {
    body = await request.json();
  } catch {
    return json({ error: "Invalid JSON body" }, 400);
  }

  const parsed = PublishSchema.safeParse(body);
  if (!parsed.success) {
    return json(
      { error: "Validation failed", details: parsed.error.flatten() },
      422
    );
  }

  const data = parsed.data;
  const slug = data.slug || slugify(data.title);
  const now = new Date().toISOString();

  // --- Check slug collision ---
  const existing = await getPost(kv, slug);
  if (existing) {
    return json({ error: "Slug already exists", slug }, 409);
  }

  // --- Determine effective status ---
  let effectiveStatus = data.status;
  if (agent.scope === "draft-only") {
    effectiveStatus = "draft";
  }

  // --- Build post ---
  const post: AgentCMSPost = {
    slug,
    title: data.title,
    description: data.description || generateDescription(data.content),
    content: data.content,
    author: agent.name,
    authorType: "agent",
    tags: data.tags,
    category: data.category,
    publishedAt: effectiveStatus === "published" ? now : "",
    updatedAt: now,
    status: effectiveStatus,
    scheduledFor: data.scheduledFor,
    featuredImage: data.featuredImage,
    readingTime: calculateReadingTime(data.content),
    featured: data.featured,
    metadata: {},
    agentMetadata: {
      model: request.headers.get("X-Agent-Model") || "unknown",
      generatedAt: now,
    },
  };

  // --- Write ---
  await putPost(kv, post);

  if (effectiveStatus === "published") {
    await updateIndex(kv, post);
  }

  const siteUrl = new URL(request.url).origin;
  const basePath = globalThis.__AGENTCMS_CONFIG__?.basePath || "/blog";

  // Webhook — fire and forget
  sendWebhook(kv, "post.published", post, siteUrl).catch(() => {});

  return json(
    {
      success: true,
      slug,
      url: `${siteUrl}${basePath}/${slug}`,
      status: effectiveStatus,
      publishedAt: post.publishedAt || null,
      remainingRequests: remaining,
    },
    201
  );
};
