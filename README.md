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
- `/api/agent/*` — write API for agents
- `/.well-known/agent-skill.json` — skill discovery for AI agents

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
