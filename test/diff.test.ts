import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { JSDOM } from "jsdom";

import { attributeChanges, diffDocuments, diffWords } from "../src/sdk/diff.ts";

// diffDocuments uses DOMParser, which only exists in a browser-ish global.
const dom = new JSDOM("", { url: "http://127.0.0.1/" });
(globalThis as Record<string, unknown>).DOMParser = dom.window.DOMParser;

const PAGE = `<!doctype html><html><body>
<section id="goals"><h2>Goals</h2><p id="g1">Ship the thing.</p></section>
<section id="risks"><h2>Risks</h2><p id="r1">Might slip.</p></section>
</body></html>`;

describe("diffDocuments", () => {
  test("reports nothing for an identical document", () => {
    assert.deepEqual(diffDocuments(PAGE, PAGE).sections, []);
  });

  test("attributes a change to the innermost id'd element", () => {
    const after = PAGE.replace("Might slip.", "Slips past March 14.");
    const diff = diffDocuments(PAGE, after);

    assert.equal(diff.sections.length, 1, "the enclosing section must not be reported alongside its paragraph");
    assert.equal(diff.sections[0]?.id, "r1");
    assert.equal(diff.sections[0]?.kind, "changed");
    assert.equal(diff.sections[0]?.before, "Might slip.");
    assert.equal(diff.sections[0]?.after, "Slips past March 14.");
  });

  test("labels a section by its heading rather than its id", () => {
    const after = PAGE.replace("<p id=\"r1\">Might slip.</p>", "<p id=\"r1\">Might slip.</p><p>New risk.</p>");
    const diff = diffDocuments(PAGE, after);
    assert.equal(diff.sections[0]?.label, "Risks");
  });

  test("detects added and removed sections", () => {
    const withExtra = PAGE.replace("</body>", '<section id="open"><h2>Open questions</h2></section></body>');
    const added = diffDocuments(PAGE, withExtra);
    assert.equal(added.sections.find((entry) => entry.id === "open")?.kind, "added");

    const removed = diffDocuments(withExtra, PAGE);
    assert.equal(removed.sections.find((entry) => entry.id === "open")?.kind, "removed");
  });

  test("reports unattributed change when nothing has an id", () => {
    const before = "<html><body><p>one</p></body></html>";
    const after = "<html><body><p>two</p></body></html>";
    const diff = diffDocuments(before, after);
    assert.deepEqual(diff.sections, []);
    assert.equal(diff.unattributed, 1, "a change with no id to hang it on is counted, not guessed at");
  });
});

describe("diffWords", () => {
  test("marks only the words that actually changed", () => {
    const ops = diffWords("the quick brown fox", "the slow brown fox");
    assert.deepEqual(
      ops.filter((op) => op.type === "remove").map((op) => op.text.trim()),
      ["quick"],
    );
    assert.deepEqual(
      ops.filter((op) => op.type === "add").map((op) => op.text.trim()),
      ["slow"],
    );
  });

  test("an unchanged string yields one same run", () => {
    const ops = diffWords("no change here", "no change here");
    assert.equal(ops.length, 1);
    assert.equal(ops[0]?.type, "same");
  });

  test("handles insertion at the end", () => {
    const ops = diffWords("alpha beta", "alpha beta gamma");
    assert.equal(ops.filter((op) => op.type === "remove").length, 0);
    assert.match(ops.map((op) => (op.type === "add" ? op.text : "")).join(""), /gamma/);
  });

  test("handles empty sides", () => {
    assert.deepEqual(diffWords("", ""), []);
    assert.equal(diffWords("", "new text").every((op) => op.type === "add"), true);
    assert.equal(diffWords("old text", "").every((op) => op.type === "remove"), true);
  });

  test("reconstructs both inputs from the ops", () => {
    const before = "one two three four five";
    const after = "one three four six five";
    const ops = diffWords(before, after);
    const rebuiltBefore = ops.filter((op) => op.type !== "add").map((op) => op.text).join("");
    const rebuiltAfter = ops.filter((op) => op.type !== "remove").map((op) => op.text).join("");
    assert.equal(rebuiltBefore, before);
    assert.equal(rebuiltAfter, after);
  });
});

describe("attributeChanges", () => {
  const PLAN = `<!doctype html><html><body>
<section id="goals"><h2>Goals</h2><p id="g1">Ship the thing.</p></section>
<section id="risks"><h2>Risks</h2><p id="r1">Might slip.</p></section>
<section id="scope"><h2>Scope</h2><p id="s1">One week.</p></section>
</body></html>`;

  test("credits a change to the note whose anchor contains it", () => {
    const after = PLAN.replace("Might slip.", "Slips past March 14.");
    const result = attributeChanges(PLAN, after, [{ id: "note-1", selector: "#risks", text: "Risks" }]);

    assert.deepEqual([...result.byItem.keys()], ["note-1"]);
    assert.equal(result.byItem.get("note-1")?.[0]?.id, "r1", "a note on a section owns edits inside it");
    assert.deepEqual(result.unrequested, []);
  });

  test("credits a change to a note anchored inside the changed element", () => {
    // The note is on the paragraph; the diff reports the paragraph. Overlap has
    // to work in both directions or precise notes lose their own changes.
    const after = PLAN.replace("Might slip.", "Slips past March 14.");
    const result = attributeChanges(PLAN, after, [{ id: "note-1", selector: "#r1", text: "Might slip." }]);

    assert.equal(result.byItem.get("note-1")?.length, 1);
    assert.deepEqual(result.unrequested, []);
  });

  test("flags a change nobody asked for", () => {
    // The trust question for applying a whole review at once: what did it touch
    // that I never mentioned?
    const after = PLAN.replace("Might slip.", "Slips past March 14.").replace("One week.", "Three days.");
    const result = attributeChanges(PLAN, after, [{ id: "note-1", selector: "#risks", text: "Risks" }]);

    assert.equal(result.byItem.get("note-1")?.length, 1);
    assert.equal(result.unrequested.length, 1);
    assert.equal(result.unrequested[0]?.id, "s1");
  });

  test("a removed section is always surfaced as unrequested", () => {
    // It has no element in the new document, so containment can never claim it.
    const after = PLAN.replace('<section id="scope"><h2>Scope</h2><p id="s1">One week.</p></section>', "");
    const result = attributeChanges(PLAN, after, [{ id: "note-1", selector: "#risks", text: "Risks" }]);

    assert.ok(result.unrequested.some((section) => section.kind === "removed"));
  });

  test("falls back to the anchor text when the selector no longer resolves", () => {
    // The anchor text is captured from textContent, which concatenates without
    // separators — "RisksMight slip." is what the SDK actually stores. Matching
    // has to run against the *old* document too, because the text the note was
    // pinned to is precisely the text the agent just rewrote.
    const after = PLAN.replace("Might slip.", "Slips past March 14.");
    const result = attributeChanges(PLAN, after, [
      { id: "note-1", selector: "#gone-in-a-rewrite", text: "RisksMight slip." },
    ]);
    assert.equal(result.byItem.get("note-1")?.length, 1);
    assert.deepEqual(result.unrequested, [], "a resolved anchor means nothing is unattributed");
  });

  test("an unchanged document attributes nothing", () => {
    const result = attributeChanges(PLAN, PLAN, [{ id: "note-1", selector: "#risks", text: "Risks" }]);
    assert.equal(result.byItem.size, 0);
    assert.deepEqual(result.unrequested, []);
  });

  test("a malformed selector does not throw", () => {
    const after = PLAN.replace("Might slip.", "Slips.");
    assert.doesNotThrow(() => attributeChanges(PLAN, after, [{ id: "n", selector: "###bad", text: "" }]));
  });
});
