// ============================================================================
// AgentCMS — Astro live content loader
// ============================================================================
//
// Posts as an Astro live collection, so pages use getLiveCollection /
// getLiveEntry and render with the entry's `rendered.html`:
//
//   // src/live.config.ts
//   import { defineLiveCollection } from "astro:content";
//   import { agentcmsLoader } from "@agentcms/agentcms/loader";
//   export const collections = { posts: defineLiveCollection({ loader: agentcmsLoader() }) };
//
// With no `url` it reads the site's own KV (Astro on Cloudflare). With `url`
// it reads another AgentCMS site's public API over HTTP, from any host.
// Either way the data is what GET /api/posts returns: sanitized, published
// only. Every entry carries cache tags, so with Astro's route cache
// (`Astro.cache.set(entry)`) a publish or edit through the agent API purges
// exactly the pages that show the post.
//
// ============================================================================

import type { LiveLoader } from "astro/loaders";
import { handleGetPost, handleListPosts, type AgentCMSEnv } from "../handlers/public.js";
import type { AgentCMSPost } from "../types.js";

import { POSTS_TAG, postTag } from "../utils/cache-tags.js";

export { POSTS_TAG, postTag };

export interface AgentCMSLoaderOptions {
  /** Base URL of an AgentCMS site to read over HTTP, e.g. "https://cms.example.com". */
  url?: string;
  /** Public API base on that site (default: "/api"). */
  apiBase?: string;
  /** Extra request headers for the remote API. */
  headers?: Record<string, string>;
}

export interface AgentCMSPostFilter {
  tag?: string;
  category?: string;
  lang?: string;
  translationKey?: string;
  featured?: boolean;
  author?: string;
  /** ISO 8601; posts updated (or published) at or after it. */
  since?: string;
  /** Page size, 1–100 (default 100). */
  limit?: number;
  page?: number;
}

export interface AgentCMSEntryFilter {
  id: string;
}

/** A post as the public API returns it, with its other language versions. */
export type AgentCMSLivePost = AgentCMSPost & {
  translations?: Array<{ lang: string; slug: string; title: string }>;
};

class AgentCMSLoaderError extends Error {
  constructor(message: string, readonly status?: number) {
    super(message);
    this.name = "AgentCMSLoaderError";
  }
}

type Fetcher = (path: string) => Promise<Response>;

/** Reads the site's own KV through the same handlers as the public API. */
function kvFetcher(): Fetcher {
  return async (path) => {
    const { env } = await import("cloudflare:workers");
    const bindings = env as Record<string, unknown>;
    const config = globalThis.__AGENTCMS_CONFIG__;
    const kv = bindings[config?.kvBinding || "AGENTCMS_KV"] as KVNamespace | undefined;
    if (!kv) {
      throw new AgentCMSLoaderError(
        `KV binding "${config?.kvBinding || "AGENTCMS_KV"}" not found; pass { url } to read a remote AgentCMS`
      );
    }
    const handlerEnv: AgentCMSEnv = {
      AGENTCMS_KV: kv,
      AGENTCMS_PREFIX: (bindings.AGENTCMS_PREFIX as string | undefined) ?? config?.kvPrefix,
    };
    const request = new Request(`https://agentcms.internal${path}`);
    const url = new URL(request.url);
    const post = /^\/posts\/([a-z0-9-]+)$/.exec(url.pathname);
    return post
      ? handleGetPost(request, handlerEnv, post[1])
      : handleListPosts(request, handlerEnv);
  };
}

function httpFetcher(options: AgentCMSLoaderOptions): Fetcher {
  const base = `${options.url!.replace(/\/$/, "")}${(options.apiBase ?? "/api").replace(/\/$/, "")}`;
  return (path) => fetch(`${base}${path}`, { headers: { Accept: "application/json", ...options.headers } });
}

function lastModified(post: AgentCMSPost): Date | undefined {
  const d = new Date(post.updatedAt || post.publishedAt);
  return Number.isNaN(d.getTime()) ? undefined : d;
}

function toEntry(post: AgentCMSLivePost) {
  const modified = lastModified(post);
  return {
    id: post.slug,
    data: post,
    rendered: { html: post.contentHtml ?? "" },
    cacheHint: {
      tags: [POSTS_TAG, postTag(post.slug)],
      ...(modified ? { lastModified: modified } : {}),
    },
  };
}

export function agentcmsLoader(
  options: AgentCMSLoaderOptions = {}
): LiveLoader<AgentCMSLivePost, AgentCMSEntryFilter, AgentCMSPostFilter, AgentCMSLoaderError> {
  const get = options.url ? httpFetcher(options) : kvFetcher();

  async function getJson<T>(path: string): Promise<T | { error: AgentCMSLoaderError } | undefined> {
    let response: Response;
    try {
      response = await get(path);
    } catch (e) {
      return { error: e instanceof AgentCMSLoaderError ? e : new AgentCMSLoaderError(String(e)) };
    }
    if (response.status === 404) return undefined;
    if (!response.ok) {
      return { error: new AgentCMSLoaderError(`AgentCMS ${path}: HTTP ${response.status}`, response.status) };
    }
    return (await response.json()) as T;
  }

  return {
    name: "@agentcms/agentcms",

    async loadCollection({ filter = {} }) {
      const params = new URLSearchParams({ full: "1", limit: String(filter.limit ?? 100) });
      for (const key of ["tag", "category", "lang", "translationKey", "author", "since"] as const) {
        if (filter[key]) params.set(key, filter[key]);
      }
      if (filter.featured !== undefined) params.set("featured", String(filter.featured));
      if (filter.page) params.set("page", String(filter.page));

      const result = await getJson<{ posts: AgentCMSLivePost[] }>(`/posts?${params}`);
      if (!result) return { entries: [], cacheHint: { tags: [POSTS_TAG] } };
      if ("error" in result) return { error: result.error };

      const entries = result.posts.map(toEntry);
      const newest = entries
        .map((e) => e.cacheHint.lastModified)
        .filter((d): d is Date => !!d)
        .sort((a, b) => b.getTime() - a.getTime())[0];
      return {
        entries,
        cacheHint: { tags: [POSTS_TAG], ...(newest ? { lastModified: newest } : {}) },
      };
    },

    async loadEntry({ filter }) {
      if (!/^[a-z0-9-]{1,80}$/.test(filter.id)) return undefined;
      const post = await getJson<AgentCMSLivePost>(`/posts/${filter.id}`);
      if (!post || "error" in post) return post;
      return toEntry(post);
    },
  };
}
