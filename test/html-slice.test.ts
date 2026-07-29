// The tag-balancing scan behind churn and section replacement.
//
// This runs on the server, where there is no DOM, so every case here is one a
// real parser would get right for free. The bar it has to clear is not
// completeness — it is never being *confidently wrong*, because a wrong slice
// silently attributes one section's rewrites to another.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { replaceSection, sectionsOf } from "../src/html-slice.ts";

describe("sectionsOf", () => {
  test("captures an element's full markup by id", () => {
    const sections = sectionsOf(`<body><section id="a"><p>one</p></section></body>`);
    assert.equal(sections.get("a"), `<section id="a"><p>one</p></section>`);
  });

  test("captures nested ids independently", () => {
    const sections = sectionsOf(`<section id="outer"><p id="inner">text</p></section>`);
    assert.equal(sections.get("inner"), `<p id="inner">text</p>`);
    assert.ok(sections.get("outer")?.includes("inner"));
  });

  test("handles same-tag nesting without closing early", () => {
    const sections = sectionsOf(`<div id="a"><div><div>deep</div></div></div><p>after</p>`);
    assert.equal(sections.get("a"), `<div id="a"><div><div>deep</div></div></div>`);
  });

  test("void elements do not swallow what follows", () => {
    const sections = sectionsOf(`<section id="a"><img src="x.png"><br><p>after</p></section>`);
    assert.ok(sections.get("a")?.endsWith("</section>"));
  });

  test("a self-closing tag does not push onto the stack", () => {
    const sections = sectionsOf(`<section id="a"><hr/><p>x</p></section>`);
    assert.ok(sections.get("a")?.includes("<p>x</p>"));
  });

  test("markup inside script and style is not tokenized", () => {
    // A `</div>` inside a string literal used to close a real element and
    // shift every subsequent slice by one level.
    const html = `<section id="a"><script>var s = "</div><section id='fake'>";</script><p>real</p></section>`;
    const sections = sectionsOf(html);
    assert.ok(sections.get("a")?.includes("<p>real</p>"));
    assert.equal(sections.has("fake"), false);
  });

  test("comments are ignored", () => {
    const sections = sectionsOf(`<section id="a"><!-- <div id="ghost"> --><p>x</p></section>`);
    assert.equal(sections.has("ghost"), false);
    assert.ok(sections.get("a")?.includes("<p>x</p>"));
  });

  test("single-quoted and unquoted ids are both found", () => {
    const sections = sectionsOf(`<div id='a'>one</div><div id=b>two</div>`);
    assert.ok(sections.has("a"));
    assert.ok(sections.has("b"));
  });

  test("first occurrence wins for a duplicate id", () => {
    // Matching diffDocuments, which indexes ids first-occurrence-wins. Guessing
    // differently here would make the two disagree about the same document.
    const sections = sectionsOf(`<p id="a">first</p><p id="a">second</p>`);
    assert.ok(sections.get("a")?.includes("first"));
  });

  test("an unclosed element is dropped rather than mis-bracketed", () => {
    const sections = sectionsOf(`<div id="a"><span>oops<p id="b">real</p></div>`);
    assert.ok(sections.get("b")?.includes("real"));
  });

  test("an empty document yields nothing and does not throw", () => {
    assert.equal(sectionsOf("").size, 0);
    assert.equal(sectionsOf("just text").size, 0);
  });

  test("attributes containing angle brackets do not derail the scan", () => {
    const sections = sectionsOf(`<div id="a" title="a > b"><p>x</p></div>`);
    assert.ok(sections.get("a")?.includes("<p>x</p>"));
  });
});

describe("replaceSection", () => {
  test("swaps one element and leaves the rest byte-identical", () => {
    const html = `<body><p id="a">old</p><p id="b">keep</p></body>`;
    const next = replaceSection(html, "a", `<p id="a">new</p>`);
    assert.equal(next, `<body><p id="a">new</p><p id="b">keep</p></body>`);
  });

  test("returns null for an id it cannot bracket, rather than mangling the file", () => {
    // A half-applied revert is worse than a refused one.
    assert.equal(replaceSection(`<p id="a">x</p>`, "missing", "<p>y</p>"), null);
  });
});
