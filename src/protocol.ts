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
  tag: "element" | "text" | "page";
  status: ItemStatus;
  outcome?: ItemOutcome;
  /** The agent's note about how it handled this item. */
  agentNote?: string;
  thread?: ThreadMessage[];
  createdAt: string;
  answeredAt?: string;
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
  createdAt: string;
  updatedAt: string;
}

/** Server -> browser, over SSE. */
export type ServerEvent =
  | { type: "patch"; reason: "file-changed" }
  | { type: "agent-activity"; active: boolean }
  | { type: "agent-reply"; text: string }
  | { type: "sync"; reviews: Review[]; chat: ChatMessage[] }
  | { type: "versions"; list: VersionMeta[] }
  | { type: "presence"; state: AgentPresence; agent: AgentIdentityView };

export interface VersionMeta {
  seq: number;
  at: string;
  bytes: number;
  origin: "open" | "edit" | "restore";
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

/** Agent-facing poll result. A whole review, never a loose note. */
export type PollResult =
  | { status: "waiting" }
  | { status: "ended"; endedBy: "user" | "agent" }
  | { status: "review"; review: Review; sessionEnded?: boolean; endedBy?: "user" | "agent" };

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

/** Parses one client-submitted review item. Server owns id/status/timestamps. */
export function parseIncomingItem(input: unknown): {
  body: string;
  selector: string;
  text: string;
  anchors?: Anchor[];
  tag: ReviewItem["tag"];
} {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("item must be an object");
  }
  const raw = input as Record<string, unknown>;
  const body = str(raw.body ?? "", MAX_BODY, "body").trim();
  if (!body) throw new ValidationError("body must not be empty");
  const tag = raw.tag === "page" ? "page" : raw.tag === "text" ? "text" : "element";
  const anchors = Array.isArray(raw.anchors)
    ? raw.anchors.slice(0, 40).map((entry) => {
        const anchor = (entry ?? {}) as Record<string, unknown>;
        return {
          selector: str(anchor.selector ?? "", MAX_SELECTOR, "anchor.selector"),
          text: str(anchor.text ?? "", MAX_TEXT, "anchor.text"),
        };
      })
    : [];
  return {
    body,
    selector: str(raw.selector ?? anchors[0]?.selector ?? "", MAX_SELECTOR, "selector"),
    text: str(raw.text ?? anchors[0]?.text ?? "", MAX_TEXT, "text"),
    tag,
    ...(anchors.length > 1 ? { anchors } : {}),
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
