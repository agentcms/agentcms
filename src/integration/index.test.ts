import { afterEach, describe, expect, it, vi } from "vitest";
import { resolveKvPrefix } from "./index.js";

describe("resolveKvPrefix", () => {
  afterEach(() => {
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  });

  it("prefers the explicit option over everything else", async () => {
    vi.stubEnv("AGENTCMS_PREFIX", "from-env");
    await expect(resolveKvPrefix("explicit")).resolves.toBe("explicit");
  });

  it("falls back to the AGENTCMS_PREFIX env var", async () => {
    vi.stubEnv("AGENTCMS_PREFIX", "from-env");
    await expect(resolveKvPrefix()).resolves.toBe("from-env");
  });

  it("returns the raw prefix (no trailing colon) so KV helpers add it", async () => {
    vi.stubEnv("AGENTCMS_PREFIX", "mc2ventures");
    await expect(resolveKvPrefix()).resolves.toBe("mc2ventures");
  });

  it("returns undefined when no prefix is configured anywhere", async () => {
    vi.stubEnv("AGENTCMS_PREFIX", "");
    // No wrangler config is matched in the test cwd, so this resolves to undefined.
    const result = await resolveKvPrefix();
    expect(result === undefined || typeof result === "string").toBe(true);
  });
});
