import assert from "node:assert/strict";
import crypto from "node:crypto";
import { describe, test } from "node:test";

import { artifactSha, buildPacket, summarizePacket } from "../src/packet.ts";
import type { Review, ReviewItem, Session } from "../src/protocol.ts";
import { parseReviewPacket } from "../src/protocol.ts";

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
    note: "Cut this by a third.",
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
    token: "secret-token",
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

const HTML = "<html><body><p id='risks'>Risks are many and varied.</p></body></html>";

describe("artifactSha", () => {
  test("is the sha256 of the bytes", () => {
    assert.equal(artifactSha(HTML), crypto.createHash("sha256").update(HTML, "utf8").digest("hex"));
    assert.equal(artifactSha(HTML).length, 64);
  });

  test("moves on any change at all, including whitespace", () => {
    assert.notEqual(artifactSha(HTML), artifactSha(`${HTML}\n`));
  });
});

describe("buildPacket", () => {
  test("round-trips through parseReviewPacket unchanged", () => {
    // The file that is written and the record that gets imported must be the
    // same thing; any drift would only ever show up on someone else's machine.
    const packet = buildPacket(
      session({
        contract: [{ id: "c1", text: "Keep the budget numbers exact.", createdAt: "2026-06-01T00:00:00.000Z" }],
      }),
      review({
        items: [
          item({
            anchors: [
              { selector: "#risks p", text: "Risks are many and varied.", hash: "abc", shingles: ["risks are"] },
            ],
          }),
          item({ id: "i2", tag: "verbatim", replacement: "We use the existing pipeline.", body: "swap it" }),
          item({ id: "i3", tag: "structural", op: { kind: "move-before", targetSelector: "#milestones" }, body: "move" }),
        ],
      }),
      HTML,
    );
    const reparsed = parseReviewPacket(JSON.parse(JSON.stringify(packet)));
    assert.deepEqual(reparsed, packet);
  });

  test("carries the basename, never the sender's absolute path", () => {
    const packet = buildPacket(session(), review(), HTML);
    assert.equal(packet.artifact, "plan.html");
    assert.doesNotMatch(JSON.stringify(packet), /Users\/someone/);
  });

  test("never carries the session token or agent-side bookkeeping", () => {
    // A packet crosses machines and people. The token is the only credential in
    // the system, and delivery stamps mean nothing on the other side.
    const packet = buildPacket(
      session(),
      review({
        deliveredTo: ["session-9"],
        baseVersion: 4,
        summary: "internal",
        items: [item({ agentNote: "internal", thread: [{ role: "agent", text: "internal", at: "2026-07-01T10:00:00.000Z" }] })],
      }),
      HTML,
    );
    const json = JSON.stringify(packet);
    assert.doesNotMatch(json, /secret-token/);
    assert.doesNotMatch(json, /session-9/);
    assert.doesNotMatch(json, /internal/);
    assert.equal(packet.review.baseVersion, undefined, "a version number means nothing on another machine");
  });

  test("items arrive as drafts, so the recipient still decides what crosses to their agent", () => {
    const packet = buildPacket(session(), review(), HTML);
    assert.equal(packet.review.status, "sent");
    assert.deepEqual(
      packet.review.items.map((entry) => entry.status),
      ["draft"],
    );
  });

  test("excludes retired contract rules", () => {
    const packet = buildPacket(
      session({
        contract: [
          { id: "c1", text: "in force", createdAt: "2026-06-01T00:00:00.000Z" },
          { id: "c2", text: "abandoned", createdAt: "2026-06-01T00:00:00.000Z", retiredAt: "2026-06-20T00:00:00.000Z" },
        ],
      }),
      review(),
      HTML,
    );
    assert.deepEqual(
      packet.contract.map((rule) => rule.text),
      ["in force"],
      "a rule the human retired must not be enforced by a second reviewer",
    );
  });
});

describe("summarizePacket", () => {
  test("reports no drift against the exact bytes it was written for", () => {
    const packet = buildPacket(session(), review(), HTML);
    const summary = summarizePacket(packet, HTML);
    assert.equal(summary.drift, "same");
    assert.equal(summary.items, 1);
    assert.match(summary.note, /1 item, written against this exact revision of plan\.html\./);
  });

  test("warns that anchors may resolve to the wrong element when the document moved on", () => {
    // This is the silent failure the check exists for: the review applies
    // cleanly to the wrong paragraphs and nothing in the data says so.
    const packet = buildPacket(session(), review({ items: [item(), item({ id: "i2" })] }), HTML);
    const summary = summarizePacket(packet, `${HTML}<p>and a new one</p>`);
    assert.equal(summary.drift, "changed");
    assert.equal(summary.items, 2);
    assert.match(summary.note, /2 items/);
    assert.match(summary.note, /different revision/);
    assert.match(summary.note, /anchors may resolve to the wrong element/);
    assert.match(summary.note, new RegExp(packet.artifactSha.slice(0, 12)));
  });

  test("summarises a packet that arrived from a file, not from buildPacket", () => {
    const packet = parseReviewPacket({
      packet: 1,
      artifact: "plan.html",
      artifactSha: artifactSha(HTML),
      exportedAt: "2026-07-01T10:00:00.000Z",
      contract: [],
      review: { id: "r1", note: "", createdAt: "2026-07-01T10:00:00.000Z", items: [item()] },
    });
    assert.equal(summarizePacket(packet, HTML).drift, "same");
  });
});
