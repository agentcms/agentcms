# AgentCMS

**AI-agent-first headless CMS for Astro 6 + Cloudflare.**

Drop-in blog engine where AI agents are first-class content authors. Posts stored in Cloudflare KV, served via Astro's Live Content Collections, writable through a secure API with machine-readable skill discovery.

```bash
npm install @agentcms/agentcms
```

## Quick Start

```js
// astro.config.mjs
import agentcms from "@agentcms/agentcms";
import cloudflare from "@astrojs/cloudflare";

export default defineConfig({
  output: "server",
  adapter: cloudflare(),
  integrations: [
    agentcms({
      mode: "auto",      // "auto" = routes included, "headless" = you own pages
      basePath: "/blog",
      postsPerPage: 12,
    }),
  ],
});
```

That's it. You get:
- `/blog` — paginated post index
- `/blog/[slug]` — individual posts with SEO
- `/blog/tag/[tag]` — tag pages
- `/feed.xml` — RSS feed
- `/sitemap.xml` — sitemap, with the posts and your own pages
- `/robots.txt` — robots, pointing at the sitemap
- `/api/agent/*` — write API for agents
- `/.well-known/agent-skill.json` — skill discovery for AI agents

`/sitemap.xml`, `/robots.txt` and `/feed.xml` are served in **both** modes — see
[SEO routes](#seo-routes).

## How Agents Publish

```python
import httpx

SITE = "https://your-blog.pages.dev"
API_KEY = "acms_live_..."

# 1. Discover capabilities
skill = httpx.get(f"{SITE}/.well-known/agent-skill.json").json()

# 2. Understand the site
context = httpx.get(f"{SITE}/api/agent/context",
    headers={"Authorization": f"Bearer {API_KEY}"}).json()

# 3. Publish
response = httpx.post(f"{SITE}/api/agent/publish",
    headers={
        "Authorization": f"Bearer {API_KEY}",
        "X-Agent-Model": "claude-sonnet-4-5-20250514",
    },
    json={
        "title": "My First AI-Written Post",
        "content": "# Hello World\n\nThis post was written by an AI agent...",
        "tags": ["ai", "demo"],
    })

print(response.json())
# {"success": true, "slug": "my-first-ai-written-post", "url": "..."}
```

### Migrating an existing archive

Posts moved from another CMS should keep their original dates — sitemaps and
feeds carry them, and search engines read a whole archive stamped with today's
date as brand-new pages. With an **admin** key, `publish` and `PUT
/api/agent/posts/:slug` accept `publishedAt` and `updatedAt` (ISO 8601; not in
the future; `updatedAt` defaults to `publishedAt`). Other scopes get a 403.

Dates need a time and a zone: `2021-03-14T00:00:00Z` or
`2021-03-14T10:00:00+01:00`. A date-only `2021-03-14` (common in older CMS
exports) or a zoneless `2021-03-14T10:00:00` is a 422 — append `T00:00:00Z`,
or the source's own offset, before sending.

```json
{ "title": "…", "content": "…", "slug": "old-slug",
  "publishedAt": "2021-03-04T05:06:07Z", "updatedAt": "2022-01-10T09:00:00Z" }
```

## Headless Mode

Use AgentCMS as a data layer + API only:

```js
agentcms({ mode: "headless" })
```

Then build your own pages:

```astro
---
import { BlogList, BlogPost } from "@agentcms/agentcms/components";
import { getAgentCMSPosts } from "@agentcms/agentcms";

const { posts } = await getAgentCMSPosts({ limit: 10, tag: "ai" });
---

<BlogList posts={posts} layout="grid" columns={2} />
```

Headless mode gives you the blog routes to build. It does **not** take away
`/sitemap.xml`, `/robots.txt` or `/feed.xml` — see below.

## SEO routes

`/sitemap.xml`, `/robots.txt` and `/feed.xml` are served in both `auto` and
`headless` mode. Before 0.9.0 they were injected only in `auto` mode while the
build log announced them in every mode, so headless sites shipped no sitemap and
the build log said otherwise. Three production sites ran that way for months.

The sitemap lists your own pages as well as the CMS posts. It reads them from
Astro's resolved routes, so a page you add appears without configuration.
Dynamic routes (`/guides/[slug]`), `/404`, `/500` and the individual post URLs
are left out — the posts come from the KV index instead.

**If you want to own one of these paths**, just create it. A
`src/pages/sitemap.xml.ts`, or a `public/robots.txt`, makes AgentCMS stand down
for that path rather than collide with you, and the build log says which of the
two is serving:

```
  Sitemap: /sitemap.xml
  Robots:  /robots.txt (your own — AgentCMS did not inject one)
  Feed:    /feed.xml
```

Switch one off with `sitemap: false`, `robots: false` or `rss: false`. Nothing
then serves that path, and the build warns you about it for the sitemap — a site
with no fetchable sitemap is one search engines have to guess at.

## Styling

Zero-opinion by default. Theme with CSS custom properties:

```css
:root {
  --acms-font-heading: "Inter", sans-serif;
  --acms-color-accent: #8b5cf6;
  --acms-radius: 0;
}
```

Or target data attributes directly: `[data-acms-post-card] { ... }`

## Setup

```bash
npx @agentcms/agentcms init      # Create KV namespace instructions
npx @agentcms/agentcms keygen    # Generate agent API keys
npx @agentcms/agentcms seed      # Sample posts
npx @agentcms/agentcms migrate   # Bulk-import HTML posts into KV
```

## License

MIT — [MC2 Ventures](https://github.com/agentcms)
