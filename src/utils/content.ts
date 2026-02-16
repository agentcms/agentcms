// ============================================================================
// AgentCMS — Content Utilities
// ============================================================================

/**
 * Generate a URL-safe slug from a title
 */
export function slugify(text: string): string {
  return text
    .toLowerCase()
    .trim()
    .replace(/[^\w\s-]/g, "")
    .replace(/[\s_]+/g, "-")
    .replace(/-+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 80);
}

/**
 * Calculate reading time in minutes
 */
export function calculateReadingTime(content: string): number {
  const words = content.trim().split(/\s+/).length;
  return Math.max(1, Math.ceil(words / 230));
}

/**
 * Auto-generate a meta description from content
 */
export function generateDescription(content: string, maxLength = 155): string {
  // Strip markdown syntax
  const plain = content
    .replace(/#{1,6}\s/g, "")
    .replace(/\*\*|__/g, "")
    .replace(/\*|_/g, "")
    .replace(/\[([^\]]+)\]\([^)]+\)/g, "$1")
    .replace(/```[\s\S]*?```/g, "")
    .replace(/`[^`]+`/g, "")
    .replace(/!\[[^\]]*\]\([^)]+\)/g, "")
    .replace(/\n+/g, " ")
    .trim();

  if (plain.length <= maxLength) return plain;
  return plain.slice(0, maxLength - 3).replace(/\s+\S*$/, "") + "...";
}

/**
 * Extract headings from markdown for table of contents
 */
export function extractHeadings(
  content: string
): Array<{ depth: number; text: string; slug: string }> {
  const headingRegex = /^(#{2,4})\s+(.+)$/gm;
  const headings: Array<{ depth: number; text: string; slug: string }> = [];

  let match;
  while ((match = headingRegex.exec(content)) !== null) {
    headings.push({
      depth: match[1].length,
      text: match[2].trim(),
      slug: slugify(match[2]),
    });
  }

  return headings;
}

/**
 * Generate a secure random API key
 */
export function generateApiKey(prefix: "acms_live" | "acms_draft"): string {
  const bytes = new Uint8Array(32);
  crypto.getRandomValues(bytes);
  const key = Array.from(bytes)
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
  return `${prefix}_${key}`;
}
