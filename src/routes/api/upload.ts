// ============================================================================
// POST /api/agent/upload — Upload an image to R2
// ============================================================================

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";
import { validateApiKey, checkRateLimit } from "../../utils/kv.js";

const MAX_SIZE = 10 * 1024 * 1024; // 10 MB

function json(data: unknown, status = 200): Response {
  return new Response(JSON.stringify(data), {
    status,
    headers: { "Content-Type": "application/json" },
  });
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

export const POST: APIRoute = async ({ request }) => {
  const kvBinding = globalThis.__AGENTCMS_CONFIG__?.kvBinding || "AGENTCMS_KV";
  const r2Binding = globalThis.__AGENTCMS_CONFIG__?.r2Binding || "AGENTCMS_R2";
  const kv = (env as Record<string, unknown>)[kvBinding] as KVNamespace;
  const r2 = (env as Record<string, unknown>)[r2Binding] as R2Bucket | undefined;

  if (!r2) {
    return json({ error: "Image storage not configured (missing R2 binding)" }, 500);
  }

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

  // --- Parse multipart ---
  let formData: FormData;
  try {
    formData = await request.formData();
  } catch {
    return json({ error: "Expected multipart/form-data with a 'file' field" }, 400);
  }

  const file = formData.get("file");
  if (!file || !(file instanceof File)) {
    return json({ error: "Missing 'file' field in form data" }, 400);
  }

  // --- Validate ---
  const contentType = file.type;
  if (!contentType.startsWith("image/")) {
    return json({ error: "Only image files are allowed" }, 422);
  }

  if (file.size > MAX_SIZE) {
    return json({ error: `File too large (max ${MAX_SIZE / 1024 / 1024}MB)` }, 422);
  }

  // --- Generate key & upload ---
  const buffer = await file.arrayBuffer();
  const hash = await shortHash(buffer);
  const safeName = sanitizeFilename(file.name || "image");
  const key = `${hash}-${safeName}`;

  await r2.put(key, buffer, {
    httpMetadata: { contentType },
  });

  return json(
    {
      success: true,
      url: `/images/${key}`,
      contentType,
      size: file.size,
      remainingRequests: remaining,
    },
    201
  );
};
