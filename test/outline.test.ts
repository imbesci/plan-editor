// Reading an artifact without reading all of it.
//
// The point of these two functions is that an agent can change forty words
// without opening fifty kilobytes, so what is tested here is mostly *refusal*:
// an outline that silently omits a section, or a section read that returns the
// wrong slice, would send the agent to edit the wrong place — which is strictly
// worse than making it read the whole file.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { describeOutline, diffSections, outlineOf, sectionSource } from "../src/outline.ts";

const HTML = `<!doctype html>
<html>
<head><title>Plan</title></head>
<body>
<h1 id="title">Retry budget</h1>
<section id="risks">
  <h2>Risks</h2>
  <p>The downstream service rate-limits at 100 rps per tenant.</p>
</section>
<section id="milestones">
  <h2>Milestones</h2>
  <p>Ship the backoff change first.</p>
  <p>Then raise the cap.</p>
</section>
<p id="footnote">Numbers reviewed on the 3rd.</p>
</body>
</html>`;

const MARKDOWN = `# Retry budget

Some intro prose.

## Risks

The downstream service rate-limits at 100 rps per tenant.

## Milestones

Ship the backoff change first.
`;

describe("outlineOf, for HTML", () => {
  const outline = outlineOf("/tmp/plan.html", HTML);

  test("reports every id'd section that has a heading, in document order", () => {
    assert.deepEqual(
      outline.entries.map((entry) => entry.id),
      ["title", "risks", "milestones"],
    );
  });

  test("carries the heading text and its level", () => {
    const risks = outline.entries.find((entry) => entry.id === "risks");
    assert.equal(risks?.heading, "Risks");
    assert.equal(risks?.level, 2);
  });

  test("an id'd block with no heading is counted, not listed", () => {
    // Listing two hundred id'd paragraphs would defeat the point of an outline,
    // and dropping them silently would understate what is addressable.
    assert.ok(outline.entries.every((entry) => entry.id !== "footnote"));
    assert.ok(outline.unheadedBlocks >= 1);
  });

  test("line ranges point at the section in the source", () => {
    const risks = outline.entries.find((entry) => entry.id === "risks")!;
    const lines = HTML.split("\n");
    assert.match(lines[risks.line - 1]!, /id="risks"/);
    assert.match(lines[risks.endLine - 1]!, /<\/section>/);
  });

  test("word counts are of the text, not the markup", () => {
    const milestones = outline.entries.find((entry) => entry.id === "milestones")!;
    // "Milestones Ship the backoff change first. Then raise the cap." = 10 words.
    assert.equal(milestones.words, 10);
  });
});

describe("outlineOf, for markdown", () => {
  const outline = outlineOf("/tmp/plan.md", MARKDOWN);

  test("uses the renderer's ids, because those are what anchors key on", () => {
    assert.deepEqual(
      outline.entries.map((entry) => entry.heading),
      ["Retry budget", "Risks", "Milestones"],
    );
    assert.ok(outline.entries.every((entry) => entry.id.length > 0));
  });

  test("levels come back for nested sections", () => {
    assert.equal(outline.entries[0]?.level, 1);
    assert.equal(outline.entries[1]?.level, 2);
  });

  test("word counts are of the source, which is what 'cut this by a third' means", () => {
    const risks = outline.entries.find((entry) => entry.heading === "Risks")!;
    assert.ok(risks.words >= 10 && risks.words <= 14, `unexpected ${risks.words}`);
  });
});

describe("sectionSource", () => {
  test("returns markdown source for a .md, never the render", () => {
    const outline = outlineOf("/tmp/plan.md", MARKDOWN);
    const risks = outline.entries.find((entry) => entry.heading === "Risks")!;
    const section = sectionSource("/tmp/plan.md", MARKDOWN, risks.id)!;
    // The agent edits the .md. Handing it HTML would invite it to write HTML
    // back, which is the one operation this codebase refuses everywhere.
    assert.match(section.source, /^## Risks/);
    assert.doesNotMatch(section.source, /<section|<h2/);
  });

  test("returns the element's markup for an .html", () => {
    const section = sectionSource("/tmp/plan.html", HTML, "risks")!;
    assert.match(section.source, /^<section id="risks">/);
    assert.match(section.source, /<\/section>$/);
    assert.equal(section.heading, "Risks");
  });

  test("the reported range is exactly the lines the source came from", () => {
    const section = sectionSource("/tmp/plan.html", HTML, "milestones")!;
    const sliced = HTML.split("\n").slice(section.line - 1, section.endLine).join("\n");
    assert.equal(sliced, section.source);
  });

  test("refuses an unknown id rather than returning a near miss", () => {
    assert.equal(sectionSource("/tmp/plan.html", HTML, "nope"), null);
    assert.equal(sectionSource("/tmp/plan.md", MARKDOWN, "nope"), null);
  });
});

describe("describeOutline", () => {
  test("hands the agent ids and line ranges, and tells it to read one section", () => {
    const described = describeOutline("/tmp/plan.html", outlineOf("/tmp/plan.html", HTML)) as {
      sections: Array<{ id: string; source: string }>;
      next_step: string;
    };
    assert.match(described.sections[1]!.source, /^plan\.html:\d+-\d+$/);
    assert.match(described.next_step, /plan-editor section/);
  });

  test("a document with no anchors is told to fix that, not handed an empty list", () => {
    const described = describeOutline("/tmp/bare.html", outlineOf("/tmp/bare.html", "<p>no ids here</p>")) as {
      sections: unknown[];
      next_step: string;
    };
    assert.equal(described.sections.length, 0);
    assert.match(described.next_step, /doctor .*--fix/);
  });
});

describe("diffSections", () => {
  test("reports a changed section by id, with the word count either side", () => {
    const after = HTML.replace("Ship the backoff change first.", "Ship it.");
    const changes = diffSections(HTML, after);
    assert.deepEqual(
      changes.map((change) => [change.id, change.kind]),
      [["milestones", "changed"]],
    );
    assert.ok(changes[0]!.wordsAfter < changes[0]!.wordsBefore);
  });

  test("an added section is distinguished from a changed one", () => {
    const after = HTML.replace("</body>", `<section id="new"><h2>New</h2></section></body>`);
    assert.deepEqual(
      diffSections(HTML, after).map((change) => [change.id, change.kind]),
      [["new", "added"]],
    );
  });

  test("a removed section is reported, because containment can never find it", () => {
    const after = HTML.replace(/<section id="risks">[\s\S]*?<\/section>/, "");
    const removed = diffSections(HTML, after).find((change) => change.kind === "removed");
    assert.equal(removed?.id, "risks");
    assert.equal(removed?.wordsAfter, 0);
  });

  test("an identical document reports nothing", () => {
    assert.deepEqual(diffSections(HTML, HTML), []);
  });
});

describe("diffSections reports only the innermost change", () => {
  // The same rule `diffDocuments` follows. Without it a markdown artifact
  // answered a one-paragraph edit with four entries — the paragraph, its
  // section, the document — and the outermost was present for *every* edit,
  // which is the "flag body on everything" failure the rule exists to prevent.
  const NESTED = `<html><body><div id="doc">
<section id="risks"><h2>Risks</h2><p id="risks-p">One hundred rps per tenant.</p></section>
<section id="plan"><h2>Plan</h2><p id="plan-p">Ship it.</p></section>
</div></body></html>`;

  test("an ancestor of a changed section is not also reported", () => {
    const after = NESTED.replace("One hundred rps per tenant.", "100 rps per tenant.");
    assert.deepEqual(
      diffSections(NESTED, after).map((change) => change.id),
      ["risks-p"],
    );
  });

  test("two changes in different branches are both reported", () => {
    const after = NESTED.replace("One hundred rps per tenant.", "100 rps.").replace("Ship it.", "Ship the classifier.");
    assert.deepEqual(
      diffSections(NESTED, after).map((change) => change.id).sort(),
      ["plan-p", "risks-p"],
    );
  });

  test("a change with no inner id is attributed to the innermost id there is", () => {
    // Nothing to blame it on but the section itself, which is honest — the
    // alternative is reporting the whole document for a heading edit.
    const after = NESTED.replace("<h2>Risks</h2>", "<h2>Risks and questions</h2>");
    assert.deepEqual(
      diffSections(NESTED, after).map((change) => change.id),
      ["risks"],
    );
  });
});
