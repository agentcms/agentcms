// ============================================================================
// AgentCMS — Agent Handlers (auth-required)
// ============================================================================
//
// Framework-agnostic HTTP handlers for AI agent operations.
// Same logic as src/routes/api/*.ts but without Astro types or cloudflare:workers.
//
// ============================================================================

import { z } from "zod";
import type { AgentCMSPost, AgentSkillDefinition } from "../types.js";
import {
  validateApiKey,
  checkRateLimit,
  getPost,
  putPost,
  deletePost,
  updateIndex,
  getIndex,
  getConfig,
} from "../utils/kv.js";
import {
  slugify,
  calculateReadingTime,
  generateDescription,
} from "../utils/content.js";
import { sendWebhook } from "../utils/webhook.js";
import type { AgentCMSEnv } from "./public.js";

// --- Schemas ---

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

// --- Helpers ---

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

const SLUG_REGEX = /^[a-z0-9-]+$/;
const SLUG_MAX_LEN = 80;
const MAX_UPLOAD_SIZE = 10 * 1024 * 1024; // 10 MB

function isValidSlug(slug: string | undefined): slug is string {
  return (
    typeof slug === "string" &&
    slug.length > 0 &&
    slug.length <= SLUG_MAX_LEN &&
    SLUG_REGEX.test(slug)
  );
}

function sanitizeFilename(name: string): string {
  return name
    .toLowerCase()
    .replace(/[^a-z0-9._-]/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

async function shortHash(buffer: ArrayBuffer): Promise<string> {
  const hashBuffer = await crypto.subtle.digest("SHA-256", buffer);
  const hashArray = Array.from(new Uint8Array(hashBuffer).slice(0, 4));
  return hashArray.map((b) => b.toString(16).padStart(2, "0")).join("");
}

// --- Handlers ---

/**
 * POST /api/agent/publish — Create a new blog post.
 */
export async function handlePublish(
  request: Request,
  env: AgentCMSEnv
): Promise<Response> {
  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;

  // Auth
  const agent = await validateApiKey(kv, request.headers.get("Authorization"), pfx);
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);
  if (agent.scope === "read-only")
    return json({ error: "API key does not have write access" }, 403);

  // Rate limit
  const { allowed, remaining } = await checkRateLimit(kv, agent.keyHash, agent.rateLimit, pfx);
  if (!allowed) return json({ error: "Rate limit exceeded" }, 429);

  // Parse & validate
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

  // Check slug collision
  const existing = await getPost(kv, slug, pfx);
  if (existing) return json({ error: "Slug already exists", slug }, 409);

  // Determine effective status
  let effectiveStatus = data.status;
  if (agent.scope === "draft-only") effectiveStatus = "draft";

  // Build post
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

  await putPost(kv, post, pfx);
  if (effectiveStatus === "published") await updateIndex(kv, post, "upsert", pfx);

  const siteUrl = new URL(request.url).origin;
  sendWebhook(kv, "post.published", post, siteUrl, pfx).catch(() => {});

  return json(
    {
      success: true,
      slug,
      url: `${siteUrl}/blog/${slug}`,
      status: effectiveStatus,
      publishedAt: post.publishedAt || null,
      remainingRequests: remaining,
    },
    201
  );
}

/**
 * GET /api/agent/posts — List posts (for agents to check existing content).
 */
export async function handleAgentListPosts(
  request: Request,
  env: AgentCMSEnv
): Promise<Response> {
  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;

  const agent = await validateApiKey(kv, request.headers.get("Authorization"), pfx);
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  const url = new URL(request.url);
  const limit = Math.min(
    100,
    Math.max(1, parseInt(url.searchParams.get("limit") ?? "20", 10) || 20)
  );
  const offset = Math.max(
    0,
    parseInt(url.searchParams.get("offset") ?? "0", 10) || 0
  );
  const tag = url.searchParams.get("tag") || undefined;
  const category = url.searchParams.get("category") || undefined;

  const index = await getIndex(kv, pfx);
  let posts = index.posts;

  if (tag) posts = posts.filter((p) => p.tags.includes(tag));
  if (category) posts = posts.filter((p) => p.category === category);

  const total = posts.length;
  const page = posts.slice(offset, offset + limit);

  return json({ posts: page, total, limit, offset, hasMore: offset + limit < total });
}

/**
 * GET /api/agent/posts/:slug — Get full post content.
 */
export async function handleAgentGetPost(
  request: Request,
  env: AgentCMSEnv,
  slug: string
): Promise<Response> {
  if (!isValidSlug(slug)) return json({ error: "Invalid slug" }, 400);

  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;
  const agent = await validateApiKey(kv, request.headers.get("Authorization"), pfx);
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  const post = await getPost(kv, slug, pfx);
  if (!post) return json({ error: "Post not found" }, 404);

  return json(post);
}

/**
 * PUT /api/agent/posts/:slug — Update an existing post.
 */
export async function handleAgentUpdatePost(
  request: Request,
  env: AgentCMSEnv,
  slug: string
): Promise<Response> {
  if (!isValidSlug(slug)) return json({ error: "Invalid slug" }, 400);

  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;
  const agent = await validateApiKey(kv, request.headers.get("Authorization"), pfx);
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);
  if (agent.scope === "read-only")
    return json({ error: "API key does not have write access" }, 403);

  const { allowed, remaining } = await checkRateLimit(kv, agent.keyHash, agent.rateLimit, pfx);
  if (!allowed) return json({ error: "Rate limit exceeded" }, 429);

  const existing = await getPost(kv, slug, pfx);
  if (!existing) return json({ error: "Post not found" }, 404);

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
  if (agent.scope === "draft-only") data.status = "draft";

  const now = new Date().toISOString();
  const updated: AgentCMSPost = {
    ...existing,
    ...data,
    featuredImage:
      data.featuredImage === null
        ? undefined
        : (data.featuredImage ?? existing.featuredImage),
    ogImage:
      data.ogImage === null
        ? undefined
        : (data.ogImage ?? existing.ogImage),
    slug: existing.slug,
    author: existing.author,
    authorType: existing.authorType,
    updatedAt: now,
  };

  if (data.content) {
    updated.readingTime = calculateReadingTime(data.content);
    if (!data.description) {
      updated.description =
        existing.description || generateDescription(data.content);
    }
  }

  if (data.status === "published" && !existing.publishedAt) {
    updated.publishedAt = now;
  }

  await putPost(kv, updated, pfx);
  await updateIndex(kv, updated, "upsert", pfx);

  const siteUrl = new URL(request.url).origin;
  sendWebhook(kv, "post.updated", updated, siteUrl, pfx).catch(() => {});

  return json({
    success: true,
    slug: updated.slug,
    status: updated.status,
    remainingRequests: remaining,
  });
}

/**
 * DELETE /api/agent/posts/:slug — Delete a post.
 */
export async function handleAgentDeletePost(
  request: Request,
  env: AgentCMSEnv,
  slug: string
): Promise<Response> {
  if (!isValidSlug(slug)) return json({ error: "Invalid slug" }, 400);

  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;
  const agent = await validateApiKey(kv, request.headers.get("Authorization"), pfx);
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  if (agent.scope !== "admin" && agent.scope !== "publish") {
    return json({ error: "Requires publish or admin scope" }, 403);
  }

  const { allowed, remaining } = await checkRateLimit(kv, agent.keyHash, agent.rateLimit, pfx);
  if (!allowed) return json({ error: "Rate limit exceeded" }, 429);

  const existing = await getPost(kv, slug, pfx);
  if (!existing) return json({ error: "Post not found" }, 404);

  await deletePost(kv, slug, pfx);
  await updateIndex(kv, existing, "remove", pfx);

  const siteUrl = new URL(request.url).origin;
  sendWebhook(kv, "post.deleted", existing, siteUrl, pfx).catch(() => {});

  return json({
    success: true,
    deleted: slug,
    remainingRequests: remaining,
  });
}

/**
 * GET /api/agent/context — Site context for agents to understand before writing.
 */
export async function handleAgentContext(
  request: Request,
  env: AgentCMSEnv
): Promise<Response> {
  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;

  const agent = await validateApiKey(kv, request.headers.get("Authorization"), pfx);
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  const config = await getConfig(kv, pfx);
  const index = await getIndex(kv, pfx);
  const recentPosts = index.posts.slice(0, 15);

  const allTags = [...new Set(recentPosts.flatMap((p) => p.tags))];
  const allCategories = [
    ...new Set(recentPosts.map((p) => p.category).filter(Boolean)),
  ];

  return json({
    site: {
      name: config?.name || "Blog",
      description: config?.description || "",
      url: new URL(request.url).origin,
      language: config?.language || "en",
    },
    writingGuidelines: config?.writingGuidelines || {
      tone: "informative and engaging",
      targetAudience: "general",
      preferredLength: "800-2000 words",
    },
    existingContent: {
      totalPosts: index.totalCount,
      recentTitles: recentPosts.map((p) => p.title),
      existingTags: allTags,
      existingCategories: allCategories,
    },
    capabilities: {
      maxContentLength: 50000,
      markdownFeatures: ["GFM", "code-blocks", "tables", "footnotes"],
    },
    agent: {
      name: agent.name,
      scope: agent.scope,
    },
  });
}

/**
 * POST /api/agent/upload — Upload an image to R2.
 */
export async function handleAgentUpload(
  request: Request,
  env: AgentCMSEnv
): Promise<Response> {
  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;
  const r2 = env.AGENTCMS_R2;

  if (!r2) {
    return json(
      { error: "Image storage not configured (missing R2 binding)" },
      500
    );
  }

  const agent = await validateApiKey(kv, request.headers.get("Authorization"), pfx);
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);
  if (agent.scope === "read-only")
    return json({ error: "API key does not have write access" }, 403);

  const { allowed, remaining } = await checkRateLimit(kv, agent.keyHash, agent.rateLimit, pfx);
  if (!allowed) return json({ error: "Rate limit exceeded" }, 429);

  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json(
      { error: "Expected multipart/form-data with a 'file' field" },
      400
    );
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return json({ error: "Missing 'file' field in form data" }, 400);
  }

  if (!file.type.startsWith("image/")) {
    return json({ error: "Only image files are allowed" }, 422);
  }
  if (file.size > MAX_UPLOAD_SIZE) {
    return json(
      { error: `File too large (max ${MAX_UPLOAD_SIZE / 1024 / 1024}MB)` },
      422
    );
  }

  const buffer = await file.arrayBuffer();
  const hash = await shortHash(buffer);
  const safeName = sanitizeFilename(file.name || "image");
  const key = `${hash}-${safeName}`;

  await r2.put(key, buffer, { httpMetadata: { contentType: file.type } });

  return json(
    {
      success: true,
      url: `/images/${key}`,
      contentType: file.type,
      size: file.size,
      remainingRequests: remaining,
    },
    201
  );
}

/**
 * GET /.well-known/agent-skill.json — Machine-readable skill definition.
 */
export async function handleSkill(request: Request): Promise<Response> {
  const baseUrl = new URL(request.url).origin;

  const skill: AgentSkillDefinition = {
    $schema: "https://agentcms.dev/skill-schema/v1.json",
    name: "AgentCMS Blog",
    version: "1.0.0",
    description:
      "Publish blog posts to this website. Supports markdown content, tags, categories, and scheduled publishing.",
    baseUrl,
    authentication: {
      type: "bearer",
      header: "Authorization",
      description: "Provide your agent API key as a Bearer token",
    },
    capabilities: [
      {
        name: "get_site_context",
        method: "GET",
        path: "/api/agent/context",
        description:
          "Get site metadata, writing guidelines, tone, categories, and recent topics. ALWAYS call this before writing to ensure your post fits the site.",
      },
      {
        name: "list_posts",
        method: "GET",
        path: "/api/agent/posts",
        description:
          "List existing posts. Check before writing to avoid duplicates. Query params: limit, offset, tag, category.",
      },
      {
        name: "publish_post",
        method: "POST",
        path: "/api/agent/publish",
        description:
          "Create and publish a new blog post. Content should be well-structured markdown.",
        input: {
          type: "object",
          required: ["title", "content"],
          properties: {
            title: { type: "string", description: "Post title, 5-200 chars" },
            content: {
              type: "string",
              description: "Post body in Markdown (GFM). Min 50 chars.",
            },
            description: {
              type: "string",
              description:
                "SEO meta description. Auto-generated if omitted.",
            },
            tags: {
              type: "array",
              items: { type: "string" },
              description: "Topic tags, 1-5 recommended",
            },
            category: { type: "string" },
            status: {
              type: "string",
              enum: ["published", "draft", "scheduled"],
              default: "published",
            },
            slug: {
              type: "string",
              description:
                "Custom URL slug. Auto-generated from title if omitted.",
            },
          },
        },
        output: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            slug: { type: "string" },
            url: { type: "string" },
          },
        },
        errors: [
          { code: 401, description: "Invalid or missing API key" },
          { code: 409, description: "Slug already exists" },
          { code: 422, description: "Validation failed" },
          { code: 429, description: "Rate limit exceeded" },
        ],
      },
      {
        name: "get_post",
        method: "GET",
        path: "/api/agent/posts/{slug}",
        description: "Get full post content by slug.",
      },
      {
        name: "update_post",
        method: "PUT",
        path: "/api/agent/posts/{slug}",
        description:
          "Update an existing post. Partial updates — only include fields to change.",
      },
      {
        name: "delete_post",
        method: "DELETE",
        path: "/api/agent/posts/{slug}",
        description: "Delete a post. Requires publish or admin scope.",
      },
      {
        name: "upload_image",
        method: "POST",
        path: "/api/agent/upload",
        description:
          "Upload an image file. Returns a URL path you can use in featuredImage or markdown content. Max 10MB, image/* only.",
        input: {
          type: "object",
          required: ["file"],
          properties: {
            file: {
              type: "string",
              format: "binary",
              description: "Image file (multipart/form-data)",
            },
          },
        },
        output: {
          type: "object",
          properties: {
            success: { type: "boolean" },
            url: {
              type: "string",
              description: "Relative URL path like /images/{key}",
            },
            contentType: { type: "string" },
            size: { type: "number" },
          },
        },
        errors: [
          { code: 401, description: "Invalid or missing API key" },
          { code: 422, description: "Invalid file type or too large" },
          { code: 429, description: "Rate limit exceeded" },
        ],
      },
    ],
    setup: {
      description:
        "AgentCMS runs on Cloudflare Workers with KV for posts and R2 for images.",
      steps: [
        {
          title: "Install wrangler CLI",
          commands: ["npm install -g wrangler", "wrangler login"],
          description:
            "Wrangler is Cloudflare's CLI for managing Workers, KV, and R2.",
        },
        {
          title: "Create a KV namespace for blog data",
          commands: ["npx wrangler kv namespace create AGENTCMS_KV"],
          description:
            'Stores posts, index, config, and API keys. Add the namespace ID to wrangler.toml under [[kv_namespaces]] with binding = "AGENTCMS_KV".',
        },
        {
          title: "Create an R2 bucket for image storage",
          commands: ["npx wrangler r2 bucket create agentcms-images"],
          description:
            'Add [[r2_buckets]] to wrangler.toml with binding = "AGENTCMS_R2" and bucket_name = "agentcms-images".',
        },
        {
          title: "Generate an agent API key",
          commands: [
            'npx @agentcms/agentcms keygen --name "my-agent" --scope publish',
          ],
          description:
            "Use the returned key as a Bearer token in the Authorization header.",
        },
      ],
    },
    guidelines: {
      tone: "Check /api/agent/context for site-specific guidelines",
      contentPolicy: "No spam, no duplicates, no harmful content",
      rateLimit: "10 posts per hour per key (configurable)",
      bestPractices: [
        "Always call get_site_context first to understand the site's voice",
        "Check list_posts to avoid duplicate topics",
        "Include 2-5 relevant tags",
        "Write substantive content (500+ words recommended)",
        "Provide a custom description for better SEO",
        "Set X-Agent-Model header for traceability",
        "Upload images before publishing, then reference the returned URL",
      ],
    },
  };

  return new Response(JSON.stringify(skill, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
}
