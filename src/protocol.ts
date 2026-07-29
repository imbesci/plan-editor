// Every wire contract lives here exactly once: the shapes the browser posts, the
// shapes the agent polls, and the records on disk. Runtime validators sit next to
// the types so a malformed POST is rejected at the edge instead of corrupting a
// session record.

// ---------------------------------------------------------------------------
// A review is the unit of exchange, not an individual note.
//
// The live model sent every note the moment it was written, so the agent acted
// on each one blind to what came next — three separate instructions about one
// paragraph landed as three rewrites that cancelled out. Marking up in full and
// sending once gives the agent the *shape* of the intent, and freezes the
// document while the human is reading it.
// ---------------------------------------------------------------------------

export interface Anchor {
  selector: string;
  text: string;
  /**
   * Hash of the anchored text at capture time. The selector is a hint and the
   * text is exact-match-only, so neither survives the agent rewriting the very
   * element the note is about — which is precisely the set of elements that
   * change. The hash lets re-anchoring score candidates instead of demanding
   * equality. See `src/sdk/anchor.ts`.
   */
  hash?: string;
  /** Word shingles of the anchored text, for similarity scoring. */
  shingles?: string[];
  /**
   * Set when the human clicked a node inside a rendered diagram.
   *
   * The anchor itself still points at the *source* element — the `<pre>` holding
   * the diagram text, which is what exists in the file and what the agent edits.
   * This just says which node they meant.
   *
   * Deliberately identity and label, never coordinates. A diagram is re-rendered
   * from its source on every patch and on every theme change, so any x/y would
   * be stale the moment the agent touched it; the node id comes from the source
   * text and survives.
   */
  node?: { id: string; label: string };
}

/**
 * A rule that outlives any single review.
 *
 * The overall note dies with its review, so the same correction gets made in
 * round four that was made in round one. A contract rule is injected ahead of
 * every review, forever, until the human retires it.
 */
export interface ContractRule {
  id: string;
  text: string;
  createdAt: string;
  /** Set when promoted from a rejection, so the panel can show its provenance. */
  fromItemId?: string;
  /** Retired rules are kept for provenance but never injected. */
  retiredAt?: string;
}

/**
 * A region the agent must not touch.
 *
 * Attribution already reports changes nobody asked for; a lock upgrades that
 * from a report into an enforcement, which is what a document containing
 * load-bearing numbers needs.
 */
export interface Lock {
  id: string;
  selector: string;
  text: string;
  label?: string;
  createdAt: string;
}

/** One of several versions of a section the agent wants the human to pick from. */
export interface Alternative {
  id: string;
  label: string;
  html: string;
}

/** A structural intent, which prose describes worst and a diff verifies best. */
export interface StructuralOp {
  kind: "delete" | "move-before" | "move-after" | "split" | "merge";
  /** The other element involved, for move/merge. */
  targetSelector?: string;
  targetText?: string;
}

export interface ThreadMessage {
  role: "human" | "agent";
  text: string;
  at: string;
}

export type ReviewStatus =
  | "drafting" // being marked up; the agent knows nothing about it
  | "sent" // handed to the agent as one batch
  | "answered" // the agent has dealt with every item
  | "closed"; // the human has accepted or rejected each item

export type ItemStatus =
  | "draft"
  | "sent"
  | "answered" // the agent responded — awaiting the human's accept/reject
  | "accepted"
  | "rejected"
  | "orphaned"; // the anchor vanished

/** How the agent answered one item. */
export type ItemOutcome =
  | "applied" // done as asked
  | "caveat" // done, but with a caveat the human should read
  | "needs-call" // ambiguous; the agent wants a decision rather than guessing
  | "skipped"; // deliberately not done, with a reason

/**
 * `verbatim` and `structural` exist because prose is the worst way to express
 * the two cheapest kinds of change. "Change 'leverage' to 'use'" is a round
 * trip and an ambiguity; the replacement text is neither. Likewise "move Risks
 * above Milestones but leave the intro" is an id-set operation dressed up as a
 * sentence.
 */
export type ItemTag = "element" | "text" | "page" | "verbatim" | "structural";

export interface ReviewItem {
  id: string;
  /** What the human wants changed. */
  body: string;
  /** Structural hint for the agent. Never durable identity. */
  selector: string;
  /** Snippet of the anchored content, for context and re-anchoring. */
  text: string;
  /** Every element this item covers; several when chunk-selected. */
  anchors?: Anchor[];
  tag: ItemTag;
  /** For `verbatim`: the exact text the human wants in place of `text`. */
  replacement?: string;
  /** For `structural`: the operation requested. */
  op?: StructuralOp;
  status: ItemStatus;
  outcome?: ItemOutcome;
  /** The agent's note about how it handled this item. */
  agentNote?: string;
  thread?: ThreadMessage[];
  /**
   * True when the agent asked a question and is waiting. `needs-call` without
   * this was a dead end: the agent flagged ambiguity and had no way to hear an
   * answer short of a whole new review cycle.
   */
  awaitingHuman?: boolean;
  /** Versions of this section the agent wants the human to choose between. */
  alternatives?: Alternative[];
  chosenAlternative?: string;
  createdAt: string;
  answeredAt?: string;
  /** Set when the human rejected this item *and* undid the agent's change. */
  revertedAt?: string;
  /** Carried into a later review after rejection; prevents duplicating it. */
  requeued?: boolean;
}

export interface Review {
  id: string;
  /**
   * The review-level note: "cut this by a third", "the tone is too hedged".
   * This is the context that makes the individual items interpretable, which is
   * why it is a first-class field rather than another pinned comment.
   */
  note: string;
  status: ReviewStatus;
  items: ReviewItem[];
  /** The agent's overall response to the review. */
  summary?: string;
  createdAt: string;
  sentAt?: string;
  answeredAt?: string;
  /**
   * The artifact version at the moment this review was sent.
   *
   * One field, three capabilities: diffing the agent's work per item, spotting
   * changes it made that nobody asked for, and reverting the whole review as a
   * unit — which is the natural undo now that a review is the unit of exchange.
   */
  baseVersion?: number;
  /** Agent sessions this review's text has already been injected into. */
  deliveredTo?: string[];
}

export interface ChatMessage {
  role: "user" | "agent";
  text: string;
  at: string;
}

export interface Session {
  key: string;
  /** Newest last. At most one is ever `drafting`. */
  reviews: Review[];
  /** Capability token. Required on every session-scoped route. */
  token: string;
  /** Canonical (realpath-resolved) artifact path. */
  file: string;
  status: "open" | "ended";
  endedBy?: "user" | "agent";
  /**
   * The Claude Code session that opened this artifact — i.e. the agent that
   * holds the conversation the plan came out of. Edits are routed back to it.
   */
  authoredBy?: string;
  /** cwd at open time; the fallback route when there is no session id. */
  authoredIn?: string;
  chat: ChatMessage[];
  /** Rules that outlive every review. Injected ahead of the review itself. */
  contract: ContractRule[];
  /** Regions the agent must not touch. */
  locks: Lock[];
  /**
   * Other artifacts reviewed alongside this one. A cross-cutting note — "these
   * three disagree about the retry budget" — is not expressible against a
   * single file, and the agent needs to see the set to answer it.
   */
  companions: string[];
  createdAt: string;
  updatedAt: string;
}

/** Server -> browser, over SSE. */
export type ServerEvent =
  | { type: "patch"; reason: "file-changed" }
  | { type: "agent-activity"; active: boolean }
  | { type: "agent-reply"; text: string }
  | {
      type: "sync";
      reviews: Review[];
      chat: ChatMessage[];
      contract: ContractRule[];
      locks: Lock[];
      companions: string[];
    }
  | { type: "versions"; list: VersionMeta[] }
  | { type: "presence"; state: AgentPresence; agent: AgentIdentityView };

export interface VersionMeta {
  seq: number;
  at: string;
  bytes: number;
  origin: "open" | "edit" | "restore";
  /** A human name, so history is not a row of anonymous `v7`s. */
  label?: string;
  /** Pinned versions are exempt from the oldest-first cap. */
  pinned?: boolean;
}

/**
 * How often one section has been rewritten. The sharpest signal in the system:
 * a section rewritten six times is a section the human and the agent still
 * disagree about, and nothing surfaced that before.
 */
export interface SectionChurn {
  id: string;
  label: string;
  rewrites: number;
  lastAt: string;
}

export type AgentPresence = "waiting" | "listening" | "working";

/** Who is on the other end, for the browser to show. */
export interface AgentIdentityView {
  /** Short form of the bound Claude session id, or null when unbound. */
  session: string | null;
  /** ISO timestamp of the last hook or poll contact. */
  lastContact: string | null;
  /** True when hooks are delivering rather than a blocking poll. */
  viaHooks: boolean;
}

/**
 * Agent-facing poll result. A whole review, never a loose note — and never a
 * review without the standing context that makes it interpretable.
 */
export type PollResult =
  | { status: "waiting" }
  | { status: "ended"; endedBy: "user" | "agent" }
  | {
      status: "review";
      review: Review;
      /** Rules that apply to every review, not just this one. */
      contract?: ContractRule[];
      /** Regions the agent must not touch. */
      locks?: Lock[];
      /** Other artifacts under review alongside this one. */
      companions?: string[];
      /**
       * For markdown artifacts, where each anchored id lives in the source.
       * A CSS selector is useless to an agent editing a .md file; "42-47" is
       * something it can act on directly.
       */
      sourceLines?: Record<string, { line: number; endLine: number }>;
      sessionEnded?: boolean;
      endedBy?: "user" | "agent";
    };

/** A review made portable, so a second reviewer needs no server and no account. */
export interface ReviewPacket {
  packet: 1;
  artifact: string;
  /** sha256 of the artifact the review was written against. */
  artifactSha: string;
  exportedAt: string;
  review: Review;
  contract: ContractRule[];
}

// ---------------------------------------------------------------------------
// Validators. Hand-written and total: every field is coerced or rejected, never
// spread from untrusted input.
// ---------------------------------------------------------------------------

export class ValidationError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "ValidationError";
  }
}

const MAX_BODY = 8_000;
const MAX_TEXT = 2_000;
const MAX_SELECTOR = 1_000;

function str(value: unknown, max: number, field: string): string {
  if (typeof value !== "string") throw new ValidationError(`${field} must be a string`);
  if (value.length > max) throw new ValidationError(`${field} exceeds ${max} characters`);
  return value;
}

export function parseReviewNote(input: unknown): string {
  const raw = (input ?? {}) as Record<string, unknown>;
  return str(raw.note ?? "", MAX_BODY, "note");
}

export function parseItemOutcome(value: unknown): ItemOutcome {
  return value === "caveat" || value === "needs-call" || value === "skipped" ? value : "applied";
}

const ITEM_TAGS = new Set<ItemTag>(["element", "text", "page", "verbatim", "structural"]);
const STRUCTURAL_KINDS = new Set<StructuralOp["kind"]>([
  "delete",
  "move-before",
  "move-after",
  "split",
  "merge",
]);

function parseStructuralOp(input: unknown): StructuralOp {
  const raw = (input ?? {}) as Record<string, unknown>;
  const kind = raw.kind as StructuralOp["kind"];
  if (!STRUCTURAL_KINDS.has(kind)) throw new ValidationError("unknown structural operation");
  return {
    kind,
    ...(raw.targetSelector !== undefined
      ? { targetSelector: str(raw.targetSelector, MAX_SELECTOR, "op.targetSelector") }
      : {}),
    ...(raw.targetText !== undefined ? { targetText: str(raw.targetText, MAX_TEXT, "op.targetText") } : {}),
  };
}

export interface IncomingItem {
  body: string;
  selector: string;
  text: string;
  anchors?: Anchor[];
  tag: ItemTag;
  replacement?: string;
  op?: StructuralOp;
}

/** Parses one client-submitted review item. Server owns id/status/timestamps. */
export function parseIncomingItem(input: unknown): IncomingItem {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("item must be an object");
  }
  const raw = input as Record<string, unknown>;
  const tag: ItemTag = ITEM_TAGS.has(raw.tag as ItemTag) ? (raw.tag as ItemTag) : "element";

  // A verbatim item carries its own instruction: the replacement text *is* the
  // request, so demanding prose on top of it would be busywork.
  const replacement = tag === "verbatim" ? str(raw.replacement ?? "", MAX_BODY, "replacement") : undefined;
  const op = tag === "structural" ? parseStructuralOp(raw.op) : undefined;

  const body = str(
    raw.body ?? (replacement !== undefined ? "Replace with the supplied text." : op ? `${op.kind} this` : ""),
    MAX_BODY,
    "body",
  ).trim();
  if (!body) throw new ValidationError("body must not be empty");

  const anchors = Array.isArray(raw.anchors)
    ? raw.anchors.slice(0, 40).map((entry) => {
        const anchor = (entry ?? {}) as Record<string, unknown>;
        return {
          selector: str(anchor.selector ?? "", MAX_SELECTOR, "anchor.selector"),
          text: str(anchor.text ?? "", MAX_TEXT, "anchor.text"),
          ...(anchor.hash !== undefined ? { hash: str(anchor.hash, 64, "anchor.hash") } : {}),
          ...(anchor.node && typeof anchor.node === "object"
            ? {
                node: {
                  id: str((anchor.node as Record<string, unknown>).id ?? "", 200, "anchor.node.id"),
                  label: str((anchor.node as Record<string, unknown>).label ?? "", 200, "anchor.node.label"),
                },
              }
            : {}),
          ...(Array.isArray(anchor.shingles)
            ? {
                shingles: anchor.shingles
                  .slice(0, 120)
                  .filter((s): s is string => typeof s === "string" && s.length <= 120),
              }
            : {}),
        };
      })
    : [];
  return {
    body,
    selector: str(raw.selector ?? anchors[0]?.selector ?? "", MAX_SELECTOR, "selector"),
    text: str(raw.text ?? anchors[0]?.text ?? "", MAX_TEXT, "text"),
    tag,
    ...(replacement !== undefined ? { replacement } : {}),
    ...(op ? { op } : {}),
    // Kept even for a single anchor now that anchors carry the hash and
    // shingles re-anchoring needs. `anchors[0]` still mirrors selector/text, so
    // single-anchor consumers need no branching.
    ...(anchors.length ? { anchors } : {}),
  };
}

export function parseIncomingItems(input: unknown): ReturnType<typeof parseIncomingItem>[] {
  if (!Array.isArray(input)) throw new ValidationError("items must be an array");
  if (input.length > 100) throw new ValidationError("too many items in one request");
  return input.map(parseIncomingItem);
}

/** Parses the browser's post-morph report of which annotations were touched. */
export function parseMorphReport(input: unknown): { addressed: string[]; orphaned: string[] } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const ids = (value: unknown): string[] => {
    if (!Array.isArray(value)) return [];
    return value.filter((entry): entry is string => typeof entry === "string" && entry.length <= 64).slice(0, 500);
  };
  return { addressed: ids(raw.addressed), orphaned: ids(raw.orphaned) };
}

/** Parses a re-anchor request for an orphaned edit. */
export function parseRepoint(input: unknown): { selector: string; text: string } {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    selector: str(raw.selector ?? "", MAX_SELECTOR, "selector"),
    text: str(raw.text ?? "", MAX_TEXT, "text"),
  };
}

export function parseThreadText(input: unknown): string {
  const raw = (input ?? {}) as Record<string, unknown>;
  const text = str(raw.text ?? "", MAX_BODY, "text").trim();
  if (!text) throw new ValidationError("text must not be empty");
  return text;
}

export function parseContractText(input: unknown): string {
  const raw = (input ?? {}) as Record<string, unknown>;
  const text = str(raw.text ?? "", MAX_BODY, "text").trim();
  if (!text) throw new ValidationError("a rule must not be empty");
  return text;
}

export function parseLockInput(input: unknown): { selector: string; text: string; label?: string } {
  const raw = (input ?? {}) as Record<string, unknown>;
  const selector = str(raw.selector ?? "", MAX_SELECTOR, "selector").trim();
  if (!selector) throw new ValidationError("a lock needs a selector");
  return {
    selector,
    text: str(raw.text ?? "", MAX_TEXT, "text"),
    ...(raw.label !== undefined ? { label: str(raw.label, 200, "label") } : {}),
  };
}

export function parseAlternatives(input: unknown): Alternative[] {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (!Array.isArray(raw.alternatives)) throw new ValidationError("alternatives must be an array");
  if (raw.alternatives.length < 2) throw new ValidationError("offer at least two alternatives");
  if (raw.alternatives.length > 6) throw new ValidationError("too many alternatives");
  return raw.alternatives.map((entry, index) => {
    const alt = (entry ?? {}) as Record<string, unknown>;
    return {
      id: str(alt.id ?? `alt${index + 1}`, 64, "alternative.id"),
      label: str(alt.label ?? `Option ${index + 1}`, 200, "alternative.label"),
      html: str(alt.html ?? "", 40_000, "alternative.html"),
    };
  });
}

export function parseVersionLabel(input: unknown): { label?: string; pinned?: boolean } {
  const raw = (input ?? {}) as Record<string, unknown>;
  return {
    ...(raw.label !== undefined ? { label: str(raw.label, 200, "label").trim() } : {}),
    ...(raw.pinned !== undefined ? { pinned: Boolean(raw.pinned) } : {}),
  };
}

/**
 * Validates an imported packet. This is the one place untrusted *file* content
 * enters the store, so it is parsed field by field rather than spread — a
 * packet arrives from another machine and another person.
 */
export function parseReviewPacket(input: unknown): ReviewPacket {
  const raw = (input ?? {}) as Record<string, unknown>;
  if (raw.packet !== 1) throw new ValidationError("not a plan-editor review packet");
  const review = (raw.review ?? {}) as Record<string, unknown>;
  if (!Array.isArray(review.items)) throw new ValidationError("packet review has no items");
  if (review.items.length > 200) throw new ValidationError("packet has too many items");
  return {
    packet: 1,
    artifact: str(raw.artifact ?? "", 1024, "artifact"),
    artifactSha: str(raw.artifactSha ?? "", 64, "artifactSha"),
    exportedAt: str(raw.exportedAt ?? new Date(0).toISOString(), 40, "exportedAt"),
    contract: Array.isArray(raw.contract)
      ? raw.contract.slice(0, 100).map((entry) => {
          const rule = (entry ?? {}) as Record<string, unknown>;
          return {
            id: str(rule.id ?? "", 64, "contract.id"),
            text: str(rule.text ?? "", MAX_BODY, "contract.text"),
            createdAt: str(rule.createdAt ?? new Date(0).toISOString(), 40, "contract.createdAt"),
          };
        })
      : [],
    review: {
      id: str(review.id ?? "", 64, "review.id"),
      note: str(review.note ?? "", MAX_BODY, "review.note"),
      status: "sent",
      createdAt: str(review.createdAt ?? new Date(0).toISOString(), 40, "review.createdAt"),
      items: review.items.map((entry) => {
        const parsed = parseIncomingItem(entry);
        const item = (entry ?? {}) as Record<string, unknown>;
        return {
          ...parsed,
          id: str(item.id ?? "", 64, "item.id"),
          status: "draft" as const,
          createdAt: str(item.createdAt ?? new Date(0).toISOString(), 40, "item.createdAt"),
        };
      }),
    },
  };
}
