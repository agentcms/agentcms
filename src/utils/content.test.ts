import { describe, it, expect } from "vitest";
import {
  slugify,
  calculateReadingTime,
  generateDescription,
  extractHeadings,
  generateApiKey,
} from "./content.js";

// ============================================================================
// slugify
// ============================================================================

describe("slugify", () => {
  it("converts a simple title to lowercase hyphenated slug", () => {
    expect(slugify("Hello World")).toBe("hello-world");
  });

  it("strips special characters", () => {
    expect(slugify("What's New in 2025?")).toBe("whats-new-in-2025");
  });

  it("collapses multiple spaces/hyphens", () => {
    expect(slugify("foo   bar--baz")).toBe("foo-bar-baz");
  });

  it("trims leading/trailing hyphens", () => {
    expect(slugify("--hello--")).toBe("hello");
  });

  it("truncates to 80 characters", () => {
    const long = "a".repeat(100);
    expect(slugify(long).length).toBe(80);
  });

  it("handles empty string", () => {
    expect(slugify("")).toBe("");
  });

  it("handles unicode by stripping non-word characters", () => {
    expect(slugify("café & résumé")).toBe("caf-rsum");
  });

  it("converts underscores to hyphens", () => {
    expect(slugify("foo_bar_baz")).toBe("foo-bar-baz");
  });
});

// ============================================================================
// calculateReadingTime
// ============================================================================

describe("calculateReadingTime", () => {
  it("returns 1 minute for very short content", () => {
    expect(calculateReadingTime("Hello world")).toBe(1);
  });

  it("returns 1 minute for 230 words", () => {
    const words = Array(230).fill("word").join(" ");
    expect(calculateReadingTime(words)).toBe(1);
  });

  it("returns 2 minutes for 231-460 words", () => {
    const words = Array(300).fill("word").join(" ");
    expect(calculateReadingTime(words)).toBe(2);
  });

  it("rounds up to the next minute", () => {
    const words = Array(231).fill("word").join(" ");
    expect(calculateReadingTime(words)).toBe(2);
  });

  it("handles empty string", () => {
    expect(calculateReadingTime("")).toBe(1);
  });
});

// ============================================================================
// generateDescription
// ============================================================================

describe("generateDescription", () => {
  it("returns short content as-is", () => {
    expect(generateDescription("Hello world")).toBe("Hello world");
  });

  it("strips markdown headings", () => {
    expect(generateDescription("## Heading\nSome text")).toBe(
      "Heading Some text"
    );
  });

  it("strips bold/italic markers", () => {
    expect(generateDescription("This is **bold** and *italic*")).toBe(
      "This is bold and italic"
    );
  });

  it("strips markdown links, keeping link text", () => {
    expect(generateDescription("Check [this link](http://example.com)")).toBe(
      "Check this link"
    );
  });

  it("strips code blocks", () => {
    const md = "Before\n```js\nconsole.log('hi')\n```\nAfter";
    expect(generateDescription(md)).toBe("Before After");
  });

  it("strips inline code", () => {
    expect(generateDescription("Use `foo()` here")).toBe("Use  here");
  });

  it("truncates to maxLength with ellipsis", () => {
    const long = "word ".repeat(100);
    const desc = generateDescription(long, 50);
    expect(desc.length).toBeLessThanOrEqual(50);
    expect(desc).toMatch(/\.\.\.$/);
  });

  it("respects custom maxLength", () => {
    const text = "a ".repeat(50);
    const desc = generateDescription(text, 20);
    expect(desc.length).toBeLessThanOrEqual(20);
  });
});

// ============================================================================
// extractHeadings
// ============================================================================

describe("extractHeadings", () => {
  it("extracts h2-h4 headings with depth and slug", () => {
    const md = "# H1 skip\n## Getting Started\n### Setup\n#### Config";
    const headings = extractHeadings(md);
    expect(headings).toEqual([
      { depth: 2, text: "Getting Started", slug: "getting-started" },
      { depth: 3, text: "Setup", slug: "setup" },
      { depth: 4, text: "Config", slug: "config" },
    ]);
  });

  it("skips h1 headings", () => {
    const md = "# Title\n## Section";
    const headings = extractHeadings(md);
    expect(headings).toHaveLength(1);
    expect(headings[0].depth).toBe(2);
  });

  it("returns empty array for content with no headings", () => {
    expect(extractHeadings("Just a paragraph")).toEqual([]);
  });

  it("handles headings with special characters", () => {
    const md = "## What's New in 2025?";
    const headings = extractHeadings(md);
    expect(headings[0].text).toBe("What's New in 2025?");
    expect(headings[0].slug).toBe("whats-new-in-2025");
  });
});

// ============================================================================
// generateApiKey
// ============================================================================

describe("generateApiKey", () => {
  it("generates key with acms_live prefix", () => {
    const key = generateApiKey("acms_live");
    expect(key).toMatch(/^acms_live_[0-9a-f]{64}$/);
  });

  it("generates key with acms_draft prefix", () => {
    const key = generateApiKey("acms_draft");
    expect(key).toMatch(/^acms_draft_[0-9a-f]{64}$/);
  });

  it("generates unique keys each time", () => {
    const key1 = generateApiKey("acms_live");
    const key2 = generateApiKey("acms_live");
    expect(key1).not.toBe(key2);
  });
});
