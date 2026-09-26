// ============================================================================
// AgentCMS — Core Types
// ============================================================================

// --- Post Schema ---

export interface AgentCMSPost {
  slug: string;
  title: string;
  description: string;
  content: string;
  contentHtml?: string;
  author: string;
  authorType: "agent" | "human";
  tags: string[];
  category?: string;
  publishedAt: string;
  updatedAt: string;
  status: "published" | "draft" | "scheduled";
  scheduledFor?: string;
  featuredImage?: string;
  ogImage?: string;
  readingTime?: number;
  featured?: boolean;
  /** Exclude this post from search engine indexing. */
  noindex?: boolean;
  /** Canonical URL override for SEO deduplication. */
  canonicalUrl?: string;
  /** Language of this post (BCP 47, e.g. "en", "de", "pt-BR"). */
  lang?: string;
  /** Groups one article's translations: every language version shares it. */
  translationKey?: string;
  /**
   * Site-specific structured data (e.g. `{ towns: ["bellagio"] }`). JSON only,
   * size-capped, and never rendered by AgentCMS — a site that renders a value
   * from here as HTML must sanitize it itself.
   */
  metadata: Record<string, unknown>;
  agentMetadata?: AgentMetadata;
}

export interface AgentMetadata {
  model: string;
  promptHash?: string;
  generatedAt: string;
  toolsUsed?: string[];
  /** x402 payment reference if post was paid-for submission */
  paymentRef?: string;
}

// --- Post Index (stored in KV for fast listing) ---

export interface PostIndex {
  posts: PostIndexEntry[];
  totalCount: number;
  lastUpdated: string;
}

export interface PostIndexEntry {
  slug: string;
  title: string;
  description: string;
  publishedAt: string;
  tags: string[];
  category?: string;
  author: string;
  authorType: "agent" | "human";
  featuredImage?: string;
  featured?: boolean;
  noindex?: boolean;
  /** Missing on entries written before 0.10; read it as publishedAt. */
  updatedAt?: string;
  lang?: string;
  translationKey?: string;
}

// --- Agent API Key ---

export interface AgentKeyRecord {
  name: string;
  keyHash: string;
  scope: AgentKeyScope;
  createdAt: string;
  lastUsedAt?: string;
  rateLimit: number; // per hour
  metadata?: Record<string, unknown>;
}

export type AgentKeyScope = "admin" | "publish" | "draft-only" | "read-only";

// --- Site Config (stored in KV at config:site) ---

export interface AgentCMSSiteConfig {
  name: string;
  description: string;
  url: string;
  /** Default language (BCP 47). Posts without `lang` are in this language. */
  language: string;
  /**
   * Languages the site publishes in, default first. When set, a post's `lang`
   * must be one of them.
   */
  languages?: string[];
  writingGuidelines: WritingGuidelines;
  seo: SEOConfig;
  moderation: ModerationConfig;
}

export interface WritingGuidelines {
  tone: string;
  targetAudience: string;
  preferredLength: string;
  requiredTags?: string[];
  forbiddenTopics?: string[];
  categories?: string[];
}

export interface SEOConfig {
  titleTemplate: string;
  defaultOgImage?: string;
  twitterHandle?: string;
}

export interface ModerationConfig {
  /** If false, agent posts go to draft and need manual approval */
  autoPublish: boolean;
  /** Webhook URL to notify on new posts */
  notifyOnPublish?: string;
}

// --- Integration Options ---

export interface AgentCMSOptions {
  /** "auto" = AgentCMS creates /blog routes. "headless" = you own routes. */
  mode?: "auto" | "headless";
  /** Base path for auto mode routes. Default: "/blog" */
  basePath?: string;
  /** Posts per page for auto mode pagination. Default: 12 */
  postsPerPage?: number;
  /**
   * Serve /feed.xml. Default: true. Applies in both modes; ignored when the project has its own
   * src/pages/feed.xml.* or public/feed.xml.
   */
  rss?: boolean;
  /**
   * Serve /sitemap.xml. Default: true. Applies in both modes — a headless site needs a sitemap
   * exactly as much as an auto one. Ignored when the project has its own src/pages/sitemap.xml.*
   * or public/sitemap.xml, which then serves the path instead.
   */
  sitemap?: boolean;
  /**
   * Serve /robots.txt. Default: true. Applies in both modes; ignored when the project has its own
   * src/pages/robots.txt.* or public/robots.txt.
   */
  robots?: boolean;
  /** Additional external sitemaps for robots.txt. */
  additionalSitemaps?: string[];
  /** Serve /.well-known/agent-skill.json. Default: true */
  skillEndpoint?: boolean;
  /**
   * Serve the public read API: /api/posts, /api/posts/[slug], /api/tags, /api/categories.
   * Default: true. Each path the project serves itself is left to the project.
   */
  publicApi?: boolean;
  /** Include default CSS theme. Default: "default" */
  theme?: "default" | "none";
  /** KV binding name. Default: "AGENTCMS_KV" */
  kvBinding?: string;
  /** R2 binding name for image storage. Default: "AGENTCMS_R2" */
  r2Binding?: string;
  /** KV key prefix to isolate data when sharing a namespace. Default: none */
  kvPrefix?: string;
  /** Inline site config. Used as fallback when KV has no config:site key. */
  site?: AgentCMSSiteConfig;
}

// --- Sitemap & Robots.txt Options ---

export interface SitemapOptions {
  /** Blog base path for the post URLs, Astro's `base` included. */
  basePath?: string;
  /** Append a trailing slash to the post URLs, for a `trailingSlash: "always"` site. */
  trailingSlash?: boolean;
  staticPages?: Array<{
    loc: string;
    lastmod?: string;
    changefreq?: "always" | "hourly" | "daily" | "weekly" | "monthly" | "yearly" | "never";
    priority?: number;
  }>;
  additionalSitemaps?: string[];
}

export interface RobotsTxtOptions {
  additionalSitemaps?: string[];
  disallow?: string[];
  /** Emit this site's own `Sitemap:` line. False when nothing serves one. Default: true */
  includeSitemap?: boolean;
  /** Path of this site's own sitemap, when it is not /sitemap.xml. */
  sitemapPath?: string;
}

// --- Data Helper Options ---

export interface GetPostsOptions {
  page?: number;
  limit?: number;
  tag?: string;
  category?: string;
  status?: "published" | "draft" | "all";
  featured?: boolean;
  author?: string;
  authorType?: "agent" | "human";
  /** Only posts in this language. Posts without `lang` count as `defaultLang`. */
  lang?: string;
  /** The language of posts that carry no `lang` (the site's default). */
  defaultLang?: string;
  /** Only the language versions of one article. */
  translationKey?: string;
  /** Only posts updated at or after this instant (ISO 8601). */
  since?: string;
}

export interface GetPostsResult {
  posts: AgentCMSPost[];
  totalPages: number;
  totalPosts: number;
  currentPage: number;
}

// --- Skill Definition (served at /.well-known/agent-skill.json) ---

export interface AgentSkillDefinition {
  $schema: string;
  name: string;
  version: string;
  description: string;
  baseUrl: string;
  authentication: {
    type: "bearer";
    header: string;
    description: string;
  };
  capabilities: AgentCapability[];
  setup?: {
    description: string;
    steps: Array<{ title: string; commands?: string[]; description: string }>;
  };
  guidelines: {
    tone: string;
    contentPolicy: string;
    rateLimit: string;
    bestPractices: string[];
  };
}

export interface AgentCapability {
  name: string;
  method: string;
  path: string;
  description: string;
  input?: Record<string, unknown>;
  output?: Record<string, unknown>;
  errors?: Array<{ code: number; description: string }>;
}

// --- x402 Premium Types ---

export interface X402Config {
  enabled: boolean;
  /** Wallet address to receive payments */
  recipientAddress: string;
  /** Price per article submission in USDC */
  pricePerSubmission: string;
  /** Network: "base" | "solana" */
  network: "base" | "solana";
  /** x402 facilitator URL */
  facilitatorUrl?: string;
}

export interface X402SubmissionRecord {
  slug: string;
  submittedBy: string; // agent wallet or identifier
  paymentRef: string;  // on-chain tx hash
  amount: string;
  status: "pending_review" | "approved" | "rejected" | "published";
  submittedAt: string;
  reviewedAt?: string;
  reviewedBy?: string;
}

/** Config baked into the generated /sitemap.xml route. See createSitemapRoute. */
export interface SitemapRouteConfig {
  /**
   * Blog base path, Astro's `base` INCLUDED — post URLs are built from it, and on a based site an
   * un-based one lists a 404 for every post.
   */
  basePath?: string;
  /** Astro's `trailingSlash: "always"`, so a listed post URL does not redirect. */
  trailingSlash?: boolean;
  /** The project's own indexable pages, so a headless site's sitemap is not just the posts. */
  staticPages?: SitemapOptions["staticPages"];
  kvBinding?: string;
  kvPrefix?: string;
}

/** Config baked into the generated /feed.xml route. See createFeedRoute. */
export interface FeedRouteConfig {
  /** Blog base path, Astro's `base` included — item permalinks are built from it. */
  basePath?: string;
  /** Astro's `trailingSlash: "always"`, so an item permalink does not redirect. */
  trailingSlash?: boolean;
  kvBinding?: string;
  kvPrefix?: string;
  /** Inline site config, used when KV has no config:site key. */
  site?: AgentCMSSiteConfig;
}

/** Config baked into the generated /robots.txt route. See createRobotsRoute. */
export interface RobotsRouteConfig {
  additionalSitemaps?: string[];
  disallow?: string[];
  /** Emit this site's own `Sitemap:` line. False when nothing serves one. Default: true */
  includeSitemap?: boolean;
  /** Path of this site's sitemap, base included. Default: "/sitemap.xml" */
  sitemapPath?: string;
}
