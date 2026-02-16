// ============================================================================
// GET /api/agent/posts — List posts (for agents to check existing content)
// ============================================================================

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { validateApiKey, getIndex } from "../../utils/kv.js";

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

export const GET: APIRoute = async ({ request }) => {
  const bindingName = globalThis.__AGENTCMS_CONFIG__?.kvBinding || "AGENTCMS_KV";
  const kv = (env as Record<string, unknown>)[bindingName] as KVNamespace;

  // --- Auth ---
  const agent = await validateApiKey(kv, request.headers.get("Authorization"));
  if (!agent) {
    return json({ error: "Invalid or missing API key" }, 401);
  }

  // --- Parse query params ---
  const url = new URL(request.url);
  const limitParam = url.searchParams.get("limit");
  const offsetParam = url.searchParams.get("offset");
  const limit = Math.min(100, Math.max(1, parseInt(limitParam ?? "20", 10) || 20));
  const offset = Math.max(0, parseInt(offsetParam ?? "0", 10) || 0);
  const tag = url.searchParams.get("tag") || undefined;
  const category = url.searchParams.get("category") || undefined;

  // --- Get index ---
  const index = await getIndex(kv);
  let posts = index.posts;

  if (tag) {
    posts = posts.filter((p) => p.tags.includes(tag));
  }
  if (category) {
    posts = posts.filter((p) => p.category === category);
  }

  const total = posts.length;
  const page = posts.slice(offset, offset + limit);

  return json({
    posts: page,
    total,
    limit,
    offset,
    hasMore: offset + limit < total,
  });
};
