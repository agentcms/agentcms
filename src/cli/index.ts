#!/usr/bin/env node

// ============================================================================
// AgentCMS CLI
//
// Commands:
//   npx agentcms init               — Set up KV namespace + wrangler config
//   npx agentcms keygen --name X    — Generate an agent API key
//   npx agentcms seed               — Add sample blog posts
// ============================================================================

import { generateApiKey, slugify, calculateReadingTime, generateDescription } from "../utils/content.js";
import { hashApiKey, KEYS } from "../utils/kv.js";

const args = process.argv.slice(2);
const command = args[0];

function getFlag(name: string): string | undefined {
  const idx = args.indexOf(`--${name}`);
  if (idx === -1) return undefined;
  return args[idx + 1];
}

async function main() {
  switch (command) {
    case "keygen": {
      const name = getFlag("name") || "default-agent";
      const scope = (getFlag("scope") || "publish") as "publish" | "draft-only" | "read-only" | "admin";
      const prefix = scope === "draft-only" ? "acms_draft" as const : "acms_live" as const;

      const apiKey = generateApiKey(prefix);
      const keyHash = await hashApiKey(apiKey);

      console.log("");
      console.log("  🔑 AgentCMS API Key Generated");
      console.log("  ─────────────────────────────");
      console.log(`  Name:   ${name}`);
      console.log(`  Scope:  ${scope}`);
      console.log(`  Key:    ${apiKey}`);
      console.log("");
      console.log("  ⚠️  Save this key — it cannot be recovered.");
      console.log("");
      console.log("  To register this key, run:");
      console.log(`  npx wrangler kv key put --binding=AGENTCMS_KV "agents:${keyHash}" '${JSON.stringify({
        name,
        keyHash,
        scope,
        createdAt: new Date().toISOString(),
        rateLimit: 10,
      })}'`);
      console.log("");
      break;
    }

    case "init": {
      console.log("");
      console.log("  🚀 AgentCMS Init");
      console.log("  ────────────────");
      console.log("  Run these commands to set up your KV namespace:");
      console.log("");
      console.log("  npx wrangler kv namespace create AGENTCMS_KV");
      console.log("");
      console.log("  Then add to your wrangler.toml:");
      console.log("");
      console.log("  [[kv_namespaces]]");
      console.log('  binding = "AGENTCMS_KV"');
      console.log('  id = "<your-namespace-id>"');
      console.log("");
      break;
    }

    case "seed": {
      console.log("");
      console.log("  🌱 AgentCMS Seed");
      console.log("  ────────────────");
      console.log("  Run these commands to add sample posts:");
      console.log("");

      const samplePosts = [
        {
          title: "Welcome to AgentCMS",
          content: "# Welcome\n\nThis is your first post, created by AgentCMS.\n\n## What is AgentCMS?\n\nAgentCMS is an AI-agent-first headless CMS for Astro 6 and Cloudflare. It lets AI agents publish blog posts through a simple API, while serving them as fast, server-rendered pages.\n\n## Getting Started\n\nYour blog is already live! You can:\n\n- Create posts via the Agent API at `/api/agent/publish`\n- Let AI agents discover your blog at `/.well-known/agent-skill.json`\n- Customize the look with CSS custom properties\n\nHappy blogging! 🚀",
          tags: ["agentcms", "getting-started"],
          category: "Announcements",
        },
        {
          title: "How AI Agents Can Write Blog Posts",
          content: "# AI Agents as Content Authors\n\nAgentCMS treats AI agents as first-class content authors. Here's how it works.\n\n## The Agent Skill Interface\n\nEvery AgentCMS site exposes a machine-readable skill definition at `/.well-known/agent-skill.json`. Any AI agent can read this to understand how to interact with your blog.\n\n## Publishing Flow\n\n1. Agent reads the skill definition\n2. Agent calls `/api/agent/context` to understand your site's tone\n3. Agent checks `/api/agent/posts` to avoid duplicates\n4. Agent publishes via `POST /api/agent/publish`\n\n## Security\n\nAll access requires a Bearer token. Keys are scoped: `publish`, `draft-only`, `read-only`, or `admin`.\n\nRate limiting prevents abuse — 10 posts per hour per key by default.",
          tags: ["ai-agents", "tutorial", "api"],
          category: "Tutorials",
        },
      ];

      for (const post of samplePosts) {
        const slug = slugify(post.title);
        const now = new Date().toISOString();
        const full = {
          slug,
          title: post.title,
          description: generateDescription(post.content),
          content: post.content,
          author: "AgentCMS",
          authorType: "human",
          tags: post.tags,
          category: post.category,
          publishedAt: now,
          updatedAt: now,
          status: "published",
          readingTime: calculateReadingTime(post.content),
          featured: false,
          metadata: {},
        };

        console.log(`  npx wrangler kv key put --binding=AGENTCMS_KV "posts:${slug}" '${JSON.stringify(full)}'`);
        console.log("");
      }

      // Also output the index
      const indexEntries = samplePosts.map((post) => ({
        slug: slugify(post.title),
        title: post.title,
        description: generateDescription(post.content),
        publishedAt: new Date().toISOString(),
        tags: post.tags,
        category: post.category,
        author: "AgentCMS",
        authorType: "human",
      }));

      console.log(`  npx wrangler kv key put --binding=AGENTCMS_KV "posts:index" '${JSON.stringify({
        posts: indexEntries,
        totalCount: indexEntries.length,
        lastUpdated: new Date().toISOString(),
      })}'`);
      console.log("");
      break;
    }

    default:
      console.log("");
      console.log("  AgentCMS CLI");
      console.log("  ────────────");
      console.log("  Commands:");
      console.log("    init                       Set up KV namespace");
      console.log("    keygen --name <n> [--scope] Generate API key");
      console.log("    seed                       Sample posts (KV commands)");
      console.log("");
  }
}

main().catch(console.error);
