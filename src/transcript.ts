// The record of a review cycle, rendered as Markdown.
//
// `plan-editor export` writes the artifact with the SDK stripped and nothing
// else, which throws away the half of the cycle that is actually hard to
// reconstruct: what was asked, what the agent said it did, and which of it the
// human kept. That half exists only as JSON under the state directory, where it
// is unreadable and unquotable — so the paragraph that belongs in a PR
// description or a handoff gets retyped from memory, wrongly. This renders it
// once, from the record.

import path from "node:path";

import type { ItemOutcome, Review, ReviewItem, Session, VersionMeta } from "./protocol.ts";

export interface TranscriptOptions {
  /** Version history, used to date the snapshot each review was written against. */
  versions?: VersionMeta[];
}

/** How the README names each outcome. The transcript must not invent a second vocabulary. */
const OUTCOME_LABEL: Record<ItemOutcome, string> = {
  applied: "applied",
  caveat: "applied with a caveat",
  "needs-call": "needs your call",
  skipped: "not done",
};

export function renderTranscript(session: Session, options: TranscriptOptions = {}): string {
  const out: string[] = [];
  const title = path.basename(session.file) || session.key;
  out.push(`# Review record — ${md(title)}`, "");

  // Drafting reviews are deliberately excluded. Markup is private until the
  // human sends it — that is the whole reason the draft lives server-side and
  // `takeFeedback` only ever returns a `sent` review — and a transcript pasted
  // into a PR is the last place unsent markup should surface.
  const sent = session.reviews.filter((review) => review.status !== "drafting");
  const drafting = session.reviews.length - sent.length;

  if (sent.length === 0) {
    // An empty skeleton — headings with nothing under them — reads as a broken
    // renderer rather than as an empty history, so say it in one line instead.
    out.push(
      drafting > 0
        ? "_No review has been sent yet. A draft is open, and markup stays private until it is sent._"
        : "_No reviews yet — nothing has been sent to the agent for this artifact._",
      "",
    );
    return `${out.join("\n").trimEnd()}\n`;
  }

  const items = sent.flatMap((review) => review.items);
  const accepted = items.filter((item) => item.status === "accepted").length;
  const rejected = items.filter((item) => item.status === "rejected").length;
  const open = items.length - accepted - rejected;
  out.push(
    `_${count(sent.length, "review")} · ${count(items.length, "item")} · ` +
      `${accepted} accepted · ${rejected} rejected · ${open} still open._`,
    "",
  );
  if (drafting > 0) {
    out.push("_A draft review is open; its markup is private and is not included._", "");
  }

  out.push(...overviewTable(sent));
  out.push(...contractSection(session));

  // Newest first: the last exchange is the one being handed over, and burying
  // it under three older rounds is how a handoff document stops being read.
  for (let index = sent.length - 1; index >= 0; index -= 1) {
    out.push(...reviewSection(sent[index]!, index + 1, options));
  }

  return `${out.join("\n").trimEnd()}\n`;
}

function overviewTable(reviews: Review[]): string[] {
  const rows = reviews
    .map((review, index) => {
      const accepted = review.items.filter((item) => item.status === "accepted").length;
      const rejected = review.items.filter((item) => item.status === "rejected").length;
      return `| ${index + 1} | ${when(review.sentAt ?? review.createdAt)} | ${review.status} | ${
        review.items.length
      } | ${accepted} | ${rejected} | ${cell(review.note) || "—"} |`;
    })
    .reverse();
  return [
    "| # | Sent | Status | Items | Accepted | Rejected | Overall note |",
    "| --- | --- | --- | --- | --- | --- | --- |",
    ...rows,
    "",
  ];
}

function contractSection(session: Session): string[] {
  if (session.contract.length === 0) return [];
  const out = ["## Standing contract", ""];
  for (const rule of session.contract) {
    // Retired rules are struck through rather than dropped: the record is meant
    // to explain why round four reads the way it does, and a rule that was in
    // force for rounds one to three is part of that explanation.
    out.push(rule.retiredAt ? `- ~~${md(rule.text)}~~ (retired ${when(rule.retiredAt)})` : `- ${md(rule.text)}`);
  }
  out.push("");
  return out;
}

function reviewSection(review: Review, ordinal: number, options: TranscriptOptions): string[] {
  const out = [`## Review ${ordinal} — ${review.status}`, ""];

  const facts = [`sent ${when(review.sentAt ?? review.createdAt)}`, count(review.items.length, "item")];
  if (review.answeredAt) facts.push(`answered ${when(review.answeredAt)}`);
  const base = baseVersionFact(review, options);
  if (base) facts.push(base);
  out.push(`${facts.join(" · ")}`, "");

  // The overall note leads, exactly as it does in every injection and poll
  // payload: "cut this by a third" changes what every item under it means, so
  // reading the items first is reading them wrong.
  if (review.note) out.push(...quote(review.note), "");

  review.items.forEach((item, index) => out.push(...itemSection(item, index + 1)));

  if (review.summary) {
    out.push("**Agent summary**", "", ...quote(review.summary), "");
  }
  return out;
}

function baseVersionFact(review: Review, options: TranscriptOptions): string | null {
  if (review.baseVersion === undefined) return null;
  if (!options.versions) return `against v${review.baseVersion}`;
  const meta = options.versions.find((entry) => entry.seq === review.baseVersion);
  // History is capped at MAX_VERSIONS and dropped oldest-first, so an old
  // review routinely names a snapshot that no longer exists. Saying so beats
  // printing a version number that nothing can be diffed against.
  if (!meta) return `against v${review.baseVersion} (snapshot no longer in history)`;
  return `against v${meta.seq}${meta.label ? ` "${md(meta.label)}"` : ""} (${when(meta.at)})`;
}

function itemSection(item: ReviewItem, ordinal: number): string[] {
  const badge = item.outcome ? OUTCOME_LABEL[item.outcome] : item.status;
  const out = [`### ${ordinal}. ${badge}${item.status === "orphaned" ? " · anchor lost" : ""}`, ""];
  out.push(`**Asked** — ${md(item.body)}`, "");

  if (item.selector || item.text) {
    const where = item.selector ? `\`${code(item.selector)}\`` : "the page as a whole";
    const covers = item.anchors && item.anchors.length > 1 ? ` (${item.anchors.length} elements)` : "";
    out.push(`**Anchor** — ${where}${covers}`, "");
    if (item.text) out.push(...quote(item.text), "");
  }

  // A verbatim item's replacement *is* the request, so leaving it out would
  // make the record of that item say nothing at all.
  if (item.replacement !== undefined) out.push("**Replacement**", "", ...fence(item.replacement), "");
  if (item.op) {
    const target = item.op.targetText ? ` — target: ${md(truncate(item.op.targetText, 120))}` : "";
    out.push(`**Structural** — ${md(item.op.kind)}${target}`, "");
  }
  if (item.alternatives?.length) {
    const chosen = item.chosenAlternative;
    out.push(
      `**Alternatives** — ${item.alternatives
        .map((alt) => `${md(alt.label)}${alt.id === chosen ? " (chosen)" : ""}`)
        .join(", ")}`,
      "",
    );
  }

  if (item.outcome || item.agentNote) {
    const note = item.agentNote ? ` — ${md(item.agentNote)}` : "";
    out.push(`**Agent (${item.outcome ? OUTCOME_LABEL[item.outcome] : "answered"})**${note}`, "");
  }

  if (item.status === "accepted" || item.status === "rejected") {
    // The reason is the last thing the human said on the thread — that is where
    // `setItemVerdict` puts it — and it is repeated on the verdict line because
    // the verdict is the line that gets read. The thread below has it in place.
    const reason = lastHumanText(item);
    const reverted = item.revertedAt ? " · reverted" : "";
    const requeued = item.requeued ? " · carried into a later review" : "";
    out.push(`**Human (${item.status})**${reason ? ` — ${md(reason)}` : ""}${reverted}${requeued}`, "");
  } else if (item.awaitingHuman) {
    out.push("**Human** — not answered; the agent is waiting on a decision.", "");
  }

  if (item.thread?.length) {
    out.push("**Thread**", "");
    for (const message of item.thread) {
      out.push(`- **${message.role}** (${when(message.at)}): ${md(message.text)}`);
    }
    out.push("");
  }
  return out;
}

function lastHumanText(item: ReviewItem): string | null {
  const human = (item.thread ?? []).filter((message) => message.role === "human");
  return human[human.length - 1]?.text ?? null;
}

// ---------------------------------------------------------------------------
// Escaping.
//
// Every string below is human or agent prose, and prose about a document full
// of code routinely contains backticks, pipes, underscores and angle brackets.
// Unescaped, one backtick in a note swallows the rest of the section into a
// code span and one pipe splits a table row into the wrong number of cells —
// so the transcript silently misrenders exactly the reviews that talk about
// markup, which is most of them.
// ---------------------------------------------------------------------------

const INLINE_SPECIALS = /[\\`*_[\]<>|~]/g;

function md(text: string): string {
  return (
    text
      .replace(INLINE_SPECIALS, "\\$&")
      // Block openers only matter at the start of a line, and escaping `-` or a
      // digit-dot everywhere would turn "cut 30-40%" into "cut 30\-40%".
      .replace(/^(\s*)([#>+-]|\d+\.)/gm, "$1\\$2")
  );
}

/** Table cells cannot contain a newline: the row would end early and eat the rest. */
function cell(text: string): string {
  return md(truncate(text.replace(/\s*\n\s*/g, " "), 160));
}

function code(text: string): string {
  // A backslash does not escape inside a code span, so the only defence for a
  // backtick is to widen the span's own fence.
  return text.replace(/`/g, "` ");
}

/** A fence longer than any run of backticks inside, so the block cannot be closed early. */
function fence(text: string): string[] {
  const longest = Math.max(0, ...[...text.matchAll(/`+/g)].map((match) => match[0].length));
  const bars = "`".repeat(Math.max(3, longest + 1));
  return [bars, text, bars];
}

function quote(text: string): string[] {
  return md(text)
    .split("\n")
    .map((line) => `> ${line}`);
}

function truncate(text: string, max: number): string {
  return text.length <= max ? text : `${text.slice(0, max - 1)}…`;
}

function count(n: number, noun: string): string {
  return `${n} ${noun}${n === 1 ? "" : "s"}`;
}

/**
 * UTC, to the minute. Local formatting would make the same session render
 * differently on two machines, which is the one thing an audit trail must not
 * do; the seconds are noise in a document about days of review.
 */
function when(iso: string): string {
  const at = new Date(iso);
  if (Number.isNaN(at.getTime())) return md(iso);
  return `${at.toISOString().slice(0, 16)}Z`;
}
