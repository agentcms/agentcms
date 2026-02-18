// ============================================================================
// AgentCMS — HTML Blog Post Parser
//
// Parses static HTML blog files into AgentCMSPost objects using configurable
// CSS selectors. Works with any blog HTML structure.
// ============================================================================

import { parse as parseHTML, type HTMLElement } from "node-html-parser";
import { slugify, calculateReadingTime, generateDescription } from "../utils/content.js";
import type { AgentCMSPost } from "../types.js";

export interface ParseOptions {
  /** CSS selector for the post title (default: "h1") */
  titleSelector: string;
  /** CSS selector for the main content container (default: "article") */
  contentSelector: string;
  /** CSS selector for date elements (default: "time[dateTime]") */
  dateSelector: string;
  /** CSS selector for the featured image (default: "img") */
  imageSelector: string;
  /** CSS selector for the summary/description (default: "meta[name=description]") */
  summarySelector: string;
  /** CSS selector for the author name (default: none — uses --author flag) */
  authorSelector: string;
  /** Default author name when no selector matches */
  defaultAuthor: string;
}

export const DEFAULT_PARSE_OPTIONS: ParseOptions = {
  titleSelector: "h1",
  contentSelector: "article",
  dateSelector: "time[dateTime]",
  imageSelector: "img",
  summarySelector: "meta[name=description]",
  authorSelector: "",
  defaultAuthor: "Editorial Team",
};

/**
 * Extract plain text from an HTML element, stripping all tags.
 */
function textContent(el: HTMLElement | null): string {
  if (!el) return "";
  return el.textContent?.trim() || "";
}

/**
 * Parse a single HTML file into an AgentCMSPost.
 * Returns null if the file lacks required fields (title).
 */
export function parseHtmlFile(
  html: string,
  filename: string,
  options: ParseOptions
): AgentCMSPost | null {
  const root = parseHTML(html);

  // --- Title ---
  const titleEl = root.querySelector(options.titleSelector);
  const title = textContent(titleEl);
  if (!title) {
    return null; // Can't create a post without a title
  }

  // --- Slug (from filename) ---
  const slug = filename
    .replace(/\.html?$/i, "")
    .replace(/[^a-z0-9-]/gi, "-")
    .toLowerCase()
    .replace(/-+/g, "-")
    .replace(/^-|-$/g, "");

  // --- Dates ---
  const dateEls = root.querySelectorAll(options.dateSelector);
  let publishedAt = new Date().toISOString();
  let updatedAt = publishedAt;

  if (dateEls.length > 0) {
    const firstDate = dateEls[0].getAttribute("dateTime") || dateEls[0].getAttribute("datetime");
    if (firstDate) {
      publishedAt = new Date(firstDate).toISOString();
      updatedAt = publishedAt;
    }
    if (dateEls.length > 1) {
      const secondDate = dateEls[1].getAttribute("dateTime") || dateEls[1].getAttribute("datetime");
      if (secondDate) {
        updatedAt = new Date(secondDate).toISOString();
      }
    }
  }

  // --- Featured Image ---
  const imgEl = root.querySelector(options.imageSelector);
  const featuredImage = imgEl?.getAttribute("src") || undefined;

  // --- Description / Summary ---
  let description = "";
  const summaryEl = root.querySelector(options.summarySelector);
  if (summaryEl) {
    // If it's a meta tag, use content attribute; otherwise use text content
    description = summaryEl.getAttribute("content") || textContent(summaryEl);
  }
  // Strip any HTML entities that might have been double-encoded
  description = description.replace(/&lt;[^&]*&gt;/g, "").replace(/&quot;/g, '"').replace(/&amp;/g, "&").trim();

  // --- Content HTML ---
  const contentEl = root.querySelector(options.contentSelector);
  const contentHtml = contentEl?.innerHTML?.trim() || "";

  // --- Plain text content (for search and reading time) ---
  const plainText = contentEl?.textContent?.trim() || "";

  // Fall back to generating description from plain text if none found
  if (!description && plainText) {
    description = generateDescription(plainText);
  }

  // --- Author ---
  let author = options.defaultAuthor;
  if (options.authorSelector) {
    const authorEl = root.querySelector(options.authorSelector);
    const authorText = textContent(authorEl);
    if (authorText) {
      author = authorText;
    }
  }

  // --- Reading Time ---
  const readingTime = calculateReadingTime(plainText);

  return {
    slug,
    title,
    description,
    content: plainText,
    contentHtml,
    author,
    authorType: "human",
    tags: [],
    publishedAt,
    updatedAt,
    status: "published",
    featuredImage,
    readingTime,
    featured: false,
    metadata: {},
  };
}
