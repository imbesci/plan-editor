import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { TEMPLATES, inspectArtifact, renderTemplate, type Finding } from "../src/doctor.ts";

const rules = (findings: Finding[]): string[] => findings.map((f) => f.rule);
const byRule = (findings: Finding[], rule: string): Finding[] =>
  findings.filter((f) => f.rule === rule);

/**
 * A document that follows the contract in every respect: stable ids on the
 * sections, both dark-mode selectors, only local sibling assets, no committed
 * SDK tag. Nothing may fire on this — a linter that cries on a compliant file is
 * one people learn to ignore, and then it catches nothing at all.
 */
const GOOD = `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<title>Good</title>
<style>
  :root { --bg: #fbfaf8; --fg: #1c1b19; }
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) { --bg: #131211; --fg: #f0ede8; }
  }
  :root[data-theme="dark"] { --bg: #131211; --fg: #f0ede8; }
  body { background: var(--bg); color: var(--fg); }
</style>
</head>
<body>
<header id="masthead"><h1>Good</h1></header>
<section id="idea">
  <h2>The idea</h2>
  <p>Short enough that no element is a slab.</p>
  <p>See <a href="https://example.com">the write-up</a> and <img src="./logo.png" alt="logo">.</p>
</section>
<section id="risks">
  <h2>Risks</h2>
  <div class="card" id="risk-one"><h3>One</h3><p>Mitigated.</p></div>
</section>
</body>
</html>`;

const BAD = `<!doctype html>
<html lang="en">
<head>
<style>
  body { color: #111; background: #fff; }
  @media (prefers-color-scheme: dark) { :root { --bg: #000; } }
</style>
</head>
<body>
<script src="/sdk.js" defer></script>
<section><h2>Anonymous</h2><p>No id here.</p></section>
<div id="dup">first</div>
<div id="dup">second</div>
<h2>A heading leading nothing anchorable</h2>
<img src="https://cdn.example.com/logo.png" alt="">
<link href="../shared/style.css" rel="stylesheet">
<a href="/absolute/thing.html">absolute</a>
<p>${"word ".repeat(1000)}</p>
</body>
</html>`;

describe("inspectArtifact", () => {
  test("a compliant document produces no findings at all", () => {
    assert.deepEqual(inspectArtifact(GOOD), []);
  });

  test("every rule fires on a document that breaks every rule", () => {
    const found = new Set(rules(inspectArtifact(BAD)));
    for (const rule of [
      "duplicate-ids",
      "missing-section-ids",
      "no-theme-support",
      "sdk-already-injected",
      "huge-element",
      "external-references",
    ]) {
      assert.ok(found.has(rule), `expected ${rule} to fire`);
    }
  });

  test("duplicate ids are an error, because the diff cannot see the second one", () => {
    // `diffDocuments` indexes ids first-occurrence-wins: the second element with a
    // duplicate id is invisible to it, so no change inside it is ever attributed.
    const duplicates = byRule(inspectArtifact(BAD), "duplicate-ids");
    assert.equal(duplicates.length, 1);
    assert.equal(duplicates[0]?.severity, "error");
    assert.match(duplicates[0]?.message ?? "", /"dup"/);
  });

  test("a body with no ids anywhere is an error", () => {
    const findings = inspectArtifact("<html><body><div><p>nothing anchorable</p></div></body></html>");
    const noIds = byRule(findings, "no-ids-at-all");
    assert.equal(noIds.length, 1);
    assert.equal(noIds[0]?.severity, "error");
  });

  test("no-ids-at-all stays quiet as soon as one id exists", () => {
    const findings = inspectArtifact('<html><body><div id="only">x</div></body></html>');
    assert.equal(byRule(findings, "no-ids-at-all").length, 0);
  });

  test("id-less sections and the headings they lead are warnings, reported once each", () => {
    const missing = byRule(inspectArtifact(BAD), "missing-section-ids");
    // The <section> and the loose <h2>, but not the <h2> inside the section —
    // saying the same thing twice about one block is noise.
    assert.equal(missing.length, 2);
    for (const finding of missing) {
      assert.equal(finding.severity, "warning");
      assert.ok(finding.fix && finding.fix.length > 0);
    }
  });

  test("a nested section is not flagged — it inherits its parent's anchor", () => {
    const html = '<body><section id="outer"><section><h3>Inner</h3></section></section></body>';
    assert.equal(byRule(inspectArtifact(html), "missing-section-ids").length, 0);
  });

  test("missing-section-ids caps at 20 findings plus a count of the rest", () => {
    const many = `<body>${'<section><h2>Anonymous</h2><p id="p">x</p></section>'.repeat(25)}</body>`;
    const missing = byRule(inspectArtifact(many), "missing-section-ids");
    assert.equal(missing.length, 21);
    assert.equal(missing.filter((f) => f.severity === "warning").length, 20);
    const tail = missing[20];
    assert.equal(tail?.severity, "info");
    assert.match(tail?.message ?? "", /and 5 more/);
  });

  test("the media query alone is not theme support", () => {
    // plan-editor forces a theme by setting data-theme on the root. An artifact
    // that only has the media query keeps following the OS and sits light inside
    // a chrome that just went dark, which reads as a rendering bug.
    const findings = byRule(inspectArtifact(BAD), "no-theme-support");
    assert.equal(findings.length, 1);
    assert.equal(findings[0]?.severity, "warning");
  });

  test("no-theme-support stays quiet for a document with no colours of its own", () => {
    const html = '<html><head><style>p { margin: 0; }</style></head><body><p id="p">x</p></body></html>';
    assert.equal(byRule(inspectArtifact(html), "no-theme-support").length, 0);
  });

  test("a committed sdk.js tag is reported, because injection would add a second", () => {
    const findings = byRule(inspectArtifact(BAD), "sdk-already-injected");
    assert.equal(findings.length, 1);
    assert.match(findings[0]?.message ?? "", /sdk\.js/);
  });

  test("huge-element reports the text leaf, not every ancestor of it", () => {
    const huge = byRule(inspectArtifact(BAD), "huge-element");
    assert.equal(huge.length, 1);
    assert.match(huge[0]?.message ?? "", /^<p>/);
  });

  test("a long section made of ordinary paragraphs is not a slab", () => {
    // The annotation and the diff both land on the paragraph, so flagging the
    // section as well would fire on every well-formed long document.
    const paragraphs = `<p>${"word ".repeat(300)}</p>`.repeat(6);
    const html = `<body><section id="long">${paragraphs}</section></body>`;
    assert.equal(byRule(inspectArtifact(html), "huge-element").length, 0);
  });

  test("external references distinguish assets from hyperlinks", () => {
    const refs = byRule(inspectArtifact(BAD), "external-references");
    assert.equal(refs.length, 3);
    assert.match(refs[0]?.message ?? "", /loads from the network/);
    assert.match(refs[1]?.message ?? "", /outside the artifact directory/);
    assert.match(refs[2]?.message ?? "", /absolute path/);
    // An <a> to an external site resolves fine in an export; it is not an asset.
    const link = '<body><p id="p">see <a href="https://example.com">this</a></p></body>';
    assert.equal(byRule(inspectArtifact(link), "external-references").length, 0);
  });

  test("fragments, mailto and data URIs are left alone", () => {
    const html =
      '<body><p id="p"><a href="#top">top</a><a href="mailto:a@b.c">mail</a>' +
      '<img src="data:image/gif;base64,R0lGOD" alt=""><img src="./a/../b.png" alt=""></p></body>';
    assert.equal(byRule(inspectArtifact(html), "external-references").length, 0);
  });

  test("findings carry 1-indexed line numbers", () => {
    const html = '<body>\n<div id="a">x</div>\n<div id="a">y</div>\n</body>';
    const duplicate = byRule(inspectArtifact(html), "duplicate-ids")[0];
    assert.equal(duplicate?.line, 3);
    assert.match(duplicate?.message ?? "", /line 2/);
  });

  test("markup inside a comment is not markup", () => {
    const html = '<body><!-- <section>commented out</section> --><div id="a">x</div></body>';
    assert.equal(byRule(inspectArtifact(html), "missing-section-ids").length, 0);
  });

  test("selectors inside <style> are never mistaken for elements", () => {
    // The tag scanner has to skip raw-text bodies, or `a > section` in a
    // stylesheet becomes an id-less section the author cannot find.
    const html =
      '<html><head><style>a > section { color: #111 } :root[data-theme="dark"] { color: #eee }</style></head>' +
      '<body><div id="a">x</div></body></html>';
    assert.deepEqual(inspectArtifact(html), []);
  });
});

describe("inspectArtifact on malformed input", () => {
  const broken = [
    "",
    "not html at all",
    "<<<>>>",
    "<div><p>unclosed",
    "</div></section></p>",
    "<!-- unterminated comment <section>",
    "<div id=><p id",
    '<section id="a"',
    "<a href=",
    "<script>if (a < b) { }</script>",
    "<p>&amp;&lt;&#39;</p>",
    "<DIV ID='Caps'><SECTION>loud</SECTION></DIV>",
  ];

  for (const html of broken) {
    test(`does not throw on ${JSON.stringify(html.slice(0, 32))}`, () => {
      // A linter that takes down the CLI is worse than one that says nothing, and
      // a malformed artifact is exactly when the author most needs it to speak.
      const findings = inspectArtifact(html);
      assert.ok(Array.isArray(findings));
      for (const finding of findings) {
        assert.ok(["error", "warning", "info"].includes(finding.severity));
        assert.ok(typeof finding.rule === "string" && finding.rule.length > 0);
        assert.ok(typeof finding.message === "string" && finding.message.length > 0);
      }
    });
  }

  test("survives deeply nested and pathologically repeated markup", () => {
    assert.ok(Array.isArray(inspectArtifact("<div>".repeat(5000))));
    assert.ok(Array.isArray(inspectArtifact("</div>".repeat(5000))));
  });
});

describe("templates", () => {
  const kinds = ["plan", "spec", "report"] as const;

  for (const kind of kinds) {
    test(`${kind} passes its own linter with no errors`, () => {
      // The whole point of shipping templates: telling an author to add ids after
      // the fact never worked, because by then the file exists and the ids are the
      // first thing a rewrite drops.
      const findings = inspectArtifact(renderTemplate(kind, "Test Artifact"));
      assert.deepEqual(
        findings.filter((f) => f.severity === "error"),
        [],
      );
      assert.deepEqual(findings, []);
    });

    test(`${kind} anchors every section and supports the theme toggle`, () => {
      const html = renderTemplate(kind, "Test Artifact");
      assert.match(html, /:root\[data-theme="dark"\]/);
      assert.match(html, /@media \(prefers-color-scheme: dark\)/);
      assert.match(html, /:root:not\(\[data-theme="light"\]\)/);
      for (const section of html.match(/<section[^>]*>/g) ?? []) {
        assert.match(section, /\sid="/, `${section} has no id`);
      }
      assert.ok((html.match(/<section /g) ?? []).length >= 4);
    });

    test(`${kind} is a complete standalone document with the title in it`, () => {
      const html = TEMPLATES[kind]("Quarterly Review");
      assert.match(html, /^<!doctype html>/);
      assert.match(html, /<title>Quarterly Review<\/title>/);
      assert.match(html, /<h1>Quarterly Review<\/h1>/);
      assert.match(html, /<\/html>\s*$/);
      // Nothing is injected but the SDK tag, so the file must not ship with one.
      assert.doesNotMatch(html, /sdk\.js/);
    });
  }

  test("the title is escaped, so a stray angle bracket cannot break the document", () => {
    const html = renderTemplate("plan", '<script>alert(1)</script> & "quotes"');
    assert.doesNotMatch(html, /<script>alert/);
    assert.match(html, /&lt;script&gt;/);
    assert.deepEqual(
      inspectArtifact(html).filter((f) => f.severity === "error"),
      [],
    );
  });

  test("renderTemplate and TEMPLATES agree", () => {
    for (const kind of kinds) {
      assert.equal(renderTemplate(kind, "X"), TEMPLATES[kind]("X"));
    }
  });
});

describe("diagram-without-id", () => {
  const wrap = (inner: string) => `<html><body><section id="s">${inner}</section></body></html>`;
  const flagged = (html: string) => inspectArtifact(html).filter((f) => f.rule === "diagram-without-id");

  test("flags a Mermaid container with no id", () => {
    // Diagram identity is the container id. The predecessor tool keyed diagrams
    // by ordinal position, so inserting one above another silently reassigned
    // every saved scene to the wrong diagram.
    const findings = flagged(wrap(`<pre class="mermaid">graph TD; A--&gt;B;</pre>`));
    assert.equal(findings.length, 1);
    assert.equal(findings[0]!.severity, "warning");
    assert.match(findings[0]!.fix ?? "", /id/);
  });

  test("accepts one that has an id", () => {
    assert.deepEqual(flagged(wrap(`<pre class="mermaid" id="flow">graph TD; A--&gt;B;</pre>`)), []);
  });

  test("for a markdown fence the id belongs on the <pre>, not the <code>", () => {
    assert.deepEqual(flagged(wrap(`<pre id="d"><code class="language-mermaid">graph TD;</code></pre>`)), []);
    assert.equal(flagged(wrap(`<pre><code class="language-mermaid">graph TD;</code></pre>`)).length, 1);
  });

  test("a document with no diagrams is untouched by the rule", () => {
    assert.deepEqual(flagged(wrap(`<p id="p">Just prose.</p>`)), []);
  });
});
