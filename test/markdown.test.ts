import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { isMarkdownPath, renderMarkdown } from "../src/markdown.ts";

const PLAN = `# Migration plan

Intro paragraph.

## Risks

The rollback path is untested.

- data loss
- downtime

## Timeline

Two weeks.
`;

function idsOf(source: string): string[] {
  return renderMarkdown(source).blocks.map((block) => block.id);
}

function blockById(source: string, id: string) {
  const found = renderMarkdown(source).blocks.find((block) => block.id === id);
  assert.ok(found, `no block with id ${id}`);
  return found;
}

describe("isMarkdownPath", () => {
  test("matches the markdown extensions, case-insensitively", () => {
    assert.equal(isMarkdownPath("/tmp/PLAN.md"), true);
    assert.equal(isMarkdownPath("/tmp/notes.MARKDOWN"), true);
    assert.equal(isMarkdownPath("/tmp/page.mdx"), true);
    assert.equal(isMarkdownPath("/tmp/plan.html"), false);
    assert.equal(isMarkdownPath("/tmp/mdfile"), false);
  });
});

describe("document shell", () => {
  test("is a complete standalone document", () => {
    const { html } = renderMarkdown(PLAN);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /<meta charset="utf-8">/);
    assert.match(html, /<title>Migration plan<\/title>/);
    assert.match(html, /<style>/);
    assert.match(html, /<main id="doc">/);
    assert.match(html, /<\/html>\n?$/);
  });

  test("honours both the media query and the forced-theme attribute", () => {
    // The toolbar forces a theme by setting `data-theme`; an artifact carrying
    // only the media query keeps following the OS and looks broken next to it.
    const { html } = renderMarkdown(PLAN);
    assert.match(html, /@media \(prefers-color-scheme: dark\)/);
    assert.match(html, /:root:not\(\[data-theme="light"\]\)/);
    assert.match(html, /:root\[data-theme="dark"\]/);
  });

  test("title can be overridden", () => {
    assert.match(renderMarkdown("text", { title: "Q3 <plan>" }).html, /<title>Q3 &lt;plan&gt;<\/title>/);
  });
});

describe("ids", () => {
  test("headings become sections with slug ids", () => {
    const { html } = renderMarkdown(PLAN);
    assert.match(html, /<section id="risks">/);
    assert.match(html, /<h2 id="risks-h">Risks<\/h2>/);
  });

  test("a section runs until the next heading of equal or higher level", () => {
    const { html } = renderMarkdown("# A\n\n## B\n\ntext\n\n# C\n\ntail\n");
    // B nests inside A and closes before C opens.
    assert.match(html, /<section id="a">[\s\S]*<section id="b">[\s\S]*<\/section>[\s\S]*<\/section>\n<section id="c">/);
  });

  test("non-heading blocks hang off the nearest heading", () => {
    const ids = idsOf(PLAN);
    assert.ok(ids.includes("risks-b1"), ids.join(","));
    assert.ok(ids.includes("risks-b2"), ids.join(","));
  });

  test("stay stable when an unrelated section changes", () => {
    // The whole point of numbering per section: an edit in Risks must not
    // renumber Timeline, or every anchor there is orphaned on the next morph.
    const edited = PLAN.replace("The rollback path is untested.", "The rollback path is untested.\n\nAlso: no backups.");
    const before = idsOf(PLAN).filter((id) => id.startsWith("timeline"));
    const after = idsOf(edited).filter((id) => id.startsWith("timeline"));
    assert.deepEqual(after, before);
    assert.ok(before.length > 0);
  });

  test("repeated headings never produce a duplicate id", () => {
    // `diffDocuments` keeps only the first element with a given id, so a
    // duplicate makes a whole section invisible to the diff.
    const ids = idsOf("## Setup\n\none\n\n## Setup\n\ntwo\n\n## Setup\n\nthree\n");
    assert.deepEqual(new Set(ids).size, ids.length);
    assert.ok(ids.includes("setup"));
    assert.ok(ids.includes("setup-2"));
    assert.ok(ids.includes("setup-3"));
    assert.ok(ids.includes("setup-2-b1"));
  });

  test("every emitted element carries an id, and no id repeats", () => {
    const source = [
      "# Doc",
      "",
      "para",
      "",
      "- one",
      "- two",
      "",
      "> quoted",
      "",
      "| a | b |",
      "| - | - |",
      "| 1 | 2 |",
      "",
      "---",
      "",
      "```js",
      "let x = 1;",
      "```",
      "",
    ].join("\n");
    const { html, blocks } = renderMarkdown(source);
    const emitted = [...html.matchAll(/ id="([^"]+)"/g)].map((match) => match[1]!);
    assert.deepEqual(new Set(emitted).size, emitted.length);
    // Every id in the markup is in the source map, and vice versa.
    assert.deepEqual(new Set(emitted), new Set([...blocks.map((block) => block.id), "doc"]));
    // Blocks with no id would be invisible to the diff.
    const tags = html.match(/<(p|ul|ol|li|blockquote|pre|table|hr|section|h[1-6])\b(?![^>]* id=)/g);
    assert.equal(tags, null);
  });

  test("a heading with no sluggable text still gets a stable id", () => {
    const { html } = renderMarkdown("# !!!\n\ntext\n");
    assert.match(html, /<section id="doc-section">/);
  });
});

describe("escaping", () => {
  test("HTML in the source renders as text, never as markup", () => {
    const { html } = renderMarkdown("A <script>alert(1)</script> tag & an <img onerror=x>.\n");
    assert.doesNotMatch(html.split("</style>")[1]!, /<script|<img onerror/);
    assert.match(html, /&lt;script&gt;alert\(1\)&lt;\/script&gt;/);
    assert.match(html, /&amp; an/);
  });

  test("code blocks escape their contents too", () => {
    const { html } = renderMarkdown("```html\n<b>hi</b>\n```\n");
    assert.match(html, /<pre id="doc-b1"><code class="language-html">&lt;b&gt;hi&lt;\/b&gt;<\/code><\/pre>/);
  });

  test("executable link schemes are dropped, keeping the text", () => {
    const { html } = renderMarkdown("[click](javascript:alert(1))\n");
    assert.doesNotMatch(html, /javascript:/);
    assert.match(html, /<p id="doc-b1">click<\/p>/);
  });
});

describe("inline", () => {
  test("renders the common subset", () => {
    const { html } = renderMarkdown(
      "**bold** and *italic* and `code` and ~~gone~~ and [text](/a) and ![alt](/i.png) and <https://x.test/>\n",
    );
    assert.match(html, /<strong>bold<\/strong>/);
    assert.match(html, /<em>italic<\/em>/);
    assert.match(html, /<code>code<\/code>/);
    assert.match(html, /<del>gone<\/del>/);
    assert.match(html, /<a href="\/a">text<\/a>/);
    assert.match(html, /<img src="\/i\.png" alt="alt">/);
    assert.match(html, /<a href="https:\/\/x\.test\/">https:\/\/x\.test\/<\/a>/);
  });

  test("does not run inside a fenced code block", () => {
    const { html } = renderMarkdown("```\n**not bold** and `not code` and [not](a link)\n```\n");
    assert.doesNotMatch(html, /<strong>/);
    assert.match(html, /\*\*not bold\*\* and `not code` and \[not\]\(a link\)/);
  });

  test("does not run inside a code span", () => {
    const { html } = renderMarkdown("Use `**literal**` here.\n");
    assert.match(html, /<code>\*\*literal\*\*<\/code>/);
    assert.doesNotMatch(html, /<strong>/);
  });

  test("leaves snake_case alone", () => {
    assert.match(renderMarkdown("call some_long_name now\n").html, /some_long_name/);
  });
});

describe("blocks", () => {
  test("nested lists nest", () => {
    const source = ["- outer", "  - inner a", "  - inner b", "- second", ""].join("\n");
    const { html } = renderMarkdown(source);
    assert.match(html, /<ul id="doc-b1">/);
    assert.match(html, /<li id="doc-b2">outer\n<ul id="doc-b3">/);
    assert.match(html, /inner a[\s\S]*inner b[\s\S]*<\/ul>\n<\/li>/);
    assert.match(html, /second/);
  });

  test("ordered lists keep their start", () => {
    const { html } = renderMarkdown("3. three\n4. four\n");
    assert.match(html, /<ol id="doc-b1" start="3">/);
  });

  test("tables render with alignment", () => {
    const source = ["| Item | Cost |", "| :--- | ---: |", "| Rack | 12 |", "| Fan | 3 |", ""].join("\n");
    const { html } = renderMarkdown(source);
    assert.match(html, /<table id="doc-b1">/);
    assert.match(html, /<th style="text-align:left">Item<\/th>/);
    assert.match(html, /<th style="text-align:right">Cost<\/th>/);
    assert.match(html, /<td style="text-align:left">Rack<\/td><td style="text-align:right">12<\/td>/);
    assert.equal((html.match(/<tr>/g) ?? []).length, 3);
  });

  test("blockquotes, rules and indented code", () => {
    const { html } = renderMarkdown("> quoted\n\n***\n\n    indented();\n");
    assert.match(html, /<blockquote id="doc-b1">\n<p id="doc-b2">quoted<\/p>\n<\/blockquote>/);
    assert.match(html, /<hr id="doc-b3">/);
    assert.match(html, /<pre id="doc-b4"><code>indented\(\);<\/code><\/pre>/);
  });
});

describe("source map", () => {
  test("points at the source lines a block came from", () => {
    // 1: # Migration plan   2: blank   3: Intro paragraph.   4: blank
    // 5: ## Risks          6: blank   7: The rollback...     8: blank
    // 9: - data loss      10: - downtime
    assert.equal(blockById(PLAN, "migration-plan-h").line, 1);
    assert.deepEqual(
      { line: blockById(PLAN, "migration-plan-b1").line, end: blockById(PLAN, "migration-plan-b1").endLine },
      { line: 3, end: 3 },
    );
    assert.equal(blockById(PLAN, "risks-h").line, 5);
    assert.equal(blockById(PLAN, "risks-b1").line, 7);

    const list = blockById(PLAN, "risks-b2");
    assert.deepEqual({ line: list.line, end: list.endLine }, { line: 9, end: 10 });
    assert.equal(blockById(PLAN, "risks-b3").line, 9);
    assert.equal(blockById(PLAN, "risks-b4").line, 10);
  });

  test("a section spans from its heading to its last line", () => {
    const risks = blockById(PLAN, "risks");
    assert.equal(risks.kind, "section");
    assert.deepEqual({ line: risks.line, end: risks.endLine }, { line: 5, end: 10 });
  });

  test("a multi-line paragraph reports its whole range", () => {
    const source = "# T\n\nfirst line\nsecond line\nthird line\n";
    const paragraph = blockById(source, "t-b1");
    assert.deepEqual({ line: paragraph.line, end: paragraph.endLine }, { line: 3, end: 5 });
  });

  test("a fenced block spans its fences", () => {
    const source = "intro\n\n```ts\nconst a = 1;\nconst b = 2;\n```\n\nafter\n";
    const code = blockById(source, "doc-b2");
    assert.deepEqual({ line: code.line, end: code.endLine, kind: code.kind }, { line: 3, end: 6, kind: "pre" });
  });

  test("carries a plain-text label for each block", () => {
    assert.equal(blockById(PLAN, "risks-b1").text, "The rollback path is untested.");
    assert.equal(blockById(PLAN, "risks").text, "Risks");
    assert.equal(blockById(PLAN, "risks-b3").text, "data loss");
  });
});

describe("degenerate input", () => {
  test("empty source still produces a document", () => {
    const { html, blocks } = renderMarkdown("");
    assert.match(html, /<main id="doc">/);
    assert.deepEqual(blocks, []);
  });

  test("an unterminated fence runs to the end rather than swallowing the file", () => {
    // Artifacts are read while they are being written, so half a code block is
    // routine and must not turn the rest of the document into prose.
    const { html } = renderMarkdown("# T\n\n```\nlet a = 1;\n");
    assert.match(html, /<pre id="t-b1"><code>let a = 1;<\/code><\/pre>/);
  });
});
