// ============================================================================
// GET /robots.txt — Dynamic Robots.txt
// ============================================================================
//
// Kept for anyone wiring the route by hand. The integration does NOT use this file: it generates a
// module that calls createRobotsRoute with additionalSitemaps baked in, which a .ts endpoint cannot
// read from the page-ssr global.
//
// ============================================================================

import { createRobotsRoute } from "./robots-handler.js";

export const GET = createRobotsRoute();
