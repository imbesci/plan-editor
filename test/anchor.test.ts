import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { bestMatch, CONFIDENT, hashText, normalizeText, shingles, similarity } from "../src/sdk/anchor.ts";

// anchor.ts is deliberately DOM-free, so these tests need no jsdom at all —
// which is the point of splitting it out of sdk.ts. The scoring rules are the
// whole feature; if they drift, annotations silently stop re-anchoring and the
// only symptom the human sees is being asked to re-point by hand.

const PARAGRAPH =
  "The rollout begins with a single region and a canary cohort of internal users, " +
  "then widens to the remaining regions once error rates hold below the agreed budget " +
  "for a full week of production traffic.";

const UNRELATED =
  "Invoices are reconciled nightly against the ledger, and any mismatch older than " +
  "three days is escalated to the finance on-call rota rather than retried automatically.";

const anchorFor = (text: string) => ({
  selector: "p:nth-of-type(1)",
  text,
  hash: hashText(text),
  shingles: shingles(text),
});

describe("normalizeText", () => {
  test("collapses whitespace, trims and lowercases", () => {
    assert.equal(normalizeText("  The   Rollout\n Begins  "), "the rollout begins");
  });

  test("survives empty and whitespace-only input", () => {
    assert.equal(normalizeText(""), "");
    assert.equal(normalizeText("   \n\t "), "");
  });
});

describe("hashText", () => {
  test("is stable and insensitive to whitespace and case", () => {
    assert.equal(hashText(PARAGRAPH), hashText(`  ${PARAGRAPH.toUpperCase()}  `));
    assert.equal(hashText(PARAGRAPH).length, 16);
    assert.match(hashText(PARAGRAPH), /^[0-9a-f]{16}$/);
  });

  test("differs for different text", () => {
    assert.notEqual(hashText(PARAGRAPH), hashText(UNRELATED));
  });

  // A digest of "" would compare equal across every empty element on the page,
  // so every one of them would score a perfect match.
  test("is empty for empty input", () => {
    assert.equal(hashText(""), "");
    assert.equal(hashText("   "), "");
  });
});

describe("shingles", () => {
  test("produces deduped word n-grams", () => {
    assert.deepEqual(shingles("a b c d", 3), ["a b c", "b c d"]);
    assert.deepEqual(shingles("x x x x x", 2), ["x x"]);
  });

  test("collapses the width for text shorter than the window", () => {
    // Otherwise a two-word anchor would carry no shingles at all and could
    // never be scored against anything.
    assert.deepEqual(shingles("only two", 3), ["only two"]);
  });

  test("returns nothing for empty text instead of throwing", () => {
    assert.deepEqual(shingles(""), []);
    assert.deepEqual(shingles("   "), []);
  });
});

describe("similarity", () => {
  test("exact text scores 1", () => {
    assert.equal(similarity(anchorFor(PARAGRAPH), PARAGRAPH), 1);
  });

  test("whitespace and case differences still score 1", () => {
    assert.equal(similarity(anchorFor(PARAGRAPH), `\n  ${PARAGRAPH}  `), 1);
  });

  // The exact-equality fallback this replaces could only ever re-find elements
  // the agent had NOT touched, which is the complement of the set worth
  // re-anchoring.
  test("one rewritten word stays confidently the same element", () => {
    const edited = PARAGRAPH.replace("widens", "expands");
    const score = similarity(anchorFor(PARAGRAPH), edited);
    assert.ok(score > CONFIDENT, `expected > ${CONFIDENT}, got ${score}`);
    assert.ok(score < 1, "an edited paragraph must not claim to be identical");
  });

  test("a rewritten sentence within a paragraph still scores confidently", () => {
    const edited = PARAGRAPH.replace(
      "for a full week of production traffic.",
      "across two consecutive weeks of live traffic.",
    );
    assert.ok(similarity(anchorFor(PARAGRAPH), edited) > CONFIDENT);
  });

  test("unrelated paragraphs score far below the threshold", () => {
    const score = similarity(anchorFor(PARAGRAPH), UNRELATED);
    assert.ok(score < CONFIDENT, `expected < ${CONFIDENT}, got ${score}`);
    assert.ok(score < 0.3, `unrelated prose should be nowhere near, got ${score}`);
  });

  // The 300-character snippet cap made any long paragraph permanently
  // unmatchable, because the stored needle was a prefix and exact equality
  // demanded the whole thing.
  test("a truncated snippet still matches its full text without a hash", () => {
    const truncated = PARAGRAPH.slice(0, 80);
    const anchor = { selector: "", text: truncated, shingles: shingles(truncated) };
    assert.ok(similarity(anchor, PARAGRAPH) > CONFIDENT);
  });

  test("full-text hash and shingles rescue a truncated snippet exactly", () => {
    // hash and shingles are captured over the FULL text even though `text` is
    // clipped, so an untouched element re-anchors at a perfect score.
    const anchor = { selector: "", text: PARAGRAPH.slice(0, 80), hash: hashText(PARAGRAPH) };
    assert.equal(similarity(anchor, PARAGRAPH), 1);
  });

  test("a short heading does not match the section that contains it", () => {
    const heading = "Rollout plan";
    const section = `Rollout plan ${PARAGRAPH}`;
    assert.ok(similarity(anchorFor(heading), section) < CONFIDENT);
  });

  test("empty inputs score 0 rather than throwing or returning NaN", () => {
    for (const score of [
      similarity({ text: "" }, ""),
      similarity({ text: "" }, PARAGRAPH),
      similarity(anchorFor(PARAGRAPH), ""),
      similarity({ text: "", hash: "", shingles: [] }, "   "),
    ]) {
      assert.ok(Number.isFinite(score), "score must never be NaN");
      assert.equal(score, 0);
    }
  });

  test("every score is inside 0..1", () => {
    for (const candidate of [PARAGRAPH, UNRELATED, PARAGRAPH.slice(0, 40), `${PARAGRAPH} ${UNRELATED}`]) {
      const score = similarity(anchorFor(PARAGRAPH), candidate);
      assert.ok(score >= 0 && score <= 1, `out of range: ${score}`);
    }
  });
});

describe("bestMatch", () => {
  test("picks the closest candidate, not merely the first plausible one", () => {
    const result = bestMatch(anchorFor(PARAGRAPH), [
      { item: "unrelated", text: UNRELATED },
      { item: "edited", text: PARAGRAPH.replace("widens", "expands") },
    ]);
    assert.equal(result?.item, "edited");
    assert.ok((result?.score ?? 0) > CONFIDENT);
  });

  // Duplicate boilerplate is the case that used to silently re-anchor a note
  // onto whichever copy the walk hit first, with no arbitration at all. The
  // choice is still arbitrary, but it is now stable across reloads instead of
  // wandering between identical blocks on every patch.
  test("ties break deterministically toward the earlier candidate", () => {
    const candidates = [
      { item: "first", text: PARAGRAPH },
      { item: "second", text: PARAGRAPH },
      { item: "third", text: PARAGRAPH },
    ];
    for (let run = 0; run < 5; run += 1) {
      assert.equal(bestMatch(anchorFor(PARAGRAPH), candidates)?.item, "first");
    }
  });

  test("returns null when nothing scores", () => {
    assert.equal(bestMatch(anchorFor(PARAGRAPH), []), null);
    assert.equal(bestMatch(anchorFor(PARAGRAPH), [{ item: "empty", text: "   " }]), null);
    assert.equal(bestMatch({ selector: "", text: "" }, [{ item: "any", text: PARAGRAPH }]), null);
  });

  test("a below-threshold winner is still returned, so callers can rank it", () => {
    // bestMatch does not apply CONFIDENT itself: the SDK needs the weak
    // candidates to offer a one-click re-point instead of making the human hunt.
    const result = bestMatch(anchorFor(PARAGRAPH), [{ item: "unrelated", text: UNRELATED }]);
    assert.ok(result);
    assert.ok(result.score < CONFIDENT);
  });
});
