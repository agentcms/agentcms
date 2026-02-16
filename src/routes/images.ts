// ============================================================================
// GET /images/[...path] — Serve images from R2
// ============================================================================

import type { APIRoute } from "astro";
import { env } from "cloudflare:workers";

export const GET: APIRoute = async ({ params }) => {
  const r2Binding = globalThis.__AGENTCMS_CONFIG__?.r2Binding || "AGENTCMS_R2";
  const r2 = (env as Record<string, unknown>)[r2Binding] as R2Bucket | undefined;

  if (!r2) {
    return new Response("Image storage not configured", { status: 500 });
  }

  const path = params.path;
  if (!path || path.includes("..") || path.includes(":") || path.includes("/")) {
    return new Response("Not found", { status: 404 });
  }
  // Upload keys are {8 hex}-{sanitized filename}; allow only that pattern to avoid reading arbitrary keys
  if (!/^[a-f0-9]{8}-[a-z0-9._-]+$/i.test(path) || path.length > 120) {
    return new Response("Not found", { status: 404 });
  }

  const object = await r2.get(path);
  if (!object) {
    return new Response("Not found", { status: 404 });
  }

  return new Response(object.body as ReadableStream, {
    headers: {
      "Content-Type": object.httpMetadata?.contentType || "application/octet-stream",
      "Cache-Control": "public, max-age=31536000, immutable",
      "ETag": object.httpEtag,
    },
  });
};
