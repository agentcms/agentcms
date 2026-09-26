// ============================================================================
// GET /feed.xml — RSS Feed
// ============================================================================
//
// Kept for anyone wiring the route by hand. The integration does NOT use this file: it generates a
// module that calls createFeedRoute with basePath, kvBinding and kvPrefix baked in, none of which a
// .ts endpoint can read from the page-ssr global. Wired by hand, this falls back to basePath
// "/blog" and the AGENTCMS_PREFIX binding.
//
// ============================================================================

import { createFeedRoute } from "./feed-handler.js";

export const GET = createFeedRoute();
