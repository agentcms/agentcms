// ============================================================================
// GET /.well-known/agent-skill.json — Machine-readable skill definition
// ============================================================================

import type { APIRoute } from "astro";
import type { AgentSkillDefinition } from "../types.js";

export const GET: APIRoute = async ({ request }) => {
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
              description: "Custom URL slug. Auto-generated from title if omitted.",
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
            url: { type: "string", description: "Relative URL path like /images/{key}" },
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
        "AgentCMS runs on Cloudflare Workers with KV for posts and R2 for images. Follow these steps to provision the required infrastructure.",
      steps: [
        {
          title: "Install wrangler CLI",
          commands: ["npm install -g wrangler", "wrangler login"],
          description:
            "Wrangler is Cloudflare's CLI for managing Workers, KV, and R2. You must be logged in to create resources.",
        },
        {
          title: "Create a KV namespace for blog data",
          commands: [
            "npx wrangler kv namespace create AGENTCMS_KV",
          ],
          description:
            "This stores posts, the post index, site config, and API keys. Copy the returned namespace ID into your wrangler.toml under [[kv_namespaces]] with binding = \"AGENTCMS_KV\".",
        },
        {
          title: "Create an R2 bucket for image storage",
          commands: [
            "npx wrangler r2 bucket create agentcms-images",
          ],
          description:
            "This stores uploaded images. Add [[r2_buckets]] to wrangler.toml with binding = \"AGENTCMS_R2\" and bucket_name = \"agentcms-images\". Images are served at /images/* through the Worker — no public bucket config needed.",
        },
        {
          title: "Configure wrangler.toml",
          commands: [],
          description:
            "Your wrangler.toml should contain: name, compatibility_date, [[kv_namespaces]] with binding=\"AGENTCMS_KV\" and the namespace id from step 2, and [[r2_buckets]] with binding=\"AGENTCMS_R2\" and bucket_name=\"agentcms-images\".",
        },
        {
          title: "Generate an agent API key",
          commands: [
            "npx @agentcms/agentcms keygen --name \"my-agent\" --scope publish",
          ],
          description:
            "Run this command and follow the output to store the key hash in KV. Use the returned key as a Bearer token in the Authorization header.",
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
        "Upload images before publishing, then reference the returned URL in featuredImage or markdown content",
      ],
    },
  };

  return new Response(JSON.stringify(skill, null, 2), {
    headers: {
      "Content-Type": "application/json",
      "Cache-Control": "public, max-age=3600",
    },
  });
};
