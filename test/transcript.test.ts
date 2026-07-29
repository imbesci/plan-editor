import assert from "node:assert/strict";
import { describe, test } from "node:test";

import type { Review, ReviewItem, Session, VersionMeta } from "../src/protocol.ts";
import { renderTranscript } from "../src/transcript.ts";

function item(patch: Partial<ReviewItem> = {}): ReviewItem {
  return {
    id: "i1",
    body: "Shorten this paragraph.",
    selector: "#risks p",
    text: "Risks are many and varied.",
    tag: "element",
    status: "sent",
    createdAt: "2026-07-01T10:00:00.000Z",
    ...patch,
  };
}

function review(patch: Partial<Review> = {}): Review {
  return {
    id: "r1",
    note: "",
    status: "sent",
    items: [item()],
    createdAt: "2026-07-01T10:00:00.000Z",
    sentAt: "2026-07-01T10:05:00.000Z",
    ...patch,
  };
}

function session(patch: Partial<Session> = {}): Session {
  return {
    key: "abc123",
    reviews: [],
    token: "t",
    file: "/Users/someone/work/plan.html",
    status: "open",
    chat: [],
    contract: [],
    locks: [],
    companions: [],
    createdAt: "2026-07-01T09:00:00.000Z",
    updatedAt: "2026-07-01T09:00:00.000Z",
    ...patch,
  };
}

describe("renderTranscript", () => {
  test("titles from the artifact filename, not the whole path", () => {
    const out = renderTranscript(session());
    assert.match(out, /^# Review record — plan\.html\n/);
    assert.doesNotMatch(out, /Users\/someone/);
  });

  test("says so in one line when nothing has been sent", () => {
    const out = renderTranscript(session());
    assert.match(out, /No reviews yet/);
    // An empty skeleton reads as a broken renderer rather than an empty history.
    assert.doesNotMatch(out, /^## /m);
    assert.equal(out.split("\n").filter((line) => line.trim()).length, 2);
  });

  test("a drafting review is private and never rendered", () => {
    const draft = review({ id: "draft", status: "drafting", note: "secret markup", items: [item({ status: "draft" })] });
    const out = renderTranscript(session({ reviews: [draft] }));
    assert.doesNotMatch(out, /secret markup/);
    assert.match(out, /markup stays private/);
  });

  test("summarises reviews, items, and verdicts", () => {
    const one = review({
      id: "r1",
      items: [item({ id: "a", status: "accepted" }), item({ id: "b", status: "rejected" })],
    });
    const two = review({ id: "r2", sentAt: "2026-07-02T10:00:00.000Z", items: [item({ id: "c", status: "sent" })] });
    const out = renderTranscript(session({ reviews: [one, two] }));
    assert.match(out, /_2 reviews · 3 items · 1 accepted · 1 rejected · 1 still open\._/);
  });

  test("orders reviews newest-first while numbering them oldest-first", () => {
    const one = review({ id: "r1", note: "first note" });
    const two = review({ id: "r2", note: "second note", sentAt: "2026-07-02T10:00:00.000Z" });
    const out = renderTranscript(session({ reviews: [one, two] }));
    assert.ok(out.indexOf("## Review 2") < out.indexOf("## Review 1"), "the newest exchange leads");
    assert.ok(out.indexOf("second note") < out.indexOf("first note"));
  });

  test("the overall note leads its review, before any item", () => {
    const out = renderTranscript(
      session({ reviews: [review({ note: "Cut this by a third.", items: [item({ body: "trim the intro" })] })] }),
    );
    assert.ok(out.indexOf("> Cut this by a third.") < out.indexOf("trim the intro"));
  });

  test("renders outcome, verdict, reason and thread in order", () => {
    const answered = review({
      status: "answered",
      summary: "Cut 300 words overall.",
      answeredAt: "2026-07-01T11:00:00.000Z",
      items: [
        item({
          status: "rejected",
          outcome: "caveat",
          agentNote: "Cut it, but the number moved.",
          thread: [
            { role: "agent", text: "first agent word", at: "2026-07-01T10:30:00.000Z" },
            { role: "human", text: "that dropped the caveat I needed", at: "2026-07-01T10:40:00.000Z" },
          ],
          requeued: true,
        }),
      ],
    });
    const out = renderTranscript(session({ reviews: [answered] }));
    assert.match(out, /### 1\. applied with a caveat/);
    assert.match(out, /\*\*Agent \(applied with a caveat\)\*\* — Cut it, but the number moved\./);
    assert.match(out, /\*\*Human \(rejected\)\*\* — that dropped the caveat I needed · carried into a later review/);
    assert.ok(out.indexOf("first agent word") < out.indexOf("that dropped the caveat I needed\n"));
    assert.match(out, /Cut 300 words overall\./);
  });

  test("escapes markdown so a note cannot break the rendering around it", () => {
    // A review of a document full of markup routinely contains backticks and
    // pipes; unescaped, one of them swallows the rest of the section.
    const out = renderTranscript(
      session({
        reviews: [
          review({
            note: "use `code` | not prose",
            items: [item({ body: "rename *this* to _that_", text: "a | b", selector: "#a > `b`" })],
          }),
        ],
      }),
    );
    assert.match(out, /use \\`code\\` \\\| not prose/);
    assert.match(out, /rename \\\*this\\\* to \\_that\\_/);
    // The table row must still have exactly the cells it declared.
    const row = out.split("\n").find((line) => line.includes("not prose"))!;
    assert.equal(row.split(/(?<!\\)\|/).length - 1, 8, "an unescaped pipe would add a cell");
    // A backtick cannot be backslash-escaped inside a code span, so the span widens.
    assert.doesNotMatch(out, /`#a > `b``/);
  });

  test("a replacement is fenced wide enough to survive backticks inside it", () => {
    const out = renderTranscript(
      session({
        reviews: [
          review({ items: [item({ tag: "verbatim", replacement: "use ```bash blocks``` here", body: "swap it" })] }),
        ],
      }),
    );
    assert.match(out, /````\nuse ```bash blocks``` here\n````/);
  });

  test("renders standing contract rules and strikes through retired ones", () => {
    const out = renderTranscript(
      session({
        reviews: [review()],
        contract: [
          { id: "c1", text: "Keep the budget numbers exact.", createdAt: "2026-06-01T00:00:00.000Z" },
          {
            id: "c2",
            text: "Never say leverage.",
            createdAt: "2026-06-01T00:00:00.000Z",
            retiredAt: "2026-06-20T00:00:00.000Z",
          },
        ],
      }),
    );
    assert.match(out, /- Keep the budget numbers exact\./);
    assert.match(out, /- ~~Never say leverage\.~~ \(retired 2026-06-20T00:00Z\)/);
  });

  test("dates the base version from history, and admits when it has aged out", () => {
    const versions: VersionMeta[] = [{ seq: 7, at: "2026-07-01T10:04:00.000Z", bytes: 10, origin: "edit", label: "v7" }];
    const known = renderTranscript(session({ reviews: [review({ baseVersion: 7 })] }), { versions });
    assert.match(known, /against v7 "v7" \(2026-07-01T10:04Z\)/);

    // History is capped and dropped oldest-first, so an old review routinely
    // names a snapshot that no longer exists.
    const gone = renderTranscript(session({ reviews: [review({ baseVersion: 3 })] }), { versions });
    assert.match(gone, /against v3 \(snapshot no longer in history\)/);
  });

  test("notes an orphaned anchor and a multi-element item", () => {
    const out = renderTranscript(
      session({
        reviews: [
          review({
            items: [
              item({
                status: "orphaned",
                anchors: [
                  { selector: "#a", text: "a" },
                  { selector: "#b", text: "b" },
                ],
              }),
            ],
          }),
        ],
      }),
    );
    assert.match(out, /anchor lost/);
    assert.match(out, /\(2 elements\)/);
  });
});
