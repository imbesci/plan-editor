// What a review costs the agent, in characters.
//
// Every one of these numbers is paid on every `watch` cycle, and `watch` is
// documented as the thing you run at the end of every turn — so a payload that
// grows quietly is a bill that grows quietly. Two properties are asserted rather
// than exact sizes: that the cost of an item does not scale with the length of
// the paragraph it points at, and that nothing an agent needs to *act* is ever
// what gets dropped to save room.

import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { buildContextInjection } from "../src/hooks.ts";
import { formatReview } from "../src/cli-format.ts";
import type { Review, ReviewItem } from "../src/protocol.ts";

const LONG =
  "The retry budget is three attempts with exponential backoff from 250ms, chosen because the downstream " +
  "service has a p99 of 1.2 seconds and a documented limit of 100 requests per second per tenant. Anything " +
  "more aggressive amplifies a partial outage into a full one; anything less surfaces transient DNS failures " +
  "to users, which is the complaint that started this whole piece of work in the first place. ";

function item(overrides: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "i1",
    body: "Cut this down and stop hedging.",
    selector: "#risks > p:nth-of-type(2)",
    text: LONG.repeat(3).slice(0, 1200),
    tag: "element",
    status: "sent",
    createdAt: new Date(0).toISOString(),
    ...overrides,
  };
}

function review(items: ReviewItem[]): Review {
  return {
    id: "r1",
    note: "Cut the whole thing by a third.",
    status: "sent",
    items,
    createdAt: new Date(0).toISOString(),
  };
}

const size = (value: unknown) => JSON.stringify(value).length;

describe("an item's cost does not scale with the paragraph it points at", () => {
  test("a long anchor is excerpted, not sent whole", () => {
    const described = formatReview("/tmp/plan.html", review([item()])) as {
      items: Array<{ anchor_text: string }>;
    };
    const anchor = described.items[0]!.anchor_text;
    assert.ok(anchor.length < 260, `anchor_text was ${anchor.length} characters`);
    // Head *and* tail: the end of a paragraph is what distinguishes two passages
    // that open the same way, which is exactly when a head-only excerpt would
    // send the agent to the wrong one.
    const stored = LONG.repeat(3).slice(0, 1200).replace(/\s+/g, " ").trim();
    assert.ok(anchor.startsWith("The retry budget is three attempts"));
    assert.ok(anchor.includes("…"));
    assert.ok(anchor.endsWith(stored.slice(-40)), `tail was "${anchor.slice(-40)}"`);
  });

  test("a short anchor is left exactly as it is", () => {
    const described = formatReview("/tmp/plan.html", review([item({ text: "Budget: 40 units." })])) as {
      items: Array<{ anchor_text: string }>;
    };
    assert.equal(described.items[0]!.anchor_text, "Budget: 40 units.");
  });

  test("twelve items cost roughly twelve times one item, not twelve times a document", () => {
    const one = size(formatReview("/tmp/plan.html", review([item()])));
    const twelve = size(
      formatReview("/tmp/plan.html", review(Array.from({ length: 12 }, (_, n) => item({ id: `i${n}` })))),
    );
    // Before excerpting, one item carried 1,200 characters of anchor text and the
    // guidance was ~1,100, so twelve items ran to ~18,000 characters.
    assert.ok(twelve < 8_000, `twelve items cost ${twelve} characters`);
    assert.ok(twelve < one * 4, `twelve items cost ${twelve} against one item's ${one}`);
  });
});

describe("what is never dropped", () => {
  test("a verbatim replacement is exact on both sides", () => {
    const exact = LONG.repeat(2);
    const described = formatReview(
      "/tmp/plan.html",
      review([item({ tag: "verbatim", text: exact, replacement: `${exact}!` })]),
    ) as { items: Array<{ replace_this: string; with_exactly: string; anchor_text?: string }> };
    // The agent is told to apply this literally, so truncating either side would
    // turn a precise instruction back into the ambiguity it was invented to avoid.
    assert.equal(described.items[0]!.replace_this, exact);
    assert.equal(described.items[0]!.with_exactly, `${exact}!`);
    // And the same passage is not also billed as anchor_text.
    assert.equal(described.items[0]!.anchor_text, undefined);
  });

  test("a repeat delivery still carries every item, and only sheds the workflow prose", () => {
    const full = formatReview("/tmp/plan.html", review([item(), item({ id: "i2" })]), false, {}) as {
      items: unknown[];
      next_step: string;
    };
    const repeat = formatReview("/tmp/plan.html", review([item(), item({ id: "i2" })]), false, { repeat: true }) as {
      items: unknown[];
      next_step: string;
    };
    // A poll is the agent *asking*, and it may be asking because a compaction took
    // the items away. Only the prose it has already been told shrinks.
    assert.equal(repeat.items.length, full.items.length);
    assert.ok(repeat.next_step.length < full.next_step.length);
    assert.match(repeat.next_step, /respond/);
    assert.match(repeat.next_step, /applied/);
  });

  test("standing rules survive a repeat even though their explanation does not", () => {
    const standing = { contract: [{ id: "c1", text: "Never round a number.", createdAt: "" }], repeat: true };
    const described = formatReview("/tmp/plan.html", review([item()]), false, standing) as {
      standing_rules: string[];
      standing_rules_note?: string;
    };
    // A rule stated once and then dropped is a rule broken three turns later.
    assert.deepEqual(described.standing_rules, ["Never round a number."]);
    assert.equal(described.standing_rules_note, undefined);
  });
});

describe("the hook injection shrinks when it has nothing new to say", () => {
  const entry = (seen: boolean) => ({
    file: "/tmp/plan.html",
    ownership: "authoring" as const,
    agentKey: "session-1",
    review: {
      id: "r1",
      note: "Cut it by a third.",
      items: [{ id: "i1", body: "Trim this.", text: LONG, selector: "#risks" }],
      ...(seen ? { deliveredTo: ["session-1"] } : {}),
    },
  });

  test("a first injection teaches the workflow", () => {
    const injection = buildContextInjection([entry(false)])!;
    assert.match(injection.text, /never tell the user to reload/);
    assert.deepEqual(injection.deliver, ["r1"]);
  });

  test("a repeat injection does not, because it fires on every prompt", () => {
    const first = buildContextInjection([entry(false)])!;
    const again = buildContextInjection([entry(true)])!;
    assert.ok(again.text.length < first.text.length / 2, `repeat was ${again.text.length} of ${first.text.length}`);
    assert.doesNotMatch(again.text, /never tell the user to reload/);
    // It still says the two things a stuck review needs.
    assert.match(again.text, /respond/);
    assert.match(again.text, /applied/);
    assert.deepEqual(again.deliver, []);
  });

  test("the overall note is repeated even so — it changes what every item means", () => {
    assert.match(buildContextInjection([entry(true)])!.text, /Cut it by a third/);
  });
});
