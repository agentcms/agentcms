// ============================================================================
// GET /sitemap.xml — Dynamic Sitemap
// ============================================================================
//
// Kept for anyone wiring the route by hand (`injectRoute` to
// "@agentcms/agentcms/routes/sitemap.xml.ts", or a re-export from src/pages). The integration
// does NOT use this file: it generates a small module that calls createSitemapRoute with the
// project's own pages and the real basePath, neither of which an endpoint can discover for itself.
// This path therefore lists the blog only.
//
// ============================================================================

import { createSitemapRoute } from "./sitemap-handler.js";

export const GET = createSitemapRoute({});
