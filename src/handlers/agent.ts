// ============================================================================
// AgentCMS — Agent Handlers (auth-required)
// ============================================================================
//
// Framework-agnostic HTTP handlers for AI agent operations.
// The one implementation of each endpoint: the Astro routes, the Pages middleware
// and the Worker entry all call these. No Astro types or cloudflare:workers here.
//
// ============================================================================

import { z } from "zod";
import type {
  AgentCMSPost,
  AgentCMSSiteConfig,
  AgentKeyScope,
  AgentSkillDefinition,
} from "../types.js";
import {
  validateApiKey,
  checkRateLimit,
  getPost,
  putPost,
  deletePost,
  updateIndex,
  getIndex,
} from "../utils/kv.js";
import {
  slugify,
  calculateReadingTime,
  generateDescription,
} from "../utils/content.js";
import { sendWebhook } from "../utils/webhook.js";
import { defaultLanguage } from "../utils/query.js";
import { siteConfig, type AgentCMSEnv } from "./public.js";

// --- Schemas ---

// Absolute http(s) only: these are rendered into src/href attributes and og: tags.
const httpUrl = z
  .string()
  .url()
  .refine((u) => /^https?:\/\//i.test(u), { message: "must be an http(s) URL" });

/** A BCP 47 language tag, loosely: en, de, pt-BR, zh-Hant. */
const LANG = /^[a-z]{2,3}(-[A-Za-z0-9]{2,8})*$/;
const langField = z.string().regex(LANG, "must be a language tag like en, de or pt-BR");
const translationKeyField = z.string().regex(/^[a-z0-9-]+$/).max(80);

/** Site data (e.g. towns, events), stored as-is and never rendered by AgentCMS. */
const METADATA_MAX_BYTES = 16 * 1024;
const metadataField = z
  .record(z.string(), z.unknown())
  .refine((m) => JSON.stringify(m).length <= METADATA_MAX_BYTES, {
    message: `metadata must be at most ${METADATA_MAX_BYTES} bytes as JSON`,
  });

const PublishSchema = z.object({
  title: z.string().min(5).max(200),
  content: z.string().min(50).max(200_000),
  contentHtml: z.string().max(200_000).optional(),
  description: z.string().max(300).optional(),
  tags: z.array(z.string()).max(10).default([]),
  category: z.string().optional(),
  status: z.enum(["published", "draft", "scheduled"]).default("published"),
  scheduledFor: z.string().datetime().optional(),
  featuredImage: httpUrl.optional(),
  ogImage: httpUrl.optional(),
  slug: z
    .string()
    .regex(/^[a-z0-9-]+$/)
    .max(80)
    .optional(),
  featured: z.boolean().default(false),
  noindex: z.boolean().default(false),
  canonicalUrl: httpUrl.optional(),
  lang: langField.optional(),
  translationKey: translationKeyField.optional(),
  metadata: metadataField.optional(),
  // Original dates, for migrating an existing archive (admin keys only).
  publishedAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});

const UpdateSchema = z.object({
  title: z.string().min(5).max(200).optional(),
  content: z.string().min(50).max(200_000).optional(),
  contentHtml: z.string().max(200_000).optional(),
  description: z.string().max(300).optional(),
  tags: z.array(z.string()).max(10).optional(),
  category: z.string().optional(),
  status: z.enum(["published", "draft", "scheduled"]).optional(),
  scheduledFor: z.string().datetime().optional(),
  featuredImage: httpUrl.optional().nullable(),
  ogImage: httpUrl.optional().nullable(),
  featured: z.boolean().optional(),
  noindex: z.boolean().optional(),
  canonicalUrl: httpUrl.optional().nullable(),
  lang: langField.optional().nullable(),
  translationKey: translationKeyField.optional().nullable(),
  metadata: metadataField.optional(),
  publishedAt: z.string().datetime({ offset: true }).optional(),
  updatedAt: z.string().datetime({ offset: true }).optional(),
});

// --- Helpers ---

/** Options every write handler takes from its host (Astro route, Pages middleware, Worker). */
export interface HandlerOptions {
  /** Base path of post pages, for the URL publish returns. Default "/blog". */
  basePath?: string;
  /**
   * Keeps work alive after the response is sent — `ctx.waitUntil` on Workers
   * and Pages Functions. Without it the runtime may cancel the webhook fetch
   * (e.g. a static site's deploy hook) as soon as the response goes out.
   */
  waitUntil?: (promise: Promise<unknown>) => void;
}

/** Fire a webhook without delaying the response, and without it being cancelled. */
function notify(options: HandlerOptions, delivery: Promise<unknown>): void {
  const settled = delivery.catch(() => {});
  options.waitUntil?.(settled);
}

/**
 * A post's language must be one the site publishes in (when the site lists
 * them), and an article has at most one published post per language — two
 * would leave hreflang and a language switcher pointing at either. Only a
 * post that will be public can clash: a draft never reaches the index, so a
 * replacement can be drafted, and a clashing post can be taken down.
 */
async function checkLanguage(
  env: AgentCMSEnv,
  slug: string,
  lang: string | undefined,
  translationKey: string | undefined,
  willBePublic: boolean
): Promise<Response | null> {
  if (!lang && !translationKey) return null;
  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;
  const config = await siteConfig(env);
  const languages = config?.languages;
  if (lang && languages?.length && !languages.includes(lang)) {
    return json(
      { error: `lang "${lang}" is not one of this site's languages: ${languages.join(", ")}` },
      422
    );
  }
  if (translationKey && willBePublic) {
    const defaultLang = defaultLanguage(config);
    const mine = lang ?? defaultLang;
    const index = await getIndex(kv, pfx);
    const clash = index.posts.find(
      (p) =>
        p.slug !== slug &&
        p.translationKey === translationKey &&
        (p.lang ?? defaultLang) === mine
    );
    if (clash) {
      return json(
        { error: "This article already has a published post in that language", slug: clash.slug },
        409
      );
    }
  }
  return null;
}

/** Allowed clock skew when checking that a supplied date is not in the future. */
const CLOCK_SKEW_MS = 60_000;

/**
 * Check caller-supplied publishedAt/updatedAt and normalize them to UTC ISO.
 *
 * Setting dates is how an existing archive keeps its history when it moves
 * here: sitemaps and feeds carry these dates, and search engines take them at
 * face value. For the same reason only admin keys may set them — a publish key
 * could otherwise pass new text off as an old article. Future dates are
 * rejected (that is what status "scheduled" is for), and a post cannot be
 * updated before it was published.
 */
function resolveDates(
  scope: AgentKeyScope,
  input: { publishedAt?: string; updatedAt?: string },
  existingPublishedAt?: string
): { error: Response } | { publishedAt?: string; updatedAt?: string } {
  if (input.publishedAt === undefined && input.updatedAt === undefined) return {};
  if (scope !== "admin") {
    return { error: json({ error: "Setting publishedAt or updatedAt requires admin scope" }, 403) };
  }
  const limit = Date.now() + CLOCK_SKEW_MS;
  const publishedAt = input.publishedAt && new Date(input.publishedAt).toISOString();
  const updatedAt = input.updatedAt && new Date(input.updatedAt).toISOString();
  for (const [field, value] of [["publishedAt", publishedAt], ["updatedAt", updatedAt]] as const) {
    if (value && Date.parse(value) > limit) {
      return { error: json({ error: `${field} is in the future; use status "scheduled"` }, 422) };
    }
  }
  const start = publishedAt || existingPublishedAt;
  // Without a publish date to compare against, the handler would stamp one
  // with now — after this updatedAt.
  if (updatedAt && !start) {
    return { error: json({ error: "updatedAt needs a publishedAt" }, 422) };
  }
  if (updatedAt && start && Date.parse(updatedAt) < Date.parse(start)) {
    return { error: json({ error: "updatedAt is before publishedAt" }, 422) };
  }
  return { publishedAt: publishedAt || undefined, updatedAt: updatedAt || undefined };
}

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
  env: AgentCMSEnv,
  options: HandlerOptions = {}
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
  const existing = await getPost(kv, slug, pfx, { includeDrafts: true });
  if (existing) return json({ error: "Slug already exists", slug }, 409);

  const dates = resolveDates(agent.scope, data);
  if ("error" in dates) return dates.error;

  // Determine effective status
  let effectiveStatus = data.status;
  if (agent.scope === "draft-only") effectiveStatus = "draft";

  const languageError = await checkLanguage(
    env,
    slug,
    data.lang,
    data.translationKey,
    effectiveStatus !== "draft"
  );
  if (languageError) return languageError;

  // A supplied publishedAt is kept on a draft too, as the date it goes out with.
  const publishedAt = dates.publishedAt ?? (effectiveStatus === "published" ? now : "");

  // Build post
  const post: AgentCMSPost = {
    slug,
    title: data.title,
    description: data.description || generateDescription(data.content),
    content: data.content,
    contentHtml: data.contentHtml,
    author: agent.name,
    authorType: "agent",
    tags: data.tags,
    category: data.category,
    publishedAt,
    // An imported post was last changed when its source says, not today.
    updatedAt: dates.updatedAt ?? dates.publishedAt ?? now,
    status: effectiveStatus,
    scheduledFor: data.scheduledFor,
    featuredImage: data.featuredImage,
    ogImage: data.ogImage,
    readingTime: calculateReadingTime(data.content),
    featured: data.featured,
    noindex: data.noindex,
    canonicalUrl: data.canonicalUrl,
    lang: data.lang,
    translationKey: data.translationKey,
    metadata: data.metadata ?? {},
    agentMetadata: {
      model: request.headers.get("X-Agent-Model") || "unknown",
      generatedAt: now,
    },
  };

  await putPost(kv, post, pfx);
  if (effectiveStatus === "published") await updateIndex(kv, post, "upsert", pfx);

  const siteUrl = new URL(request.url).origin;
  notify(options, sendWebhook(kv, "post.published", post, siteUrl, pfx));

  return json(
    {
      success: true,
      slug,
      url: `${siteUrl}${options.basePath ?? "/blog"}/${slug}`,
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
  const lang = url.searchParams.get("lang") || undefined;
  const translationKey = url.searchParams.get("translationKey") || undefined;

  const index = await getIndex(kv, pfx);
  let posts = index.posts;

  if (tag) posts = posts.filter((p) => p.tags.includes(tag));
  if (category) posts = posts.filter((p) => p.category === category);
  if (lang) {
    const defaultLang = defaultLanguage(await siteConfig(env));
    posts = posts.filter((p) => (p.lang ?? defaultLang) === lang);
  }
  if (translationKey) posts = posts.filter((p) => p.translationKey === translationKey);

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

  const post = await getPost(kv, slug, pfx, { includeDrafts: true });
  if (!post) return json({ error: "Post not found" }, 404);

  // The stored post as the agent wrote it, for editing. Not for rendering:
  // a generated contentHtml here would be PUT back and outrank later edits.
  return json(post);
}

/**
 * PUT /api/agent/posts/:slug — Update an existing post.
 */
export async function handleAgentUpdatePost(
  request: Request,
  env: AgentCMSEnv,
  slug: string,
  options: HandlerOptions = {}
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

  const existing = await getPost(kv, slug, pfx, { includeDrafts: true });
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
  // A post lives under one key, so writing a published post back as a draft
  // unpublishes it. That needs publish scope, as DELETE does; a draft-only
  // key may only revise drafts.
  if (agent.scope === "draft-only") {
    if (existing.status !== "draft")
      return json({ error: "draft-only keys can only edit drafts" }, 403);
    data.status = "draft";
  }

  const dates = resolveDates(agent.scope, data, existing.publishedAt);
  if ("error" in dates) return dates.error;

  const now = new Date().toISOString();
  const updated: AgentCMSPost = {
    ...existing,
    ...data,
    publishedAt: dates.publishedAt ?? existing.publishedAt,
    featuredImage:
      data.featuredImage === null
        ? undefined
        : (data.featuredImage ?? existing.featuredImage),
    ogImage:
      data.ogImage === null
        ? undefined
        : (data.ogImage ?? existing.ogImage),
    canonicalUrl:
      data.canonicalUrl === null
        ? undefined
        : (data.canonicalUrl ?? existing.canonicalUrl),
    lang: data.lang === null ? undefined : (data.lang ?? existing.lang),
    translationKey:
      data.translationKey === null
        ? undefined
        : (data.translationKey ?? existing.translationKey),
    // Replaced as a whole when given: a partial merge could not remove a key.
    metadata: data.metadata ?? existing.metadata ?? {},
    slug: existing.slug,
    author: existing.author,
    authorType: existing.authorType,
    updatedAt: dates.updatedAt ?? now,
  };

  if (data.content) {
    updated.readingTime = calculateReadingTime(data.content);
    if (!data.description) {
      updated.description =
        existing.description || generateDescription(data.content);
    }
  }

  if (data.status === "published" && !updated.publishedAt) {
    updated.publishedAt = now;
  }

  const languageError = await checkLanguage(
    env,
    updated.slug,
    updated.lang,
    updated.translationKey,
    updated.status !== "draft"
  );
  if (languageError) return languageError;

  await putPost(kv, updated, pfx);
  await updateIndex(kv, updated, "upsert", pfx);

  const siteUrl = new URL(request.url).origin;
  notify(options, sendWebhook(kv, "post.updated", updated, siteUrl, pfx));

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
  slug: string,
  options: HandlerOptions = {}
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

  const existing = await getPost(kv, slug, pfx, { includeDrafts: true });
  if (!existing) return json({ error: "Post not found" }, 404);

  await deletePost(kv, slug, pfx);
  await updateIndex(kv, existing, "remove", pfx);

  const siteUrl = new URL(request.url).origin;
  notify(options, sendWebhook(kv, "post.deleted", existing, siteUrl, pfx));

  return json({
    success: true,
    deleted: slug,
    remainingRequests: remaining,
  });
}

/**
 * GET /api/agent/context — Site context for agents to understand before writing.
 */
export interface ContextOptions {
  /** Site config to use when KV has none (the integration's inline `site`). */
  site?: AgentCMSSiteConfig;
}

/** GET /api/agent/context handler. */
export async function handleAgentContext(
  request: Request,
  env: AgentCMSEnv,
  options: ContextOptions = {}
): Promise<Response> {
  const kv = env.AGENTCMS_KV;
  const pfx = env.AGENTCMS_PREFIX;

  const agent = await validateApiKey(kv, request.headers.get("Authorization"), pfx);
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  const config = (await siteConfig(env)) ?? options.site ?? null;
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
      language: defaultLanguage(config),
      // Every language the site publishes in; empty when it has only one.
      languages: config?.languages ?? [],
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
      maxContentLength: 200_000,
      metadataMaxBytes: METADATA_MAX_BYTES,
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
      // Absolute, so it passes as featuredImage/ogImage as well as in markdown.
      url: `${new URL(request.url).origin}/images/${key}`,
      path: `/images/${key}`,
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
          "List existing posts. Check before writing to avoid duplicates. Query params: limit, offset, tag, category, lang, translationKey.",
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
            publishedAt: {
              type: "string",
              format: "date-time",
              description:
                "Admin keys only. The post's original publish date, when migrating an existing archive. Not in the future. Defaults to now.",
            },
            updatedAt: {
              type: "string",
              format: "date-time",
              description:
                "Admin keys only. The original last-modified date. Defaults to publishedAt when that is given.",
            },
            lang: {
              type: "string",
              description:
                "Language tag (en, de, pt-BR). Must be one of the site's languages from get_site_context when it lists any. Defaults to the site language.",
            },
            translationKey: {
              type: "string",
              description:
                "Links language versions of one article: give every translation the same key (lowercase, digits, hyphens). At most one published post per language per key.",
            },
            featuredImage: { type: "string", format: "uri", description: "Absolute http(s) URL, e.g. from upload_image" },
            ogImage: { type: "string", format: "uri", description: "Social card image, absolute http(s) URL. Defaults to featuredImage." },
            canonicalUrl: { type: "string", format: "uri", description: "When the article first appeared elsewhere" },
            noindex: { type: "boolean", description: "Keep out of search engines and the sitemap" },
            metadata: {
              type: "object",
              description:
                "Free-form JSON for the site's own use (source ids, sponsor, reading level). Max 16KB. Stored and returned, never rendered.",
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
          { code: 409, description: "Slug already exists, or this translationKey already has a post in that language" },
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
          "Update an existing post. Partial updates — only include fields to change. Send null for featuredImage, ogImage, canonicalUrl, lang or translationKey to clear it; metadata is replaced as a whole.",
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
              description: "Absolute image URL, usable as featuredImage, ogImage or in markdown",
            },
            path: {
              type: "string",
              description: "The same image as a site-relative path, /images/{key}",
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
        "On a multilingual site, publish each translation as its own post with the same translationKey",
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
