import { describe, it, expect } from "vitest";
import {
  sanitizePostHtml,
  renderMarkdown,
  renderPostHtml,
  toSafePost,
  toSafeListPost,
  stripHtml,
  isSafeUrl,
} from "./sanitize.js";
import type { AgentCMSPost } from "../types.js";

const post = (over: Partial<AgentCMSPost> = {}): AgentCMSPost => ({
  slug: "p",
  title: "Title here",
  description: "d",
  content: "# Hi\n\nBody",
  author: "a",
  authorType: "agent",
  tags: [],
  publishedAt: "",
  updatedAt: "",
  status: "published",
  metadata: {},
  ...over,
});

describe("sanitizePostHtml", () => {
  it("drops script elements and their content", () => {
    const out = sanitizePostHtml("<p>ok</p><script>alert(1)</script>");
    expect(out).toBe("<p>ok</p>");
  });

  it("drops event handlers", () => {
    const out = sanitizePostHtml('<img src="/a.png" onerror="alert(1)">');
    expect(out).toBe('<img src="/a.png">');
  });

  it("drops javascript: URLs, including obfuscated ones", () => {
    for (const href of [
      "javascript:alert(1)",
      "JaVaScRiPt:alert(1)",
      " javascript:alert(1)",
      "java\tscript:alert(1)",
      "jav&#x61;script:alert(1)",
      "&#106;avascript:alert(1)",
    ]) {
      expect(sanitizePostHtml(`<a href="${href}">x</a>`)).toBe("<a>x</a>");
    }
  });

  it("drops data: URLs", () => {
    expect(sanitizePostHtml('<img src="data:image/png;base64,AAAA">')).toBe("<img>");
    expect(sanitizePostHtml('<source srcset="/a.png 1x, data:x 2x">')).toBe("<source>");
  });

  it("treats protocol-relative and backslash URLs as the external links they are", () => {
    const rel = 'rel="noopener noreferrer nofollow ugc"';
    for (const href of ["//evil.example", "\\/evil.example", "https:evil.example", "http:\\\\evil.example"]) {
      expect(sanitizePostHtml(`<a href="${href}">x</a>`)).toContain(rel);
    }
  });

  it("reads attribute names case-insensitively", () => {
    expect(sanitizePostHtml('<a HREF="https://x.example">x</a>')).toContain('rel="noopener');
    expect(sanitizePostHtml('<pre><code CLASS="language-js">x</code></pre>')).toBe(
      '<pre><code class="language-js">x</code></pre>'
    );
    expect(sanitizePostHtml('<IMG SRC="/a.png" ONERROR="alert(1)">')).toBe('<img src="/a.png">');
  });

  it("drops iframes, forms, svg and style with their content", () => {
    const out = sanitizePostHtml(
      '<iframe src="https://x"></iframe><form><input name=a><button>b</button></form>' +
        "<svg><script>1</script></svg><style>body{}</style><p>kept</p>"
    );
    expect(out).toBe("<p>kept</p>");
  });

  it("strips style and class, keeping only language-* on code", () => {
    expect(sanitizePostHtml('<p style="position:fixed" class="x">t</p>')).toBe("<p>t</p>");
    expect(sanitizePostHtml('<pre><code class="language-ts evil">x</code></pre>')).toBe(
      '<pre><code class="language-ts">x</code></pre>'
    );
  });

  it("unwraps unknown tags but keeps their text", () => {
    expect(sanitizePostHtml("<custom-el><b>bold</b></custom-el>")).toBe("<b>bold</b>");
  });

  it("drops HTML comments, so content cannot smuggle template markers", () => {
    expect(sanitizePostHtml("<p>a<!--main-->b</p>")).toBe("<p>ab</p>");
  });

  it("escapes text and attribute values it re-emits", () => {
    expect(sanitizePostHtml('<p title="x">1 &lt; 2 &amp; 3</p>')).toBe("<p>1 &lt; 2 &amp; 3</p>");
    expect(sanitizePostHtml('<abbr title="&quot;&gt;<script>">a</abbr>')).toBe(
      '<abbr title="&quot;&gt;&lt;script&gt;">a</abbr>'
    );
  });

  it("marks external links and never emits target", () => {
    expect(sanitizePostHtml('<a href="https://x.example" target="_blank">x</a>')).toBe(
      '<a href="https://x.example" rel="noopener noreferrer nofollow ugc">x</a>'
    );
    expect(sanitizePostHtml('<a href="/local">x</a>')).toBe('<a href="/local">x</a>');
  });

  it("drops ids, which could clobber globals on the host page", () => {
    expect(sanitizePostHtml('<h2 id="config">a</h2>')).toBe("<h2>a</h2>");
  });

  it("closes what the input left open", () => {
    expect(sanitizePostHtml("<p><b>x")).toBe("<p><b>x</b></p>");
  });

  it("stays linear on thousands of unclosed tags", () => {
    const start = Date.now();
    const out = sanitizePostHtml("<div>".repeat(20000) + "x");
    expect(Date.now() - start).toBeLessThan(1000);
    expect(out).toContain("x");
  });

  it("bounds the work on oversized hostile input", () => {
    const start = Date.now();
    sanitizePostHtml("<div>".repeat(500000));
    expect(Date.now() - start).toBeLessThan(2000);
  });

  it("does not overflow the stack on deep nesting, and caps output depth", () => {
    const out = sanitizePostHtml(`${"<b>".repeat(20000)}x${"</b>".repeat(20000)}`);
    expect(out).toContain("x");
    expect(out.match(/<b>/g)?.length).toBe(64);
    expect(stripHtml(`${"<b>".repeat(20000)}x`)).toBe("x");
  });

  it("keeps tables and figures", () => {
    const html =
      "<figure><img src=\"https://x/a.png\" alt=\"a\"><figcaption>c</figcaption></figure>" +
      "<table><thead><tr><th>h</th></tr></thead><tbody><tr><td>d</td></tr></tbody></table>";
    expect(sanitizePostHtml(html)).toBe(html);
  });

  it("returns empty for empty input", () => {
    expect(sanitizePostHtml("")).toBe("");
  });
});

describe("renderMarkdown", () => {
  it("renders markdown", async () => {
    expect(await renderMarkdown("# Hi\n\n**b**")).toContain("<strong>b</strong>");
  });

  it("sanitizes raw HTML inside markdown", async () => {
    const out = await renderMarkdown("Hello\n\n<img src=x onerror=alert(1)>\n\n<script>1</script>");
    expect(out).not.toMatch(/onerror|<script/i);
  });

  it("keeps fenced code highlighting and does not mangle the code", async () => {
    const out = await renderMarkdown("```ts\nconst a = 1 < 2;\n```");
    expect(out.trim()).toBe('<pre><code class="language-ts">const a = 1 &lt; 2;\n</code></pre>');
  });
});

describe("renderPostHtml / toSafePost", () => {
  it("sanitizes a stored contentHtml instead of trusting it", async () => {
    const html = await renderPostHtml(post({ contentHtml: "<p>x</p><script>1</script>" }));
    expect(html).toBe("<p>x</p>");
  });

  it("renders the markdown when there is no contentHtml", async () => {
    const safe = await toSafePost(post());
    expect(safe.contentHtml).toContain("<h1");
    expect(safe.content).toBe("# Hi\n\nBody");
  });

  it("list variant sanitizes stored HTML and renders nothing", () => {
    expect(toSafeListPost(post()).contentHtml).toBeUndefined();
    expect(toSafeListPost(post({ contentHtml: "<script>1</script>" })).contentHtml).toBe("");
  });
});

describe("stripHtml", () => {
  it("reduces markup to text", () => {
    expect(stripHtml("<p>Hello <b>there</b></p><p>again</p>")).toBe("Hello there again");
  });

  it("removes script content rather than exposing it as text", () => {
    expect(stripHtml("<script>alert(1)</script>ok")).toBe("ok");
  });

  it("returns plain text, not entity-escaped HTML", () => {
    expect(stripHtml("Tom &amp; Jerry, a < b")).toBe("Tom & Jerry, a < b");
  });
});

describe("isSafeUrl", () => {
  it("allows relative, http(s) and mailto", () => {
    for (const u of ["/a", "a/b:c", "#x", "?q=1", "https://x", "http://x", "mailto:a@b", "//x"]) {
      expect(isSafeUrl(u)).toBe(true);
    }
  });

  it("refuses other schemes", () => {
    for (const u of ["javascript:1", " javascript:1", "java\tscript:1", "vbscript:1", "data:x", "file:///etc"]) {
      expect(isSafeUrl(u)).toBe(false);
    }
  });
});
