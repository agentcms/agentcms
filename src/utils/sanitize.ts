// ============================================================================
// AgentCMS — Content Sanitization
// ============================================================================
//
// Post content is written by agents, and agents draft from pages they fetched.
// A prompt injection on a scraped page therefore arrives here as post content.
// `marked` passes raw HTML straight through (its `sanitize` option is gone), and
// an agent can also store `contentHtml` directly, so `<script>` or
// `<img onerror>` in a post reaches the DOM of whatever site renders it.
//
// This module is the single boundary. Every path that hands post HTML out of
// the package — the public and agent handlers, getAgentCMSPost/getAgentCMSPosts,
// BlogPost.astro — goes through `toSafePost` / `renderPostHtml`. A consumer
// should never need to call `marked` itself.
//
// How: parse with node-html-parser (pure JS, runs in Workers and Node alike —
// sanitize-html needs postcss, which needs Node built-ins), then *rebuild* the
// HTML from the tree: only allowlisted tags and attributes, every text node and
// attribute value escaped by us. Nothing from the input is copied through as a
// raw string, so there is no markup the output can contain that we did not
// write.
// ============================================================================

import { Marked } from "marked";
import { parse, NodeType, type Node, type HTMLElement } from "node-html-parser";
import type { AgentCMSPost } from "../types.js";

const marked = new Marked();

/** Tags a post body may contain. Anything else is unwrapped (its text kept). */
export const ALLOWED_TAGS: ReadonlySet<string> = new Set([
  "p", "br", "hr", "h1", "h2", "h3", "h4", "h5", "h6",
  "a", "strong", "em", "b", "i", "u", "s", "del", "ins", "mark",
  "code", "pre", "kbd", "samp",
  "ul", "ol", "li", "dl", "dt", "dd",
  "blockquote", "q", "cite", "abbr", "time", "sup", "sub", "small", "span", "div",
  "img", "figure", "figcaption", "picture", "source",
  "table", "thead", "tbody", "tfoot", "tr", "th", "td", "caption", "colgroup", "col",
]);

/** Tags removed together with everything inside them. */
const DROP_WITH_CONTENT: ReadonlySet<string> = new Set([
  "script", "style", "template", "noscript", "noembed", "noframes", "xmp", "plaintext",
  "iframe", "frame", "frameset", "object", "embed", "applet",
  "svg", "math", "form", "input", "button", "select", "option", "textarea",
  "head", "title", "meta", "link", "base",
]);

const VOID_TAGS: ReadonlySet<string> = new Set(["br", "hr", "img", "source", "col"]);

const INLINE_TAGS: ReadonlySet<string> = new Set([
  "a", "strong", "em", "b", "i", "u", "s", "del", "ins", "mark", "code", "kbd",
  "samp", "q", "cite", "abbr", "time", "sup", "sub", "small", "span",
]);

const ALLOWED_ATTRIBUTES: Readonly<Record<string, readonly string[]>> = {
  a: ["href", "title"],
  img: ["src", "alt", "title", "width", "height", "loading"],
  source: ["srcset", "type", "media"],
  time: ["datetime"],
  abbr: ["title"],
  blockquote: ["cite"],
  q: ["cite"],
  ol: ["start", "reversed"],
  th: ["colspan", "rowspan", "scope"],
  td: ["colspan", "rowspan"],
  col: ["span"],
  colgroup: ["span"],
  h1: ["id"], h2: ["id"], h3: ["id"], h4: ["id"], h5: ["id"], h6: ["id"],
};

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src", "cite"]);

/**
 * Schemes a URL may carry. No `javascript:`, no `data:` (the package ships an
 * R2 upload route for images), no protocol-relative `//host`.
 */
const ALLOWED_SCHEMES: ReadonlySet<string> = new Set(["http", "https", "mailto"]);

export function isSafeUrl(value: string): boolean {
  // Browsers ignore ASCII whitespace and control characters inside a scheme
  // ("java\tscript:"), so test the URL with those removed.
  const v = value.replace(/[\u0000- \u007f]/g, "");
  if (v.startsWith("//") || v.startsWith("\\\\") || v.startsWith("/\\")) return false;
  const scheme = /^([a-z][a-z0-9+.-]*):/i.exec(v);
  if (!scheme) return true; // relative: path, #fragment, ?query
  return ALLOWED_SCHEMES.has(scheme[1].toLowerCase());
}

function isSafeSrcset(value: string): boolean {
  return value.split(",").every((c) => isSafeUrl(c.trim().split(/\s+/)[0] ?? ""));
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

function safeAttributes(tag: string, el: HTMLElement): string {
  const out: string[] = [];
  const allowed = ALLOWED_ATTRIBUTES[tag] ?? [];
  const attrs = el.attributes;
  for (const [rawName, value] of Object.entries(attrs)) {
    const name = rawName.toLowerCase();
    if (!allowed.includes(name)) continue;
    if (URL_ATTRIBUTES.has(name) && !isSafeUrl(value)) continue;
    if (name === "srcset" && !isSafeSrcset(value)) continue;
    // An id is fine for heading anchors, not for clobbering the host page's DOM.
    if (name === "id" && !/^[A-Za-z][\w-]{0,99}$/.test(value)) continue;
    out.push(`${name}="${escapeAttr(value)}"`);
  }

  // marked emits <pre><code class="language-ts">; keep only that class so
  // syntax highlighting works without letting content restyle the host page.
  if (tag === "code" || tag === "pre") {
    const lang = (attrs.class ?? "")
      .split(/\s+/)
      .filter((c) => /^language-[\w+#.-]{1,40}$/.test(c));
    if (lang.length) out.push(`class="${escapeAttr(lang.join(" "))}"`);
  }

  // No `target` is ever emitted, so no link keeps a handle on the opener;
  // external links are also marked as untrusted for search engines.
  if (tag === "a" && /^https?:\/\//i.test((attrs.href ?? "").trim())) {
    out.push(`rel="noopener noreferrer nofollow ugc"`);
  }
  return out.length ? ` ${out.join(" ")}` : "";
}

function serialize(node: Node): string {
  if (node.nodeType === NodeType.TEXT_NODE) return escapeText(node.text);
  if (node.nodeType !== NodeType.ELEMENT_NODE) return ""; // comments

  const el = node as HTMLElement;
  const tag = (el.rawTagName ?? "").toLowerCase();
  const children = () => el.childNodes.map(serialize).join("");

  if (!tag) return children(); // the root
  if (DROP_WITH_CONTENT.has(tag)) return "";
  if (!ALLOWED_TAGS.has(tag)) return children();
  if (VOID_TAGS.has(tag)) return `<${tag}${safeAttributes(tag, el)}>`;
  return `<${tag}${safeAttributes(tag, el)}>${children()}</${tag}>`;
}

function parseHtml(html: string): HTMLElement {
  return parse(html, {
    comment: false,
    lowerCaseTagName: false,
    // Default treats <pre> as raw text, which would escape fenced code blocks
    // into visible tags. Raw-text elements listed here are dropped anyway.
    blockTextElements: { script: true, style: true, noscript: true, textarea: true },
  });
}

/** Sanitize HTML that is already HTML. */
export function sanitizePostHtml(html: string): string {
  if (!html) return "";
  return serialize(parseHtml(html));
}

/** Markdown (which may contain raw HTML) to HTML that is safe to insert. */
export async function renderMarkdown(markdown: string): Promise<string> {
  if (!markdown) return "";
  return sanitizePostHtml(await marked.parse(markdown));
}

/**
 * Safe HTML for a post body: a stored `contentHtml` (agent-supplied, or from
 * a migration) is sanitized; otherwise the markdown is rendered and sanitized.
 */
export async function renderPostHtml(
  post: Pick<AgentCMSPost, "content" | "contentHtml">
): Promise<string> {
  return post.contentHtml
    ? sanitizePostHtml(post.contentHtml)
    : renderMarkdown(post.content);
}

/**
 * The post as it may leave the package: `contentHtml` always present and
 * safe. `content` stays the raw markdown the agent wrote — untrusted; render
 * it only through this module.
 */
export async function toSafePost<T extends AgentCMSPost>(post: T): Promise<T> {
  return { ...post, contentHtml: await renderPostHtml(post) };
}

/**
 * For list responses, where rendering every body would cost a markdown parse
 * per post: a stored `contentHtml` is sanitized, and none is rendered.
 */
export function toSafeListPost<T extends AgentCMSPost>(post: T): T {
  if (!post.contentHtml) return post;
  return { ...post, contentHtml: sanitizePostHtml(post.contentHtml) };
}

/**
 * Strip markup entirely, for places that take text, not HTML: RSS
 * descriptions, meta tags. Returns plain (unescaped) text — callers escape for
 * their own context, or "&" ends up as "&amp;amp;".
 */
export function stripHtml(input: string): string {
  if (!input) return "";
  const text = (n: Node): string => {
    if (n.nodeType === NodeType.TEXT_NODE) return n.text;
    if (n.nodeType !== NodeType.ELEMENT_NODE) return "";
    const el = n as HTMLElement;
    const tag = (el.rawTagName ?? "").toLowerCase();
    if (DROP_WITH_CONTENT.has(tag)) return "";
    const inner = el.childNodes.map(text).join("");
    // Block boundaries become spaces ("<p>a</p><p>b</p>" is "a b", not "ab").
    return !tag || INLINE_TAGS.has(tag) ? inner : ` ${inner} `;
  };
  return text(parseHtml(input)).replace(/\s+/g, " ").trim();
}
