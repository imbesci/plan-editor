// How a review is described to the agent.
//
// Extracted from the CLI so the MCP server can use the identical wording:
// importing cli.ts to reach it would run its top-level `main()`, and two front
// doors describing the same review differently is how an agent learns one set of
// habits under Claude Code and a different set everywhere else.

import path from "node:path";

import type { ContractRule, Lock, PollResult, Review } from "./protocol.ts";

const MARKDOWN = /\.(md|markdown|mdx)$/i;

export function formatPollResult(file: string, result: PollResult): unknown {
  if (result.status === "waiting") {
    return {
      status: "waiting",
      next_step: `No review arrived before the timeout. Run \`plan-editor watch ${file}\` to keep waiting.`,
    };
  }
  if (result.status === "ended") {
    return {
      status: "ended",
      ended_by: result.endedBy,
      next_step: "The human ended this session. Stop polling and report back in the conversation.",
    };
  }
  return formatReview(file, result.review, Boolean(result.sessionEnded), result);
}

interface StandingContext {
  contract?: ContractRule[];
  locks?: Lock[];
  companions?: string[];
  sourceLines?: Record<string, { line: number; endLine: number }>;
}

/** The id an anchor selector points at, when it points at one at all. */
function idFromSelector(selector: string): string | null {
  const match = /#([A-Za-z0-9_-]+)\s*$/.exec(selector);
  return match?.[1] ?? null;
}

/** How one item is described to the agent, by kind. */
function describeItem(
  item: Review["items"][number],
  file: string,
  sourceLines?: Record<string, { line: number; endLine: number }>,
): Record<string, unknown> {
  // For a markdown artifact the selector is an artefact of the render, not
  // something the agent can act on. The line range is.
  const id = idFromSelector(item.selector);
  const span = id && sourceLines ? sourceLines[id] : undefined;

  // A note dropped on a diagram node. The anchor still points at the diagram's
  // *source* — the block the agent edits — so this only has to say which node
  // was meant. Identity and label, never coordinates: the diagram is re-rendered
  // from source on every patch, so any geometry would be stale immediately.
  const node = item.anchors?.[0]?.node;

  const base: Record<string, unknown> = {
    id: item.id,
    request: item.body,
    anchor_text: item.text,
    ...(node
      ? {
          diagram_node: node.label ? `${node.label} (${node.id})` : node.id,
          diagram_note: "Edit the diagram source this anchor points at; the rendered view is generated from it.",
        }
      : {}),
    ...(span
      ? { source: `${path.basename(file)}:${span.line}-${span.endLine}` }
      : { selector_hint: item.selector }),
    // Only meaningful for a chunk selection; reporting `covers: 1` on every
    // item would be noise the agent has to filter.
    ...(item.anchors && item.anchors.length > 1 ? { covers: item.anchors.length } : {}),
    ...(item.status === "orphaned" ? { note: "this item's anchor no longer exists" } : {}),
  };
  if (item.tag === "verbatim") {
    // The replacement *is* the request. Prose would only reintroduce the
    // ambiguity the human avoided by typing the text themselves.
    return {
      ...base,
      kind: "verbatim",
      replace_this: item.text,
      with_exactly: item.replacement,
      note: "Apply this text literally. If you disagree, skip it and say why — do not paraphrase it.",
    };
  }
  if (item.tag === "structural" && item.op) {
    return {
      ...base,
      kind: "structural",
      operation: item.op.kind,
      ...(item.op.targetText ? { target_text: item.op.targetText } : {}),
      ...(item.op.targetSelector ? { target_selector: item.op.targetSelector } : {}),
    };
  }
  return base;
}

/**
 * The overall note leads, because it is the context that makes the individual
 * items interpretable — "cut this by a third" changes what every item means.
 * The standing contract leads even that: it is what makes round four stop
 * repeating round one's correction.
 */
export function formatReview(
  file: string,
  review: Review,
  sessionEnded = false,
  standing: StandingContext = {},
): unknown {
  const items = review.items.filter((item) => item.status === "sent" || item.status === "orphaned");
  const rules = (standing.contract ?? []).filter((rule) => !rule.retiredAt);
  const locks = standing.locks ?? [];
  return {
    status: "review",
    review_id: review.id,
    ...(rules.length
      ? {
          standing_rules: rules.map((rule) => rule.text),
          standing_rules_note:
            "These apply to every review of this document, not just this one. The human set them because the same " +
            "correction kept coming back. Honour them even where this review says nothing about them.",
        }
      : {}),
    ...(locks.length
      ? {
          do_not_touch: locks.map((lock) => ({ selector: lock.selector, text: lock.text, label: lock.label })),
          do_not_touch_note:
            "Locked regions. Do not edit these, even incidentally, and even if an item seems to ask for it — say so " +
            "instead and let the human unlock it.",
        }
      : {}),
    ...(standing.companions?.length ? { reviewed_alongside: standing.companions } : {}),
    overall_note: review.note || null,
    items: items.map((item) => describeItem(item, file, standing.sourceLines)),
    next_step:
      `This is one review, not a stream — read the overall note first, then every item, and work out how they fit together ` +
      `before changing anything. Two items can pull in opposite directions, and the note usually says which wins. ` +
      `Apply them all by editing ${file} directly; the open browser patches itself in place, so never ask the user to reload. ` +
      (MARKDOWN.test(file)
        ? // The renderer already derives an id per block, so the HTML advice
          // would be nonsense here — there is no markup for the agent to add.
          `Each item carries the source line range it refers to; edit those lines. Keep heading text stable where you ` +
          `can, because the anchors are derived from it. `
        : `Give top-level sections stable \`id\` attributes so items can be matched precisely. `) +
      `When you are done, run \`plan-editor respond ${file} --summary "<what you changed and why>"\` — that closes the review ` +
      `and is what puts your work in front of the human to accept or reject. ` +
      `If an item is ambiguous, do not guess and do not silently skip it: run ` +
      `\`plan-editor ask ${file} --id <id> --question "<what you need to know>"\`, which parks until the human answers in ` +
      `the browser. If you would rather show two options than ask, use \`plan-editor alternatives\`. ` +
      `Use \`plan-editor answer ${file} --id <id> --outcome needs-call|caveat|skipped --note "<why>"\` for anything you ` +
      `deliberately did not do.` +
      (sessionEnded ? " Note: the human ended the session with this review, so do not wait for another." : ""),
  };
}

