// Every wire contract lives here exactly once: the shapes the browser posts, the
// shapes the agent polls, and the records on disk. Runtime validators sit next to
// the types so a malformed POST is rejected at the edge instead of corrupting a
// session record.

export type AnnotationStatus =
  | "draft" // exists in the browser only; never reaches the server
  | "submitted" // waiting for the agent
  | "addressed" // the agent's edit touched the anchored element
  | "resolved" // human confirmed
  | "orphaned"; // the anchored element vanished across an edit

export interface Annotation {
  id: string;
  /** What the human wants. Either a literal edit or an open-ended prompt. */
  body: string;
  /** Structural hint for the agent. Never treated as durable identity. */
  selector: string;
  /** Snippet of the anchored content, for agent context and for re-anchoring. */
  text: string;
  /** "element" for a pinned annotation, "message" for freeform chat. */
  tag: "element" | "message";
  status: AnnotationStatus;
  createdAt: string;
  submittedAt?: string;
  /** When this edit was last injected into an agent's context. */
  deliveredAt?: string;
  addressedAt?: string;
  /** Optional note the agent leaves when it marks something addressed. */
  agentNote?: string;
}

export interface ChatMessage {
  role: "user" | "agent";
  text: string;
  at: string;
}

export interface Session {
  key: string;
  /** Capability token. Required on every session-scoped route. */
  token: string;
  /** Canonical (realpath-resolved) artifact path. */
  file: string;
  status: "open" | "ended";
  endedBy?: "user" | "agent";
  annotations: Annotation[];
  chat: ChatMessage[];
  createdAt: string;
  updatedAt: string;
}

/** Server -> browser, over SSE. */
export type ServerEvent =
  | { type: "patch"; reason: "file-changed" }
  | { type: "agent-activity"; active: boolean }
  | { type: "agent-reply"; text: string }
  | { type: "sync"; annotations: Annotation[]; chat: ChatMessage[] }
  | { type: "presence"; state: AgentPresence };

export type AgentPresence = "waiting" | "listening" | "working";

/** Agent-facing poll result. */
export type PollResult =
  | { status: "waiting" }
  | { status: "ended"; endedBy: "user" | "agent" }
  | {
      status: "feedback";
      annotations: Annotation[];
      sessionEnded?: boolean;
      endedBy?: "user" | "agent";
    };

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

/** Parses one client-submitted annotation. Server owns id/status/timestamps. */
export function parseIncomingAnnotation(input: unknown): Omit<Annotation, "id" | "status" | "createdAt"> {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    throw new ValidationError("annotation must be an object");
  }
  const raw = input as Record<string, unknown>;
  const body = str(raw.body ?? "", MAX_BODY, "body").trim();
  if (!body) throw new ValidationError("body must not be empty");
  const tag = raw.tag === "message" ? "message" : "element";
  return {
    body,
    selector: str(raw.selector ?? "", MAX_SELECTOR, "selector"),
    text: str(raw.text ?? "", MAX_TEXT, "text"),
    tag,
  };
}

export function parseIncomingAnnotations(input: unknown): Array<Omit<Annotation, "id" | "status" | "createdAt">> {
  if (!Array.isArray(input)) throw new ValidationError("annotations must be an array");
  if (input.length > 100) throw new ValidationError("too many annotations in one request");
  return input.map(parseIncomingAnnotation);
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

export function isOpenAnnotation(annotation: Annotation): boolean {
  return annotation.status === "submitted";
}
