// Cache tags shared by the live loader (which sets them on entries) and the
// agent write routes (which purge them), so the two can't drift apart.

/** Carried by every AgentCMS listing and post. */
export const POSTS_TAG = "agentcms:posts";

/** Carried by one post's entry and the pages that render it. */
export const postTag = (slug: string): string => `agentcms:post:${slug}`;
