// ============================================================================
// AgentCMS — Webhook Notifications
// ============================================================================

import type { AgentCMSPost } from "../types.js";
import { getConfig } from "./kv.js";

export type WebhookEvent = "post.published" | "post.updated" | "post.deleted";

export interface WebhookPayload {
  event: WebhookEvent;
  timestamp: string;
  post: {
    slug: string;
    title: string;
    author: string;
    status: string;
    url?: string;
  };
}

/**
 * Send a webhook notification if configured. Fire-and-forget — never blocks
 * the API response or throws.
 */
export async function sendWebhook(
  kv: KVNamespace,
  event: WebhookEvent,
  post: AgentCMSPost,
  siteUrl?: string
): Promise<void> {
  try {
    const kvConfig = await getConfig(kv);
    const inlineSite = globalThis.__AGENTCMS_CONFIG__?.site;
    const config = kvConfig || inlineSite || null;
    const webhookUrl = config?.moderation?.notifyOnPublish;
    if (!webhookUrl) return;

    const basePath = globalThis.__AGENTCMS_CONFIG__?.basePath || "/blog";

    const payload: WebhookPayload = {
      event,
      timestamp: new Date().toISOString(),
      post: {
        slug: post.slug,
        title: post.title,
        author: post.author,
        status: post.status,
        url: siteUrl ? `${siteUrl}${basePath}/${post.slug}` : undefined,
      },
    };

    // Fire and forget — don't await in caller, but we do await fetch here
    // so the Worker runtime keeps the connection alive
    await fetch(webhookUrl, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(payload),
    });
  } catch {
    // Webhook failures are silent — they should never break the API
  }
}
