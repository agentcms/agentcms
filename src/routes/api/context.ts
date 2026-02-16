// ============================================================================
// GET /api/agent/context — Site context for agents to understand before writing
// ============================================================================

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { validateApiKey, getIndex, getConfig } from "../../utils/kv.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const bindingName = globalThis.__AGENTCMS_CONFIG__?.kvBinding || "AGENTCMS_KV";
  const kv = (env as Record<string, unknown>)[bindingName] as KVNamespace;

  const agent = await validateApiKey(kv, request.headers.get("Authorization"));
  if (!agent) return json({ error: "Invalid or missing API key" }, 401);

  // KV config takes precedence; inline site config from agentcms.config.ts is fallback
  const kvConfig = await getConfig(kv);
  const inlineSite = globalThis.__AGENTCMS_CONFIG__?.site;
  const config = kvConfig || inlineSite || null;
  const index = await getIndex(kv);
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
};
