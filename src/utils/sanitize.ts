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
// This module is the single boundary. Every path that hands post HTML to a
// reader — the public handlers, getAgentCMSPost/getAgentCMSPosts,
// BlogPost.astro — goes through `toSafePost` / `renderPostHtml`. A consumer
// should never need to call `marked` itself.
//
// How: htmlparser2 tokenizes the input as a stream of open/text/close events
// (pure JS, so it runs in Workers and Node alike — sanitize-html needs postcss,
// which needs Node built-ins). We write the output ourselves from those
// events: only allowlisted tags and attributes, every text node and attribute
// value escaped by us. Nothing from the input is copied through as a raw
// string, so the output contains no markup we did not write. The walk is a
// single pass with an explicit stack and no recursion, and input size is
// capped (MAX_INPUT), so hostile nesting cannot blow the stack or the CPU
// budget.
// ============================================================================

import { Marked } from "marked";
import { Parser } from "htmlparser2";
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

/**
 * No `id`: content ids can clobber globals on the host page (`id="config"`
 * becomes `window.config`) or collide with the page's own elements.
 * No `style`, no `class` (except `language-*` on code), no `target`.
 */
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
};

const URL_ATTRIBUTES: ReadonlySet<string> = new Set(["href", "src", "cite"]);

/** Output nesting beyond this is flattened (text kept, tags dropped). */
const MAX_DEPTH = 64;

/**
 * Input beyond this is cut off before parsing. htmlparser2 slows down
 * superlinearly past ~20k unclosed elements; at this size the worst case stays
 * around a quarter-second, and no real post comes close (writes are capped at
 * 200k characters). Cutting mid-tag is safe: the parser closes what is open.
 */
const MAX_INPUT = 256 * 1024;

const SAFE_PROTOCOLS: ReadonlySet<string> = new Set(["http:", "https:", "mailto:"]);
// "https:evil.example" is a relative path on an https page and an absolute
// URL on an http one, so resolve against both and take the stricter answer.
const BASES = ["https://base.invalid/", "http://base.invalid/"];

/**
 * Parse a URL the way a browser will — the WHATWG URL parser strips the
 * whitespace and control characters that hide a scheme ("java\tscript:"),
 * and treats "\" as "/" — and allow only http(s), mailto and relative URLs.
 * No `javascript:`, no `data:` (the package ships an R2 upload route).
 * `external` is true if the URL can leave the host page's origin.
 */
function classifyUrl(value: string): { external: boolean } | null {
  let external = false;
  for (const base of BASES) {
    let url: URL;
    try {
      url = new URL(value, base);
    } catch {
      return null;
    }
    if (!SAFE_PROTOCOLS.has(url.protocol)) return null;
    if (url.protocol !== "mailto:" && url.origin !== new URL(base).origin) external = true;
  }
  return { external };
}

export function isSafeUrl(value: string): boolean {
  return classifyUrl(value) !== null;
}

function isSafeSrcset(value: string): boolean {
  return value
    .split(",")
    .every((c) => isSafeUrl(c.trim().split(/\s+/)[0] ?? ""));
}

function escapeText(s: string): string {
  return s.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function escapeAttr(s: string): string {
  return escapeText(s).replace(/"/g, "&quot;");
}

/** Attribute names arrive lower-cased from the parser. */
function safeAttributes(tag: string, attribs: Record<string, string>): string {
  const out: string[] = [];
  const allowed = ALLOWED_ATTRIBUTES[tag] ?? [];
  let external = false;
  for (const [name, value] of Object.entries(attribs)) {
    if (!allowed.includes(name)) continue;
    if (URL_ATTRIBUTES.has(name)) {
      const url = classifyUrl(value);
      if (!url) continue;
      if (name === "href") external = url.external;
    }
    if (name === "srcset" && !isSafeSrcset(value)) continue;
    out.push(`${name}="${escapeAttr(value)}"`);
  }

  // marked emits <pre><code class="language-ts">; keep only that class so
  // syntax highlighting works without letting content restyle the host page.
  if (tag === "code" || tag === "pre") {
    const lang = (attribs.class ?? "")
      .split(/\s+/)
      .filter((c) => /^language-[\w+#.-]{1,40}$/.test(c));
    if (lang.length) out.push(`class="${escapeAttr(lang.join(" "))}"`);
  }

  // External links: no opener handle (no `target` is ever emitted anyway),
  // and no search-engine credit for links an agent was talked into adding.
  if (tag === "a" && external) out.push(`rel="noopener noreferrer nofollow ugc"`);
  return out.length ? ` ${out.join(" ")}` : "";
}

type Frame = "emit" | "unwrap" | "drop";

/**
 * Stream the input through htmlparser2, tracking per open element whether it
 * is emitted, unwrapped (children kept) or dropped (children discarded).
 */
function walk(
  input: string,
  on: {
    open(tag: string, attribs: Record<string, string>, depth: number): Frame;
    close(tag: string, frame: Frame): void;
    text(text: string): void;
  }
): void {
  const stack: Frame[] = [];
  let dropping = 0; // > 0 while inside a dropped element
  let depth = 0; // emitted elements currently open
  const parser = new Parser(
    {
      onopentag(name, attribs) {
        let frame: Frame;
        if (dropping || DROP_WITH_CONTENT.has(name)) frame = "drop";
        else frame = on.open(name, attribs, depth);
        if (frame === "drop") dropping++;
        if (frame === "emit" && !VOID_TAGS.has(name)) depth++;
        stack.push(frame);
      },
      onclosetag(name) {
        const frame = stack.pop();
        if (frame === undefined) return;
        if (frame === "drop") dropping--;
        else on.close(name, frame);
        if (frame === "emit" && !VOID_TAGS.has(name)) depth--;
      },
      ontext(text) {
        if (!dropping) on.text(text);
      },
      // Comments, CDATA and processing instructions are simply not handled,
      // so content cannot smuggle template markers or conditional comments.
    },
    { decodeEntities: true, lowerCaseTags: true, lowerCaseAttributeNames: true }
  );
  parser.write(input.length > MAX_INPUT ? input.slice(0, MAX_INPUT) : input);
  parser.end(); // closes anything left open, so every open gets its close
}

/** Sanitize HTML that is already HTML. */
export function sanitizePostHtml(html: string): string {
  if (!html) return "";
  let out = "";
  walk(html, {
    open(tag, attribs, depth) {
      if (!ALLOWED_TAGS.has(tag) || depth >= MAX_DEPTH) return "unwrap";
      out += `<${tag}${safeAttributes(tag, attribs)}>`;
      return "emit";
    },
    close(tag, frame) {
      if (frame === "emit" && !VOID_TAGS.has(tag)) out += `</${tag}>`;
    },
    text(text) {
      out += escapeText(text);
    },
  });
  return out;
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
 * The post as it may be handed to a reader: `contentHtml` always present and
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
  let out = "";
  // Block boundaries become spaces ("<p>a</p><p>b</p>" is "a b", not "ab").
  const boundary = (tag: string) => {
    if (!INLINE_TAGS.has(tag)) out += " ";
  };
  walk(input, {
    open(tag) {
      boundary(tag);
      return "unwrap";
    },
    close(tag) {
      boundary(tag);
    },
    text(text) {
      out += text;
    },
  });
  return out.replace(/\s+/g, " ").trim();
}
