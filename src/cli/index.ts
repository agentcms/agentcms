#!/usr/bin/env node

// ============================================================================
// AgentCMS CLI
//
// Commands:
//   npx @agentcms/agentcms init               — Set up KV namespace + wrangler config
//   npx @agentcms/agentcms keygen --name X    — Generate an agent API key
//   npx @agentcms/agentcms seed               — Add sample blog posts
//   npx @agentcms/agentcms migrate            — Bulk-import HTML posts into Cloudflare KV
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

function hasFlag(name: string): boolean {
  return args.includes(`--${name}`);
}

async function runMigrate() {
  const { readdir, readFile, writeFile, mkdtemp, rm } = await import("node:fs/promises");
  const { join, basename } = await import("node:path");
  const { tmpdir } = await import("node:os");
  const { execSync } = await import("node:child_process");
  const { parseHtmlFile, DEFAULT_PARSE_OPTIONS } = await import("./parse-html.js");

  const source = getFlag("source");
  if (!source) {
    console.error("  Error: --source <dir> is required");
    process.exit(1);
  }

  const dryRun = hasFlag("dry-run");
  const remote = hasFlag("remote");
  let namespaceId = getFlag("namespace-id");

  // Build parse options from flags
  const options = {
    ...DEFAULT_PARSE_OPTIONS,
    ...(getFlag("title-selector") && { titleSelector: getFlag("title-selector")! }),
    ...(getFlag("content-selector") && { contentSelector: getFlag("content-selector")! }),
    ...(getFlag("date-selector") && { dateSelector: getFlag("date-selector")! }),
    ...(getFlag("image-selector") && { imageSelector: getFlag("image-selector")! }),
    ...(getFlag("summary-selector") && { summarySelector: getFlag("summary-selector")! }),
    ...(getFlag("author-selector") && { authorSelector: getFlag("author-selector")! }),
    ...(getFlag("author") && { defaultAuthor: getFlag("author")! }),
  };

  console.log("");
  console.log("  📦 AgentCMS Migrate");
  console.log("  ───────────────────");
  console.log(`  Source:    ${source}`);
  console.log(`  Author:    ${options.defaultAuthor}`);
  console.log(`  Remote:    ${remote}`);
  console.log(`  Dry run:   ${dryRun}`);
  if (namespaceId) {
    console.log(`  KV:        ${namespaceId}`);
  }
  console.log("");

  // Discover HTML files
  const files = (await readdir(source)).filter((f) => f.endsWith(".html") || f.endsWith(".htm"));

  if (files.length === 0) {
    console.log("  No HTML files found in source directory.");
    return;
  }

  console.log(`  Found ${files.length} HTML files`);
  console.log("");

  // Parse all files
  const posts: Array<ReturnType<typeof parseHtmlFile> & {}> = [];
  const errors: string[] = [];

  for (const file of files) {
    const html = await readFile(join(source, file), "utf-8");
    const post = parseHtmlFile(html, basename(file), options);

    if (post) {
      posts.push(post);
    } else {
      errors.push(file);
    }
  }

  console.log(`  Parsed: ${posts.length} posts`);
  if (errors.length > 0) {
    console.log(`  Skipped: ${errors.length} files (no title found)`);
    for (const err of errors) {
      console.log(`    - ${err}`);
    }
  }
  console.log("");

  // Show summary
  if (dryRun || posts.length <= 20) {
    for (const post of posts) {
      if (post) {
        const date = new Date(post.publishedAt).toLocaleDateString("en-US", {
          year: "numeric",
          month: "short",
          day: "numeric",
        });
        console.log(`  ${date}  ${post.slug}`);
        console.log(`           ${post.title.slice(0, 70)}${post.title.length > 70 ? "..." : ""}`);
        console.log(`           ${post.readingTime} min · ${post.author}`);
        console.log("");
      }
    }
  }

  if (dryRun) {
    console.log(`  ✅ Dry run complete — ${posts.length} posts would be written.`);
    return;
  }

  // Build KV entries
  const validPosts = posts.filter((p): p is NonNullable<typeof p> => p !== null);

  // Sort newest first
  validPosts.sort(
    (a, b) => new Date(b.publishedAt).getTime() - new Date(a.publishedAt).getTime()
  );

  const kvEntries = validPosts.map((post) => ({
    key: KEYS.post(post.slug),
    value: JSON.stringify(post),
  }));

  // Build index
  const indexEntry = {
    posts: validPosts.map((post) => ({
      slug: post.slug,
      title: post.title,
      description: post.description,
      publishedAt: post.publishedAt,
      tags: post.tags,
      category: post.category,
      author: post.author,
      authorType: post.authorType,
      featuredImage: post.featuredImage,
      featured: post.featured,
    })),
    totalCount: validPosts.length,
    lastUpdated: new Date().toISOString(),
  };

  kvEntries.push({
    key: KEYS.index,
    value: JSON.stringify(indexEntry),
  });

  // Resolve or create KV namespace
  if (!namespaceId) {
    console.log("  No --namespace-id provided. Looking for existing AGENTCMS_KV namespace...");
    try {
      const listOutput = execSync("npx wrangler kv namespace list", { encoding: "utf-8" });
      const namespaces = JSON.parse(listOutput) as Array<{ id: string; title: string }>;
      const existing = namespaces.find((ns) => ns.title.includes("AGENTCMS_KV"));
      if (existing) {
        namespaceId = existing.id;
        console.log(`  Found: ${existing.title} (${namespaceId})`);
      }
    } catch {
      // List failed, will create below
    }

    if (!namespaceId) {
      console.log("  Creating KV namespace AGENTCMS_KV...");
      try {
        const createOutput = execSync("npx wrangler kv namespace create AGENTCMS_KV", { encoding: "utf-8" });
        const idMatch = createOutput.match(/"id":\s*"([a-f0-9]+)"/);
        if (idMatch) {
          namespaceId = idMatch[1];
          console.log(`  Created: ${namespaceId}`);
          console.log("");
          console.log(`  Add this to your wrangler.toml:`);
          console.log(`  [[kv_namespaces]]`);
          console.log(`  binding = "AGENTCMS_KV"`);
          console.log(`  id = "${namespaceId}"`);
        } else {
          console.error("  Could not parse namespace ID from wrangler output.");
          console.error(createOutput);
          process.exit(1);
        }
      } catch (err) {
        console.error("  Failed to create KV namespace. Run: npx wrangler login");
        process.exit(1);
      }
    }
    console.log("");
  }

  // Write to a temp JSON file, then use wrangler kv bulk put
  const tmpDir = await mkdtemp(join(tmpdir(), "agentcms-migrate-"));
  const bulkFile = join(tmpDir, "bulk.json");

  try {
    await writeFile(bulkFile, JSON.stringify(kvEntries));

    console.log(`  Writing ${kvEntries.length} KV entries via wrangler...`);
    console.log("");

    const remoteFlag = remote ? " --remote" : "";
    execSync(`npx wrangler kv bulk put "${bulkFile}" --namespace-id=${namespaceId}${remoteFlag}`, {
      stdio: "inherit",
    });

    console.log("");
    console.log(`  ✅ Migration complete — ${validPosts.length} posts + index written to KV.`);
    console.log("");
  } finally {
    await rm(tmpDir, { recursive: true, force: true });
  }
}

async function main() {
  switch (command) {
    case "keygen": {
      const { execSync } = await import("node:child_process");

      const name = getFlag("name") || "default-agent";
      const scope = (getFlag("scope") || "publish") as "publish" | "draft-only" | "read-only" | "admin";
      const remote = hasFlag("remote");
      const prefix = scope === "draft-only" ? "acms_draft" as const : "acms_live" as const;

      const apiKey = generateApiKey(prefix);
      const keyHash = await hashApiKey(apiKey);
      const remoteFlag = remote ? " --remote" : "";

      const keyRecord = JSON.stringify({
        name,
        keyHash,
        scope,
        createdAt: new Date().toISOString(),
        rateLimit: 10,
      });

      console.log("");
      console.log("  🔑 AgentCMS Key Generator");
      console.log("  ─────────────────────────");
      console.log(`  Name:   ${name}`);
      console.log(`  Scope:  ${scope}`);
      console.log(`  Target: ${remote ? "remote (production)" : "local (dev)"}`);
      console.log("");

      // Write key record directly to KV via wrangler
      try {
        execSync(
          `npx wrangler kv key put --binding=AGENTCMS_KV${remoteFlag} "agents:${keyHash}" '${keyRecord}'`,
          { stdio: "pipe" }
        );
        console.log("  ✅ Key registered in KV");
      } catch (err) {
        console.error("  ❌ Failed to register key in KV.");
        console.error("     Make sure wrangler is logged in and wrangler.toml has AGENTCMS_KV binding.");
        console.error("");
        console.error("  You can register manually:");
        console.error(`  npx wrangler kv key put --binding=AGENTCMS_KV${remoteFlag} "agents:${keyHash}" '${keyRecord}'`);
        console.error("");
        process.exit(1);
      }

      console.log("");
      console.log(`  Key:    ${apiKey}`);
      console.log("");
      console.log("  ⚠️  Save this key now — it cannot be recovered.");
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

    case "migrate": {
      await runMigrate();
      break;
    }

    default:
      console.log("");
      console.log("  AgentCMS CLI");
      console.log("  ────────────");
      console.log("  Commands:");
      console.log("    init                       Set up KV namespace");
      console.log("    keygen --name <n> [--scope] [--remote] Generate API key");
      console.log("    seed                       Sample posts (KV commands)");
      console.log("    migrate                    Bulk-import HTML posts into KV");
      console.log("");
      console.log("  Migrate options:");
      console.log("    --source <dir>             Path to HTML files (required)");
      console.log("    --dry-run                  Parse and preview without writing");
      console.log("    --remote                   Write to remote KV (default: local)");
      console.log("    --author <name>            Default author name");
      console.log("    --namespace-id <id>        KV namespace ID (auto-detects or creates if omitted)");
      console.log("");
      console.log("  Migrate selectors (customize parsing):");
      console.log('    --title-selector <sel>     Title element (default: "h1")');
      console.log('    --content-selector <sel>   Content container (default: "article")');
      console.log('    --date-selector <sel>      Date elements (default: "time[dateTime]")');
      console.log('    --image-selector <sel>     Featured image (default: "img")');
      console.log('    --summary-selector <sel>   Summary/description element');
      console.log('    --author-selector <sel>    Author name element');
      console.log("");
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
