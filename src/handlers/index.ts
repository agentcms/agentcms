// ============================================================================
// AgentCMS — Handlers (framework-agnostic HTTP handlers)
// ============================================================================
//
// Import from "@agentcms/agentcms/handlers" to use these in
// Cloudflare Pages Functions, Hono, or any request/response framework.
//
// ============================================================================

export type { AgentCMSEnv } from "./public.js";

// --- Public read handlers (no auth, cacheable) ---
export {
  handleListPosts,
  handleGetPost,
  handleListCategories,
  handleListTags,
  handleSitemap,
  handleRobotsTxt,
} from "./public.js";

// --- Types for handler options ---
export type { SitemapOptions, RobotsTxtOptions } from "../types.js";

// --- Agent handlers (auth-required) ---
export {
  handlePublish,
  handleAgentListPosts,
  handleAgentGetPost,
  handleAgentUpdatePost,
  handleAgentDeletePost,
  handleAgentContext,
  handleAgentUpload,
  handleSkill,
} from "./agent.js";
