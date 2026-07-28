import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { JSDOM } from "jsdom";

import { morphDocument, UI_ATTRIBUTE, type TrackedAnchor } from "../src/sdk/morph.ts";

// idiomorph reads DOM constructors as bare globals (Document, Node, DOMParser,
// HTMLInputElement, ...) rather than off the node's ownerDocument, so the test
// installs the whole jsdom window onto globalThis instead of guessing which
// constructors the library happens to touch.
// Only `document` plus constructor-shaped globals. Copying the whole window is
// not safe: jsdom's `performance` delegates back to the global one, so aliasing
// it onto globalThis recurses until the stack blows.
function isConstructorName(name: string): boolean {
  return /^[A-Z]/.test(name);
}

function setup(html: string) {
  const dom = new JSDOM(html, { url: "http://127.0.0.1/" });
  const target = globalThis as Record<string, unknown>;
  const source = dom.window as unknown as Record<string, unknown>;
  const previous = new Map<string, unknown>();

  const install = (name: string) => {
    previous.set(name, target[name]);
    try {
      target[name] = source[name];
    } catch {
      previous.delete(name);
    }
  };

  install("document");
  for (const name of Object.getOwnPropertyNames(dom.window)) {
    if (!isConstructorName(name)) continue;
    if (typeof source[name] !== "function") continue;
    install(name);
  }

  return {
    dom,
    document: dom.window.document,
    restore: () => {
      for (const [name, value] of previous) target[name] = value;
    },
  };
}

const PAGE = `<!doctype html><html><head><title>Plan</title></head><body>
<h1 id="title">Original title</h1>
<section id="alpha"><p id="a-body">Alpha body.</p></section>
<section id="beta"><p id="b-body">Beta body.</p></section>
</body></html>`;

describe("morphDocument", () => {
  test("applies an edit in place and preserves untouched node identity", () => {
    const { document, restore } = setup(PAGE);
    const untouched = document.getElementById("b-body")!;
    const edited = document.getElementById("title")!;

    morphDocument(document.documentElement, PAGE.replace("Original title", "Punchier title"), []);

    assert.equal(document.getElementById("title")!.textContent, "Punchier title");
    assert.equal(
      document.getElementById("b-body"),
      untouched,
      "an untouched element must be the SAME node object — that is what a reload destroys",
    );
    assert.equal(document.getElementById("title"), edited, "the edited element is updated in place, not replaced");
    restore();
  });

  test("marks an annotation addressed when its anchored element changed", () => {
    const { document, restore } = setup(PAGE);
    const tracked: TrackedAnchor[] = [
      { id: "ann-title", element: document.getElementById("title")! },
      { id: "ann-beta", element: document.getElementById("b-body")! },
    ];

    const result = morphDocument(document.documentElement, PAGE.replace("Original title", "Punchier title"), tracked);

    assert.deepEqual(result.addressed, ["ann-title"]);
    assert.deepEqual(result.orphaned, []);
    restore();
  });

  test("an annotation on a container is addressed when anything inside it changes", () => {
    const { document, restore } = setup(PAGE);
    const tracked: TrackedAnchor[] = [{ id: "ann-alpha", element: document.getElementById("alpha")! }];

    const result = morphDocument(document.documentElement, PAGE.replace("Alpha body.", "Rewritten alpha."), tracked);

    assert.deepEqual(result.addressed, ["ann-alpha"]);
    restore();
  });

  test("highlights only the deepest changed elements", () => {
    const { document, restore } = setup(PAGE);

    const result = morphDocument(document.documentElement, PAGE.replace("Alpha body.", "Rewritten alpha."), []);

    const ids = result.changed.map((element) => element.id);
    assert.deepEqual(ids, ["a-body"], "ancestors change too, but flashing them would light up the whole page");
    restore();
  });

  test("reports an annotation as orphaned when its element is removed", () => {
    const { document, restore } = setup(PAGE);
    const tracked: TrackedAnchor[] = [{ id: "ann-beta", element: document.getElementById("b-body")! }];

    const withoutBeta = PAGE.replace('<section id="beta"><p id="b-body">Beta body.</p></section>', "");
    const result = morphDocument(document.documentElement, withoutBeta, tracked);

    assert.deepEqual(result.orphaned, ["ann-beta"]);
    assert.deepEqual(result.addressed, [], "a vanished anchor must never be reported as addressed");
    restore();
  });

  test("an identical document produces no changes at all", () => {
    const { document, restore } = setup(PAGE);
    const tracked: TrackedAnchor[] = [{ id: "ann-title", element: document.getElementById("title")! }];

    const result = morphDocument(document.documentElement, PAGE, tracked);

    assert.deepEqual(result.changed, []);
    assert.deepEqual(result.addressed, [], "a no-op write must not falsely resolve open edits");
    restore();
  });

  test("preserves plan-editor UI nodes across a morph", () => {
    const { document, restore } = setup(PAGE);
    const style = document.createElement("style");
    style.setAttribute(UI_ATTRIBUTE, "");
    style.textContent = ".pe-hover{}";
    document.head.appendChild(style);

    morphDocument(document.documentElement, PAGE.replace("Original title", "New title"), []);

    assert.ok(
      document.querySelector(`[${UI_ATTRIBUTE}]`),
      "the SDK's own injected style must survive — the incoming HTML does not contain it",
    );
    restore();
  });

  test("keeps live JS state that a reload would destroy", () => {
    // Attribute-reflected state (details.open, input value attributes) is
    // legitimately synced by a morph — the incoming HTML is authoritative there.
    // What a morph preserves and a reload cannot is state attached to the node
    // *object*: event listeners, expando properties, canvas contents.
    const { document, restore } = setup(
      `<!doctype html><html><body><button id="b">Go</button><h1 id="t">Old</h1></body></html>`,
    );
    const button = document.getElementById("b")!;
    let clicks = 0;
    button.addEventListener("click", () => {
      clicks += 1;
    });
    (button as unknown as Record<string, unknown>).__widgetState = "initialised";

    morphDocument(
      document.documentElement,
      `<!doctype html><html><body><button id="b">Go</button><h1 id="t">New</h1></body></html>`,
      [],
    );

    assert.equal(document.getElementById("t")!.textContent, "New", "the edit still lands");
    const after = document.getElementById("b")!;
    after.dispatchEvent(new (document.defaultView!.Event)("click"));
    assert.equal(clicks, 1, "an event listener bound before the edit must still fire after it");
    assert.equal(
      (after as unknown as Record<string, unknown>).__widgetState,
      "initialised",
      "expando state on the node object must survive",
    );
    restore();
  });

  test("handles a heavily restructured document without throwing", () => {
    const { document, restore } = setup(PAGE);
    const tracked: TrackedAnchor[] = [{ id: "ann-title", element: document.getElementById("title")! }];
    const restructured = `<!doctype html><html><head><title>Plan</title></head><body>
<main><header><h1 id="title">Completely reorganised</h1></header>
<article id="alpha"><p id="a-body">Alpha body.</p></article></main>
</body></html>`;

    const result = morphDocument(document.documentElement, restructured, tracked);
    assert.equal(document.getElementById("title")!.textContent, "Completely reorganised");
    assert.equal(result.addressed.length + result.orphaned.length, 1, "the anchor is resolved one way or the other");
    restore();
  });
});
