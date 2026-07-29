// A review, made portable.
//
// plan-editor has no multiplayer, no CRDT and no identity model, and that
// refusal is what keeps anchoring, threading and undo tractable — the artifact
// is agent-owned and humans propose changes to it. But "let my colleague review
// this" is a real need, and answering it with a shared server would drag in
// every problem the refusal avoids.
//
// A packet is sequential handoff instead of concurrent editing: write a review
// to a file, they open it against their own copy, they send one back. No
// accounts, no exposed port, no merge. The receiving side lands the items in
// its *draft* (see `SessionStore.importPacket`), so the owner of the artifact
// still decides what crosses to their agent — the same rule the local markup
// phase follows.

import crypto from "node:crypto";
import path from "node:path";

import type { ContractRule, Review, ReviewPacket, Session } from "./protocol.ts";

/** Identity of the exact bytes a review was written against. */
export function artifactSha(html: string): string {
  return crypto.createHash("sha256").update(html, "utf8").digest("hex");
}

/**
 * Builds the file the second reviewer receives.
 *
 * The shape is exactly what `parseReviewPacket` produces, field for field, so a
 * packet round-trips unchanged. Emitting anything richer would mean the file
 * that was written and the record that gets imported quietly differ, and the
 * difference would only ever show up on someone else's machine.
 */
export function buildPacket(session: Session, review: Review, html: string): ReviewPacket {
  return {
    packet: 1,
    // The basename, never the sender's absolute path: it is meaningless on the
    // receiving machine and it leaks the directory layout of theirs.
    artifact: path.basename(session.file),
    artifactSha: artifactSha(html),
    exportedAt: new Date().toISOString(),
    contract: session.contract
      // A retired rule is one the human took out of force. Shipping it would
      // have a second reviewer enforcing a rule this project has abandoned.
      .filter((rule) => !rule.retiredAt)
      .map((rule): ContractRule => ({ id: rule.id, text: rule.text, createdAt: rule.createdAt })),
    review: {
      id: review.id,
      note: review.note,
      // Sent from the sender's point of view; every *item* arrives as a draft,
      // because a proposal from another copy is not a review this session sent.
      status: "sent",
      createdAt: review.createdAt,
      items: review.items.map((item) => ({
        id: item.id,
        body: item.body,
        selector: item.selector,
        text: item.text,
        tag: item.tag,
        ...(item.anchors ? { anchors: item.anchors } : {}),
        // Gated on the tag exactly as `parseIncomingItem` gates it. A
        // replacement on a non-verbatim item is dropped on import, so writing
        // one would put a field in the file that the importer silently
        // discards — and the round trip would stop being an identity.
        ...(item.tag === "verbatim" && item.replacement !== undefined ? { replacement: item.replacement } : {}),
        ...(item.tag === "structural" && item.op ? { op: item.op } : {}),
        status: "draft" as const,
        createdAt: item.createdAt,
      })),
    },
  };
}

export interface PacketSummary {
  items: number;
  drift: "same" | "changed";
  /** One line to show the human before they import. */
  note: string;
}

/**
 * Compares a packet against the copy it is about to be imported into.
 *
 * The drift check matters more than it looks. Every item carries a selector and
 * a snippet of anchor text captured against the sender's revision; if this copy
 * has moved on, those still resolve — just not necessarily to the element the
 * reviewer was looking at. That is the silent failure: the review applies
 * cleanly to the wrong paragraphs, and nothing in the data says so. The only
 * cheap signal available is whether the bytes match at all, so it is stated
 * plainly rather than buried.
 */
export function summarizePacket(packet: ReviewPacket, currentHtml: string): PacketSummary {
  const items = packet.review.items.length;
  const drift: PacketSummary["drift"] = packet.artifactSha === artifactSha(currentHtml) ? "same" : "changed";
  const subject = items === 1 ? "1 item" : `${items} items`;
  const note =
    drift === "same"
      ? `${subject}, written against this exact revision of ${packet.artifact}.`
      : `${subject}, written against a different revision of ${packet.artifact} ` +
        `(${short(packet.artifactSha)}, exported ${packet.exportedAt}; this copy is ${short(artifactSha(currentHtml))}). ` +
        `The document has moved on since, so anchors may resolve to the wrong element — check each item against its anchor text before acting on it.`;
  return { items, drift, note };
}

function short(sha: string): string {
  return sha.slice(0, 12) || "unknown";
}
