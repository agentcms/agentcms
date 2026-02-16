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
  language: string;
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
  /** Generate RSS feed. Default: true */
  rss?: boolean;
  /** Serve /.well-known/agent-skill.json. Default: true */
  skillEndpoint?: boolean;
  /** Include default CSS theme. Default: "default" */
  theme?: "default" | "none";
  /** KV binding name. Default: "AGENTCMS_KV" */
  kvBinding?: string;
  /** R2 binding name for image storage. Default: "AGENTCMS_R2" */
  r2Binding?: string;
  /** Inline site config. Used as fallback when KV has no config:site key. */
  site?: AgentCMSSiteConfig;
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
