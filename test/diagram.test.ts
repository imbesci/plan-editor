import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { JSDOM } from "jsdom";

import { diagramHosts, diagramId, mermaidSource, nodeLabel, sourceHash } from "../src/sdk/diagram.ts";

// No globals are installed here, unlike test/morph.test.ts — and that is worth
// stating rather than leaving as an accident. Everything under test is reached
// through instance methods on nodes belonging to a jsdom document
// (`querySelectorAll`, `closest`, `cloneNode`, `ownerDocument`), so none of it
// reads a bare DOM constructor the way idiomorph does. That keeps this file
// clear of the aliasing hazard morph.test.ts documents, where copying jsdom's
// window onto globalThis makes `performance` delegate to itself until the stack
// blows.
//
// The rendering path is deliberately not exercised here: it needs a real browser
// (mermaid measures text by laying it out) and a live server to fetch 2.6MB
// from. What a unit test can pin down is everything a wrong answer would break
// silently — which element is the diagram, whether it changed, and what its
// nodes are called.

function parse(html: string): Document {
  return new JSDOM(`<!doctype html><html><body>${html}</body></html>`).window.document;
}

describe("mermaidSource", () => {
  test("reads all three host shapes", () => {
    const document = parse(`
      <pre class="mermaid" id="one">graph TD; A --> B</pre>
      <div class="mermaid" id="two">graph TD; C --> D</div>
      <pre id="three"><code class="language-mermaid">graph TD; E --> F</code></pre>
    `);

    assert.equal(mermaidSource(document.getElementById("one")!), "graph TD; A --> B");
    assert.equal(mermaidSource(document.getElementById("two")!), "graph TD; C --> D");
    assert.equal(mermaidSource(document.getElementById("three")!), "graph TD; E --> F");
  });

  test("decodes entities, because an escaped arrow is not an arrow", () => {
    // How every markdown fence arrives: src/markdown.ts emits code through
    // escapeHtml, so the whole diagram is escaped by the time it is markup.
    const document = parse(`<pre id="one"><code class="language-mermaid">graph TD; A --&gt; B</code></pre>`);
    assert.equal(mermaidSource(document.getElementById("one")!), "graph TD; A --> B");
  });

  test("keeps a <br> in a label, which textContent would delete outright", () => {
    // Parsed into a real element by the browser, and a <br> contributes no
    // character to textContent — read that way, the label reaches mermaid as
    // "Deployto prod" and the author's line break is gone without a trace.
    const document = parse(`<pre class="mermaid" id="one">graph TD; C[Deploy<br/>to prod]</pre>`);
    assert.equal(mermaidSource(document.getElementById("one")!), "graph TD; C[Deploy<br/>to prod]");
  });

  test("drops the markup a syntax highlighter leaves behind", () => {
    const document = parse(
      `<pre class="mermaid" id="one"><span class="tok">graph</span> TD; A --&gt; B</pre>`,
    );
    assert.equal(mermaidSource(document.getElementById("one")!), "graph TD; A --> B");
  });

  test("strips the common indentation and keeps the relative indentation", () => {
    // A `mindmap` nests by indentation, so flattening every line — the naive
    // per-line trim — would silently rewrite the diagram's structure.
    const document = parse(`<pre class="mermaid" id="one">
      mindmap
        root
          child
    </pre>`);
    assert.equal(mermaidSource(document.getElementById("one")!), "mindmap\n  root\n    child");
  });
});

describe("sourceHash", () => {
  test("is stable for the same source", () => {
    assert.equal(sourceHash("graph TD; A --> B"), sourceHash("graph TD; A --> B"));
  });

  test("ignores reindentation and line-ending noise", () => {
    assert.equal(sourceHash("graph TD\n  A --> B"), sourceHash("graph TD\n\tA   -->   B  "));
  });

  test("changes when the diagram changes", () => {
    assert.notEqual(sourceHash("graph TD; A --> B"), sourceHash("graph TD; A --> C"));
  });

  test("changes when only a label's case changes", () => {
    // `hashText` lowercases, because for prose "Risks" -> "risks" is formatting.
    // For a diagram it is a visible relabel, and a diagram that did not redraw
    // after an edit looks exactly like an edit that never applied.
    assert.notEqual(sourceHash("graph TD; A[Start]"), sourceHash("graph TD; A[start]"));
  });
});

describe("diagramId", () => {
  test("is the host's own id when it has one", () => {
    const document = parse(`<pre class="mermaid" id="risk-flow">graph TD; A --> B</pre>`);
    assert.equal(diagramId(document.getElementById("risk-flow")!), "risk-flow");
  });

  test("is derived from the source when the host has none, and is not written back", () => {
    const document = parse(`<pre class="mermaid">graph TD; A --> B</pre>`);
    const host = document.querySelector("pre")!;
    const derived = diagramId(host);

    assert.match(derived, /^pe-d/);
    assert.equal(diagramId(host), derived, "must not drift between calls");
    // An `id` attribute is neither `data-pe-ui` nor `pe-`-prefixed, so morph
    // cannot strip it before comparing markup: writing one back would make the
    // block differ from the file forever and report itself changed on every
    // patch.
    assert.equal(host.getAttribute("id"), null);
  });

  test("survives a diagram being inserted above it", () => {
    // The whole point of hashing the source. Keyed by ordinal — which is how the
    // tool this replaces did it — inserting a diagram at the top of a document
    // handed every diagram below it its neighbour's identity.
    const before = parse(`<pre class="mermaid">graph TD; A --> B</pre>`);
    const after = parse(`
      <pre class="mermaid">graph TD; X --> Y</pre>
      <pre class="mermaid">graph TD; A --> B</pre>
    `);

    assert.equal(diagramId(before.querySelector("pre")!), diagramId(after.querySelectorAll("pre")[1]!));
  });

  test("distinguishes different diagrams", () => {
    const document = parse(`
      <pre class="mermaid">graph TD; A --> B</pre>
      <pre class="mermaid">graph TD; A --> C</pre>
    `);
    const [first, second] = document.querySelectorAll("pre");
    assert.notEqual(diagramId(first!), diagramId(second!));
  });
});

describe("diagramHosts", () => {
  test("finds every shape once, and reports the <pre> for a fenced block", () => {
    const document = parse(`
      <pre class="mermaid" id="one">graph TD; A --> B</pre>
      <div class="mermaid" id="two">graph TD; C --> D</div>
      <pre id="three"><code class="language-mermaid">graph TD; E --> F</code></pre>
      <pre id="four"><code class="language-js">const a = 1;</code></pre>
    `);

    // `pre.mermaid` matches two of the three selectors; a duplicate would render
    // the same diagram twice into two containers.
    assert.deepEqual(
      diagramHosts(document).map((host) => host.id),
      ["one", "two", "three"],
    );
  });

  test("never treats our own rendered output as a diagram", () => {
    // The container holds generated SVG whose classes we do not control, and
    // re-rendering from it would replace the picture with a picture of itself.
    const document = parse(`
      <div data-pe-ui class="pe-diagram"><div class="mermaid">graph TD; A --> B</div></div>
    `);
    assert.deepEqual(diagramHosts(document), []);
  });
});

describe("nodeLabel", () => {
  test("reads <br> as a space", () => {
    // `<br>` contributes no character to textContent, so the naive read is
    // "Deployto prod" — a label that appears in no source file and tells the
    // agent nothing.
    const document = parse(`<g id="flowchart-A-0"><span>Deploy<br/>to prod</span></g>`);
    assert.equal(nodeLabel(document.querySelector("g")!), "Deploy to prod");
  });

  test("separates the <tspan> runs mermaid emits with HTML labels off", () => {
    const document = parse(`<g id="flowchart-A-0"><text><tspan>Deploy</tspan><tspan>to prod</tspan></text></g>`);
    assert.equal(nodeLabel(document.querySelector("g")!), "Deploy to prod");
  });

  test("collapses whitespace and caps the length", () => {
    const document = parse(`<g id="n"><span>  ${"word ".repeat(60)}  </span></g>`);
    const label = nodeLabel(document.querySelector("g")!);
    assert.equal(label.length, 120);
    assert.ok(!label.includes("  "));
  });

  test("leaves the source element untouched", () => {
    // The spacing is inserted into a clone. Doing it in place would mutate the
    // rendered SVG under the cursor, and the next hover would read a label that
    // had grown a space per pass.
    const document = parse(`<g id="n"><span>A<br/>B</span></g>`);
    const node = document.querySelector("g")!;
    nodeLabel(node);
    assert.equal(node.innerHTML, "<span>A<br>B</span>");
  });
});
