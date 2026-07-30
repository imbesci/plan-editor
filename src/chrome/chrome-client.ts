// The chrome owns all server access. The artifact iframe is sandboxed without
// `allow-same-origin`, so it has an opaque origin and cannot usefully call the
// API — which is also why the session token never leaves this file.
//
// Everything the human can do lives here: marking up, reading the agent's work,
// answering its questions, and the standing rules that outlive both. The panel
// is deliberately one column of state rendered from one `render()`, because the
// alternative — incremental DOM updates driven by a dozen event handlers — is
// how the panel and the store came to disagree about what was open.

import { attributeChanges, diffDocuments, diffWords, type Attribution, type SectionChange } from "../sdk/diff.ts";
import type {
  AgentIdentityView,
  AgentPresence,
  Alternative,
  ChatMessage,
  ContractRule,
  ItemTag,
  Lock,
  Review,
  ReviewItem,
  SectionChurn,
  ServerEvent,
  StructuralOp,
  VersionMeta,
} from "../protocol.ts";

interface Bootstrap {
  key: string;
  token: string;
  file: string;
  status: "open" | "ended";
}

const bootstrap = JSON.parse(document.getElementById("pe-session")!.textContent!) as Bootstrap;
const { key, token } = bootstrap;
const fileName = bootstrap.file.split("/").pop() ?? "artifact";

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const frame = $<HTMLIFrameElement>("artifact");
const list = $("list");
const input = $<HTMLTextAreaElement>("input");
const search = $<HTMLInputElement>("search");
const findBox = $<HTMLInputElement>("find");
const overall = $<HTMLTextAreaElement>("overall");
const addNote = $<HTMLButtonElement>("addNote");
const sendButton = $<HTMLButtonElement>("send");
const endButton = $<HTMLButtonElement>("end");
const modeToggle = $<HTMLInputElement>("modeToggle");
const suggestButton = $<HTMLButtonElement>("suggest");
const structuralSelect = $<HTMLSelectElement>("structural");
const presence = $("presence");
const undoButton = $<HTMLButtonElement>("undo");
const overlay = $("overlay");
const toasts = $("toasts");
const statusBar = $("statusBar");
const statusText = $("statusText");
const statusAction = $<HTMLButtonElement>("statusAction");
const chatLog = $("chatLog");
const chatInput = $<HTMLTextAreaElement>("chatInput");
const targetHint = $("targetHint");
const targetActions = $("targetActions");
const layout = $("layout");
const filtersBar = $("filters");
const outlineBox = $("outline");
const navigator_ = $<HTMLDetailsElement>("navigator");
const findCount = $("findCount");
const contractList = $("contractList");
const ruleInput = $<HTMLTextAreaElement>("ruleInput");
const locksPanel = $<HTMLDetailsElement>("locksPanel");
const lockList = $("lockList");

/** The element(s) the next note will be pinned to. */
interface Armed {
  clientId: string;
  anchors: Array<{ selector: string; text: string; locked?: boolean }>;
  kind: "element" | "text";
}

type StructuralKind = StructuralOp["kind"];
/** Outcome filter chips. `open` is "the agent answered and you have not". */
type Filter = "all" | "awaiting" | "open" | "applied" | "caveat" | "needs-call" | "skipped" | "settled";

let reviews: Review[] = [];
let chat: ChatMessage[] = [];
let contract: ContractRule[] = [];
let locks: Lock[] = [];
/** Artifacts under review alongside this one. Read-only here: the set is
 *  established from the CLI, and showing it is what stops a cross-cutting note
 *  looking like it was addressed to a document the agent was never given. */
let companions: string[] = [];
let versions: VersionMeta[] = [];
let presenceState: AgentPresence = "waiting";
let agentView: AgentIdentityView = { session: null, lastContact: null, viaHooks: false };
let armed: Armed | null = null;
let repointing: string | null = null;
let query = "";
let filter: Filter = "all";
let noteSaveTimer: number | undefined;
let findTimer: number | undefined;
/** What the agent actually changed, per item, for the review being read. */
let attribution: Attribution | null = null;
let attributedReviewId: string | null = null;
/** Id of the keyboard-focused card. Held by id, not index, so a re-render that
 *  reorders the list (an item becoming `awaitingHuman` sorts it to the top)
 *  keeps the ring on the card the human was looking at rather than on whatever
 *  slid into its position. */
let cursorId: string | null = null;
const trackedIds = new Set<string>();
/** Confidence the SDK reported for each tracked anchor, and the ranked
 *  near-misses for the ones it could not place. */
const anchorScores = new Map<string, number>();
const weakCandidates = new Map<string, Array<{ selector: string; text: string; score: number }>>();
/** The document's headings, as last reported by the SDK. */
let sections: Array<{ id: string; level: number; text: string }> = [];
/** Which armed gesture the artifact is in, so the toolbar can show it. */
let gesture: "suggest" | StructuralKind | null = null;

const draftReview = () => reviews.find((review) => review.status === "drafting");
const sentReview = () => reviews.find((review) => review.status === "sent");
/** The most recent review the agent has answered and the human has not closed. */
const answeredReview = () => [...reviews].reverse().find((review) => review.status === "answered");
/**
 * The review that was just settled, kept on screen until there is new markup.
 *
 * Giving the last item a verdict closes the review, which used to make the whole
 * thing vanish mid-keystroke: the work disappeared with no confirmation, and `u`
 * — the documented undo for a misfired verdict — became unreachable in exactly
 * the case you need it, because it acts on the focused card and there was no
 * longer a card. A closed review stays visible until the human starts marking up
 * again, which is the moment they have actually moved on.
 */
const closedReview = () => [...reviews].reverse().find((review) => review.status === "closed");

/**
 * Which of the two phases the panel is in. The whole point of the batch model is
 * that these never blur: you are either marking up, or reading the agent's work.
 */
function phase(): "drafting" | "sent" | "reviewing" {
  if (sentReview()) return "sent";
  if (answeredReview()) return "reviewing";
  // A review the human has just finished settling still belongs on screen — but
  // only until they start writing the next one.
  if (!draftReview()?.items.length && closedReview()) return "reviewing";
  return "drafting";
}

/** The review whose items the panel is showing. */
function visibleReview(): Review | undefined {
  const current = phase();
  if (current === "drafting") return draftReview();
  if (current === "sent") return sentReview();
  return answeredReview() ?? closedReview();
}

frame.src = `/artifact/${key}/index.html?t=${encodeURIComponent(token)}`;

function api(pathname: string, init: RequestInit = {}): Promise<globalThis.Response> {
  return fetch(`/api/${key}${pathname}?t=${encodeURIComponent(token)}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

/**
 * Every mutation goes through here rather than through a bare `api()` call.
 * Several handlers used to fire and forget, so a 400 from the server — a rule
 * that was empty, a review that had nothing to send — was indistinguishable
 * from success, and the panel simply never changed.
 */
async function send<T = unknown>(pathname: string, init: RequestInit = {}): Promise<T> {
  const response = await api(pathname, init);
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new Error(detail.error ?? `server said ${response.status}`);
  }
  return (await response.json().catch(() => null)) as T;
}

const body = (value: unknown): RequestInit => ({ method: "POST", body: JSON.stringify(value) });

function toFrame(message: unknown): void {
  frame.contentWindow?.postMessage(message, "*");
}

function escapeHtml(value: string): string {
  // `'` belongs in this set: every attribute this file writes is
  // double-quoted, but note bodies also land inside `title="…"` and inside
  // `data-` attributes built by string concatenation, and an apostrophe is the
  // one character a human types without thinking about it.
  return value.replace(
    /[&<>"']/g,
    (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[char]};`,
  );
}

// --- user-visible failure ---------------------------------------------------

/**
 * Every failure path used to be a console.error, so a broken morph or a dead
 * server looked identical to "nothing is happening". Anything the user needs to
 * know about goes through here instead.
 */
function toast(message: string, kind: "info" | "error" = "info", ms = 4200): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function setStatus(message: string | null, action?: { label: string; run: () => void }): void {
  if (!message) {
    statusBar.hidden = true;
    return;
  }
  statusBar.hidden = false;
  statusText.textContent = message;
  if (action) {
    statusAction.hidden = false;
    statusAction.textContent = action.label;
    statusAction.onclick = action.run;
  } else {
    statusAction.hidden = true;
  }
}

async function guard<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.error(what, error);
    toast(`${what} failed — ${String((error as Error)?.message ?? error)}`, "error");
    return null;
  }
}

function ago(iso: string | undefined): string {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/** Every rendered timestamp carries its instant, so it can be refreshed in
 *  place — see `refreshTimes`. */
function time(iso: string | undefined): string {
  return iso ? `<time data-at="${escapeHtml(iso)}">${ago(iso)}</time>` : "";
}

/**
 * Hands every still-open annotation to the SDK so it can re-anchor them. The
 * SDK's anchor map is per page load, so without this an annotation submitted
 * before a reload can never be marked addressed.
 */
function syncTracking(): void {
  for (const review of reviews) {
    for (const item of review.items) {
      if (item.status !== "sent" || item.tag === "page") continue;
      if (trackedIds.has(item.id)) continue;
      trackedIds.add(item.id);
      toFrame({ type: "pe:track", id: item.id, selector: item.selector, text: item.text, anchors: item.anchors });
    }
  }
}

// --- the document, as the chrome sees it ------------------------------------
//
// The panel needs to answer three questions about the artifact that the iframe
// cannot be asked (no `allow-same-origin`, so nothing can be read out of it):
// which section a note lives in, what a section looked like before the agent
// touched it, and what the document would look like with one section swapped.
// All three are answered from the raw HTML the chrome already fetches on every
// patch, parsed once and cached until it changes.

let currentHtml = "";
let parsedDoc: Document | null = null;

function setCurrentHtml(html: string): void {
  if (html === currentHtml) return;
  currentHtml = html;
  parsedDoc = null;
  sectionCache = null;
}

function liveDoc(): Document | null {
  if (!currentHtml) return null;
  if (!parsedDoc) parsedDoc = new DOMParser().parseFromString(currentHtml, "text/html");
  return parsedDoc;
}

/**
 * Finds the element an item is anchored to inside a parsed document.
 *
 * Deliberately the same rule `attributeChanges` uses — selector first, exact
 * normalized text second — because the two run against the same anchors and a
 * second, subtly different resolver would attribute a change to one element
 * while the revert put a different one back.
 */
function locateAnchor(doc: Document, anchor: { selector: string; text: string }): Element | null {
  if (anchor.selector) {
    try {
      const found = doc.querySelector(anchor.selector);
      if (found) return found;
    } catch {
      // Malformed stored selector; the text is still worth a try.
    }
  }
  const needle = anchor.text.replace(/\s+/g, " ").trim();
  if (!needle) return null;
  return (
    [...doc.body.querySelectorAll("*")].find(
      (candidate) => (candidate.textContent ?? "").replace(/\s+/g, " ").trim() === needle,
    ) ?? null
  );
}

let sectionCache: Map<string, string> | null = null;

/** Item id -> the outline section it sits in. */
function sectionIndex(): Map<string, string> {
  if (sectionCache) return sectionCache;
  const index = new Map<string, string>();
  const doc = liveDoc();
  const known = new Set(sections.map((entry) => entry.id).filter(Boolean));
  if (!doc || known.size === 0) {
    sectionCache = index;
    return index;
  }
  for (const review of reviews) {
    for (const item of review.items) {
      if (item.tag === "page") continue;
      const element = locateAnchor(doc, item);
      for (let node: Element | null = element; node; node = node.parentElement) {
        if (node.id && known.has(node.id)) {
          index.set(item.id, node.id);
          break;
        }
      }
    }
  }
  sectionCache = index;
  return index;
}

/**
 * The current document with one element replaced by supplied markup.
 *
 * Returns null rather than a best effort when the element cannot be found: this
 * feeds both the alternatives preview and the surgical revert, and a splice that
 * quietly put the replacement in the wrong place would be a write to the user's
 * file against an element they never pointed at.
 */
function spliceSection(anchor: { selector: string; text: string }, markup: string): string | null {
  if (!currentHtml) return null;
  const doc = new DOMParser().parseFromString(currentHtml, "text/html");
  const element = locateAnchor(doc, anchor);
  if (!element) return null;
  element.outerHTML = markup;
  return `<!doctype html>\n${doc.documentElement.outerHTML}`;
}

// --- rendering --------------------------------------------------------------

const OUTCOME_LABEL: Record<string, string> = {
  applied: "applied",
  caveat: "applied with a caveat",
  "needs-call": "needs your call",
  skipped: "not done",
};

const ITEM_LABEL: Record<ReviewItem["status"], string> = {
  draft: "in your review",
  sent: "with the agent",
  answered: "review it",
  accepted: "accepted",
  rejected: "rejected",
  orphaned: "target changed",
};

const OP_LABEL: Record<StructuralKind, string> = {
  delete: "delete this",
  "move-before": "move before",
  "move-after": "move after",
  split: "split here",
  merge: "merge with",
};

/**
 * A resolved anchor below this is a match the SDK accepted but only just.
 *
 * Resolution accepts at 0.72, so anything in the low eighties matched on a
 * fraction of its shingles — the note is probably still on the right paragraph
 * and might not be, and the human is the only one who can tell. Saying nothing
 * was the old behaviour and it is the one case where a wrong anchor is
 * invisible: the note looks tracked and quietly points somewhere else.
 */
const SHAKY = 0.85;

function matches(item: ReviewItem): boolean {
  if (query && !`${item.body} ${item.text} ${item.selector}`.toLowerCase().includes(query)) return false;
  switch (filter) {
    case "all":
      return true;
    case "awaiting":
      return Boolean(item.awaitingHuman);
    case "open":
      return item.status === "answered";
    case "settled":
      return item.status === "accepted" || item.status === "rejected";
    default:
      return item.outcome === filter;
  }
}

/**
 * Items an agent is parked on come first, always.
 *
 * An unanswered question is the only state in the system where the agent can do
 * nothing at all until the human acts, and burying it eleventh in a list is how
 * a session sits idle for an hour with both sides waiting on each other.
 */
function ordered(items: ReviewItem[]): ReviewItem[] {
  return [...items].sort((a, b) => Number(Boolean(b.awaitingHuman)) - Number(Boolean(a.awaitingHuman)));
}

/** Everything the human still has to deal with, for the tab title. */
function awaitingCount(): number {
  return reviews
    .flatMap((review) => review.items)
    .filter((item) => item.awaitingHuman || item.status === "answered").length;
}

let renderQueued = false;

/**
 * Coalesces the burst of renders a page load produces — one `pe:trackResult`
 * per open note, each of which changes what a card shows.
 *
 * A timer rather than `requestAnimationFrame`: rAF does not fire in a tab that
 * is not being composited, so a backgrounded panel banked every pending render
 * and only flushed them when the human looked at it — which is precisely the
 * tab the notification badge is trying to tell something to.
 */
function scheduleRender(): void {
  if (renderQueued) return;
  renderQueued = true;
  setTimeout(() => {
    renderQueued = false;
    render();
  }, 16);
}

function render(): void {
  const kept = capturePanel();
  const current = phase();
  const draft = draftReview();
  const sent = sentReview();
  // Falls back to a just-closed review so settling the last item does not make
  // the whole thing disappear out from under the human.
  const answered = answeredReview() ?? closedReview();
  const review = visibleReview();

  $("chatCount").textContent = String(chat.length);
  document.body.dataset.phase = current;

  const banner = repointing ? renderRepointBanner() : "";

  if (current === "drafting") {
    const count = draft?.items.length ?? 0;
    $("phaseTitle").textContent = "Your review";
    $("phaseHint").textContent =
      count === 0
        ? "Mark up the whole document, then send it as one review."
        : `${count} note${count === 1 ? "" : "s"} so far. Nothing reaches the agent until you send.`;
    const items = ordered(draft?.items ?? []).filter(matches);
    list.innerHTML =
      banner +
      (items.length
        ? items.map(renderItem).join("")
        : `<p class="empty">Turn on Annotate, click an element — or select text — and describe the change. Add as many notes as you like; the document stays still while you work.</p>`);
    sendButton.textContent = count > 0 ? `Send review (${count})` : "Send review";
    sendButton.disabled = count === 0 && !overall.value.trim();
  }

  if (current === "sent") {
    const count = sent?.items.length ?? 0;
    $("phaseTitle").textContent = "With the agent";
    $("phaseHint").textContent = `${count} note${count === 1 ? "" : "s"} sent. The agent is working through them as a set.`;
    list.innerHTML =
      banner +
      (sent?.note ? `<div class="overall-note"><b>Overall</b>${escapeHtml(sent.note)}</div>` : "") +
      ordered(sent?.items ?? []).filter(matches).map(renderItem).join("");
    sendButton.textContent = "Waiting…";
    sendButton.disabled = true;
  }

  if (current === "reviewing") {
    const open = (answered?.items ?? []).filter((item) => item.status === "answered").length;
    const applied = (answered?.items ?? []).filter(
      (item) => item.status === "answered" && item.outcome === "applied" && !item.awaitingHuman,
    );
    $("phaseTitle").textContent = "The agent's work";
    $("phaseHint").textContent = open
      ? `${open} change${open === 1 ? "" : "s"} to accept or reject.`
      : "All settled. Start marking up again whenever you like.";

    const unrequested = attribution?.unrequested ?? [];
    list.innerHTML =
      banner +
      (answered?.summary ? `<div class="summary"><b>Agent</b>${escapeHtml(answered.summary)}</div>` : "") +
      renderTriage(applied.length, Boolean(answered?.baseVersion), answered?.id) +
      // Changes nobody asked for are the ones worth looking at hardest, so they
      // go at the top rather than being buried under the items.
      (unrequested.length
        ? `<div class="unrequested"><b>${unrequested.length} change${unrequested.length === 1 ? "" : "s"} you did not ask for</b>
             ${unrequested.map((section) => `<div class="dhead"><span class="dkind ${section.kind}">${section.kind}</span> ${escapeHtml(section.label)}</div>`).join("")}</div>`
        : "") +
      renderRejectionGroups() +
      ordered(answered?.items ?? []).filter(matches).map(renderItem).join("");
    sendButton.textContent = "Send review";
    sendButton.disabled = (draftReview()?.items.length ?? 0) === 0;
  }

  renderFilters(review);
  renderOutline();
  renderContract();
  renderLocks();
  renderChat();
  renderGestures();
  restorePanel(kept);

  undoButton.disabled = versions.length < 2;
  addNote.disabled = !input.value.trim();
  targetActions.hidden = !armed;
  targetHint.textContent = armed
    ? armed.anchors.length > 1
      ? `${armed.anchors.length} elements selected — ⇧-click to add or remove`
      : `${armed.anchors[0]?.locked ? "🔒 locked · " : ""}Pinned to “${(armed.anchors[0]?.text ?? "").slice(0, 60)}”`
    : "Nothing selected — this note will apply to the page as a whole.";

  updateTitle();
}

/**
 * Timestamps, refreshed without touching anything else.
 *
 * The whole panel used to be re-rendered on a timer for this. It threw away the
 * j/k focus ring, any text selected in a note, and whatever was half-typed into
 * a reply box — once a minute, forever, with no event to explain it.
 */
function refreshTimes(): void {
  for (const node of document.querySelectorAll<HTMLTimeElement>("time[data-at]")) {
    node.textContent = ago(node.dataset.at);
  }
}

// --- preserving what the human is doing across a render ---------------------

interface PanelState {
  values: Map<string, string>;
  active: { keep: string; start: number; end: number } | null;
}

/**
 * A sync arrives whenever anything anywhere changes — the agent replying, a
 * version landing, another tab acting. Rebuilding the list under a half-typed
 * reply would eat it, so every text box inside the list carries a stable
 * `data-keep` key and its value and caret survive the rebuild.
 */
function capturePanel(): PanelState {
  const values = new Map<string, string>();
  for (const field of list.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("[data-keep]")) {
    if (field.value) values.set(field.dataset.keep!, field.value);
  }
  const active = document.activeElement;
  const keep =
    active instanceof HTMLTextAreaElement || active instanceof HTMLInputElement ? active.dataset.keep : undefined;
  return {
    values,
    active:
      keep && list.contains(active as Node)
        ? {
            keep,
            start: (active as HTMLTextAreaElement).selectionStart ?? 0,
            end: (active as HTMLTextAreaElement).selectionEnd ?? 0,
          }
        : null,
  };
}

function restorePanel(state: PanelState): void {
  for (const field of list.querySelectorAll<HTMLTextAreaElement | HTMLInputElement>("[data-keep]")) {
    const saved = state.values.get(field.dataset.keep!);
    if (saved !== undefined) field.value = saved;
  }
  if (state.active) {
    const field = list.querySelector<HTMLTextAreaElement>(`[data-keep="${CSS.escape(state.active.keep)}"]`);
    if (field) {
      field.focus();
      field.setSelectionRange(state.active.start, state.active.end);
    }
  }
  // The ring is restored by id, so the card the human was on keeps it even when
  // the list reordered underneath them.
  if (cursorId) {
    const card = list.querySelector<HTMLElement>(`.card[data-id="${CSS.escape(cursorId)}"]`);
    card?.classList.add("focused");
  }
}

// --- panel sections ---------------------------------------------------------

function renderFilters(review: Review | undefined): void {
  const items = review?.items ?? [];
  const counts: Array<[Filter, string, number]> = [
    ["all", "All", items.length],
    ["awaiting", "Needs you", items.filter((item) => item.awaitingHuman).length],
    ["open", "To decide", items.filter((item) => item.status === "answered").length],
    ["applied", "Applied", items.filter((item) => item.outcome === "applied").length],
    ["caveat", "Caveat", items.filter((item) => item.outcome === "caveat").length],
    ["needs-call", "Your call", items.filter((item) => item.outcome === "needs-call").length],
    ["skipped", "Not done", items.filter((item) => item.outcome === "skipped").length],
    ["settled", "Settled", items.filter((item) => item.status === "accepted" || item.status === "rejected").length],
  ];
  // A chip for an outcome nothing has is a control that does nothing; the
  // active one stays visible regardless so the filter can always be cleared.
  const shown = counts.filter(([name, , count]) => count > 0 || name === "all" || name === filter);
  filtersBar.hidden = shown.length <= 1;
  filtersBar.innerHTML = shown
    .map(
      ([name, label, count]) =>
        `<button class="chip${filter === name ? " active" : ""}" type="button" data-filter="${name}">${label}<b>${count}</b></button>`,
    )
    .join("");
}

function renderOutline(): void {
  const index = sectionIndex();
  const open = new Map<string, number>();
  const unaddressed = new Set<string>();
  for (const review of reviews) {
    for (const item of review.items) {
      const section = index.get(item.id);
      if (!section) continue;
      if (item.status === "accepted" || item.status === "rejected") continue;
      open.set(section, (open.get(section) ?? 0) + 1);
      if (item.status === "sent" || item.awaitingHuman) unaddressed.add(section);
    }
  }

  $("outlineCount").textContent = String(sections.length);
  outlineBox.innerHTML = sections.length
    ? sections
        .map((section, position) => {
          const count = open.get(section.id) ?? 0;
          return `<button class="section" type="button" data-section="${position}" style="padding-left:${4 + (section.level - 1) * 12}px">
            <span class="sec-text">${escapeHtml(section.text)}</span>
            ${count ? `<span class="sec-count">${count}</span>` : ""}
            ${unaddressed.has(section.id) ? `<span class="sec-dot" title="an item here is still with the agent"></span>` : ""}
          </button>`;
        })
        .join("")
    : `<p class="empty">No headings in this document.</p>`;
}

/**
 * Jump the document to a section from the navigator.
 *
 * The outline rendered buttons and nothing listened to them, so its whole
 * reason for existing — moving around a document too long to scroll by hand —
 * did nothing at all. It looked like it worked, because the entries highlight
 * on hover.
 */
outlineBox.addEventListener("click", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-section]");
  if (!button) return;
  const section = sections[Number(button.dataset.section)];
  if (!section) return;
  toFrame({ type: "pe:scrollTo", id: section.id, selector: `#${section.id}`, text: section.text });
});

function renderContract(): void {
  const active = contract.filter((rule) => !rule.retiredAt);
  const retired = contract.filter((rule) => rule.retiredAt);
  $("contractCount").textContent = String(active.length);
  contractList.innerHTML =
    (active.length
      ? active.map((rule) => renderRule(rule, false)).join("")
      : `<p class="empty">No standing rules yet. Reject something and promote the reason, or write one below.</p>`) +
    (retired.length
      ? `<details class="retired"><summary>${retired.length} retired</summary>${retired
          .map((rule) => renderRule(rule, true))
          .join("")}</details>`
      : "");
}

function renderRule(rule: ContractRule, retired: boolean): string {
  return `<div class="rule${retired ? " off" : ""}">
    <span class="rule-text">${escapeHtml(rule.text)}</span>
    <span class="rule-meta">${rule.fromItemId ? `<span class="from">from a rejection</span>` : ""}${time(rule.createdAt)}</span>
    <button class="link" type="button" data-${retired ? "restore-rule" : "retire-rule"}="${escapeHtml(rule.id)}">${retired ? "restore" : "retire"}</button>
  </div>`;
}

function renderLocks(): void {
  locksPanel.hidden = locks.length === 0;
  $("lockCount").textContent = String(locks.length);
  lockList.innerHTML = locks
    .map(
      (lock) => `<div class="lock">
        <span class="lock-text">${escapeHtml(lock.label || lock.text.slice(0, 70) || lock.selector)}</span>
        <button class="link" type="button" data-unlock="${escapeHtml(lock.id)}">unlock</button>
      </div>`,
    )
    .join("");
}

function renderChat(): void {
  chatLog.innerHTML = chat.length
    ? chat
        .map(
          (message) =>
            `<div class="msg ${message.role}"><b>${message.role === "agent" ? "Agent" : "You"}</b>
              <span>${escapeHtml(message.text)}</span>${time(message.at)}</div>`,
        )
        .join("")
    : `<p class="empty">Replies from your agent appear here — and anything you say back.</p>`;
}

function renderGestures(): void {
  suggestButton.classList.toggle("armed", gesture === "suggest");
  suggestButton.setAttribute("aria-pressed", String(gesture === "suggest"));
  const structuralKind = gesture !== null && gesture !== "suggest" ? gesture : "";
  structuralSelect.classList.toggle("armed", structuralKind !== "");
  structuralSelect.value = structuralKind;
}

function renderRepointBanner(): string {
  return `<div class="alert repoint">
    <b>Click the element this note belongs to</b>
    <span class="alt">The document is waiting for the new target. Esc cancels.</span>
    <button class="link" type="button" data-cancel-repoint>Cancel</button>
  </div>`;
}

/** Items still awaiting a verdict from the human. */
function openItems(): ReviewItem[] {
  return (answeredReview() ?? closedReview())?.items.filter((item) => item.status === "answered") ?? [];
}

/**
 * The ones that can be waved through without reading.
 *
 * Everything else the agent has explicitly put in front of you: a caveat to
 * read, a decision it refused to guess at, something it did not do. Sweeping
 * those up silently is the failure this whole panel exists to prevent.
 */
function straightforwardItems(): ReviewItem[] {
  return openItems().filter((item) => item.outcome === "applied" && !item.awaitingHuman);
}

function renderTriage(_appliedCount: number, revertable: boolean, reviewId: string | undefined): string {
  const open = openItems().length;
  if (!open && !revertable) return "";
  return `<div class="triage">
    ${open ? `<button class="accept-all" type="button" data-accept-all>Accept all <b>${open}</b></button>` : ""}
    ${revertable && reviewId ? `<button class="link revert-review" type="button" data-revert="${escapeHtml(reviewId)}">Revert this whole review</button>` : ""}
  </div>`;
}

// --- one card ---------------------------------------------------------------

function anchorLabel(item: ReviewItem): string {
  const anchors = item.anchors ?? [{ selector: item.selector, text: item.text }];
  if (item.tag === "page") return `<span class="chunk">whole page</span>`;
  if (anchors.length > 1) {
    return `<span class="chunk">${anchors.length} elements</span> ${escapeHtml(
      anchors.map((anchor) => anchor.text.slice(0, 24)).join(" · ").slice(0, 90),
    )}`;
  }
  const first = anchors[0];
  return `${item.tag === "text" ? "❝ " : ""}${escapeHtml(first?.text.slice(0, 90) || first?.selector || "whole page")}`;
}

function wordDiff(before: string, after: string): string {
  return diffWords(before, after)
    .map((op) =>
      op.type === "same"
        ? escapeHtml(op.text)
        : `<span class="${op.type === "add" ? "wadd" : "wdel"}">${escapeHtml(op.text)}</span>`,
    )
    .join("");
}

function renderSectionDiff(section: SectionChange): string {
  const head = `<div class="dhead"><span class="dkind ${section.kind}">${section.kind}</span> ${escapeHtml(section.label)}</div>`;
  if (section.kind !== "changed" || section.before === undefined || section.after === undefined) {
    return `<div class="dsection">${head}</div>`;
  }
  return `<div class="dsection">${head}<div class="dbody">${wordDiff(section.before, section.after)}</div></div>`;
}

/**
 * A verbatim item shows the words, not a sentence about the words.
 *
 * Rendered as a generic note it lost the only thing that made it worth a
 * separate gesture: the human typed the exact replacement, and a card reading
 * "Replace with the supplied text." hides it behind a paraphrase of itself.
 */
function renderVerbatim(item: ReviewItem): string {
  if (item.tag !== "verbatim" || item.replacement === undefined) return "";
  return `<div class="verbatim">
    <span class="tagline">exact replacement</span>
    <div class="dbody">${wordDiff(item.text, item.replacement)}</div>
  </div>`;
}

function renderStructural(item: ReviewItem): string {
  if (item.tag !== "structural" || !item.op) return "";
  const target = item.op.targetText ?? item.op.targetSelector ?? "";
  return `<div class="structural">
    <span class="op ${item.op.kind}">${OP_LABEL[item.op.kind]}</span>
    ${target ? `<span class="op-target">${escapeHtml(target.slice(0, 90))}</span>` : ""}
  </div>`;
}

/**
 * The agent offering versions to choose between, rather than picking one and
 * hoping. Hovering shows the option in the document itself — reading two
 * paragraphs side by side in a 340px panel is not how anyone decides which one
 * belongs in a page.
 */
function renderAlternatives(item: ReviewItem): string {
  if (!item.alternatives?.length) return "";
  return `<div class="alts" data-alts="${escapeHtml(item.id)}">
    <b>${item.chosenAlternative ? "You chose" : "Pick one — hover to see it in place"}</b>
    ${item.alternatives
      .map(
        (alt: Alternative) =>
          `<button class="alt${item.chosenAlternative === alt.id ? " chosen" : ""}" type="button"
             data-alt="${escapeHtml(item.id)}" data-alt-id="${escapeHtml(alt.id)}">${escapeHtml(alt.label)}</button>`,
      )
      .join("")}
  </div>`;
}

/**
 * A note whose anchor the SDK could not place, with the near-misses it ranked.
 *
 * The alternative is telling the human their note is lost and leaving them to
 * find the paragraph again by eye — in a document the agent has just rewritten.
 * One click is the entire difference.
 */
function renderWeakAnchor(item: ReviewItem): string {
  const candidates = weakCandidates.get(item.id);
  const score = anchorScores.get(item.id);
  if (candidates?.length) {
    return `<div class="alert weak">
      <b>Lost track of what this points at</b>
      <span class="alt">The closest matches in the document as it stands now:</span>
      ${candidates
        .map(
          (candidate, index) =>
            `<button class="candidate" type="button" data-candidate="${escapeHtml(item.id)}" data-candidate-index="${index}">
               <span class="cscore">${Math.round(candidate.score * 100)}%</span>${escapeHtml(candidate.text.slice(0, 90))}
             </button>`,
        )
        .join("")}
      <button class="link" type="button" data-repoint="${escapeHtml(item.id)}">Point at it myself…</button>
    </div>`;
  }
  if (candidates) {
    // Reported weak with nothing to offer. Saying so plainly beats a card that
    // looks tracked: a full reword scores like noise, and no threshold rescues it.
    return `<div class="alert weak">
      <b>Lost track of what this points at</b>
      <span class="alt">Nothing in the document resembles the original text closely enough to offer.</span>
      <button class="link" type="button" data-repoint="${escapeHtml(item.id)}">Point at it myself…</button>
    </div>`;
  }
  if (score !== undefined && score < SHAKY) {
    return `<div class="weak-badge">weak match · ${Math.round(score * 100)}%
      <button class="link" type="button" data-repoint="${escapeHtml(item.id)}">re-point</button>
    </div>`;
  }
  return "";
}

function renderThread(item: ReviewItem): string {
  if (!item.thread?.length) return "";
  return `<div class="thread">${item.thread
    .map(
      (message) =>
        `<div class="msg ${message.role}"><b>${message.role === "human" ? "You" : "Agent"}</b><span>${escapeHtml(message.text)}</span>${time(message.at)}</div>`,
    )
    .join("")}</div>`;
}

/**
 * The boxes that let the human say something back.
 *
 * `awaitingHuman` gets its own always-open box rather than a collapsed one: the
 * agent is parked on this exact item, so a control the human has to discover
 * first is a control that keeps it parked.
 */
function renderItemForms(item: ReviewItem): string {
  if (item.awaitingHuman) {
    return `<div class="answer">
      <textarea rows="2" data-keep="answer:${escapeHtml(item.id)}" placeholder="Answer the question — the agent is waiting on this…"></textarea>
      <button class="add" type="button" data-answer="${escapeHtml(item.id)}">Answer</button>
    </div>`;
  }
  if (item.status === "draft") return "";
  return `<details class="reply">
    <summary>Reply</summary>
    <textarea rows="2" data-keep="reply:${escapeHtml(item.id)}" placeholder="Anything the agent should know about this one…"></textarea>
    <button class="add" type="button" data-reply="${escapeHtml(item.id)}">Send reply</button>
  </details>`;
}

function renderItem(item: ReviewItem): string {
  const actions: string[] = [];
  if (item.status === "draft") actions.push(`<button class="link" type="button" data-drop="${escapeHtml(item.id)}">remove</button>`);
  if (item.status === "answered") {
    actions.push(`<button class="link accept" type="button" data-accept="${escapeHtml(item.id)}">Accept</button>`);
    actions.push(`<button class="link reject" type="button" data-reject="${escapeHtml(item.id)}">Reject…</button>`);
  }
  if (item.status === "accepted" || item.status === "rejected") {
    actions.push(`<button class="link" type="button" data-unverdict="${escapeHtml(item.id)}">undo verdict</button>`);
  }
  if (item.status === "rejected") {
    actions.push(`<button class="link" type="button" data-promote="${escapeHtml(item.id)}">make it a rule…</button>`);
  }
  if (item.status === "orphaned") actions.push(`<button class="link" type="button" data-repoint="${escapeHtml(item.id)}">Re-point…</button>`);
  if (item.tag !== "page") actions.push(`<button class="link" type="button" data-jump="${escapeHtml(item.id)}">Show</button>`);

  const outcome =
    item.outcome && item.status === "answered"
      ? `<span class="outcome ${item.outcome}">${OUTCOME_LABEL[item.outcome]}</span>`
      : "";

  // The summary says what the agent claims it did; this shows what it actually
  // did, right next to the note that asked for it.
  const changes = attribution?.byItem.get(item.id) ?? [];
  const diff = changes.length
    ? `<div class="item-diff">${changes.map(renderSectionDiff).join("")}</div>`
    : item.status === "answered" && item.outcome === "applied"
      ? `<div class="item-diff empty-diff">No text change detected for this note.</div>`
      : "";

  return `<article class="card" tabindex="0" data-status="${item.status}" data-outcome="${item.outcome ?? ""}" data-tag="${item.tag}"${
    item.awaitingHuman ? " data-awaiting" : ""
  } data-id="${escapeHtml(item.id)}">
    ${item.awaitingHuman ? `<div class="awaiting">The agent is waiting on your answer</div>` : ""}
    <div class="anchor">${anchorLabel(item)}</div>
    <div class="body">${escapeHtml(item.body)}</div>
    ${renderVerbatim(item)}
    ${renderStructural(item)}
    ${item.agentNote ? `<div class="note">${escapeHtml(item.agentNote)}</div>` : ""}
    ${diff}
    ${renderAlternatives(item)}
    ${renderWeakAnchor(item)}
    ${renderThread(item)}
    ${renderItemForms(item)}
    <div class="meta">${outcome}<span class="status">${ITEM_LABEL[item.status]}</span>${
      item.revertedAt ? `<span class="reverted">change undone</span>` : ""
    }${item.requeued ? `<span class="requeued">back in your draft</span>` : ""}${time(item.answeredAt ?? item.createdAt)}${actions.join("")}</div>
  </article>`;
}

// --- rejections that keep saying the same thing -----------------------------

const STOPWORDS = new Set([
  "about", "after", "again", "because", "before", "being", "between", "could", "should", "would", "there",
  "these", "thing", "think", "those", "which", "while", "with", "your", "that", "this", "have", "from",
  "into", "just", "like", "make", "more", "much", "over", "same", "than", "then", "they", "were", "what",
  "when", "where", "does",
]);

function contentWords(text: string): Set<string> {
  return new Set(
    text
      .toLowerCase()
      .split(/[^a-z0-9']+/)
      .filter((word) => word.length >= 4 && !STOPWORDS.has(word)),
  );
}

/**
 * Rejections whose reasons overlap.
 *
 * Three rejections that all say "too hedged" are not three problems, they are
 * one rule the agent has never been told. The signal is already in the store and
 * nothing looked at it — the human either notices the pattern themselves or
 * makes the same correction again next round.
 */
function rejectionGroups(): Array<{ text: string; ids: string[] }> {
  const groups: Array<{ words: Set<string>; text: string; ids: string[] }> = [];
  for (const review of reviews) {
    for (const item of review.items) {
      if (item.status !== "rejected") continue;
      const reason = [...(item.thread ?? [])].reverse().find((message) => message.role === "human")?.text;
      if (!reason) continue;
      const words = contentWords(reason);
      if (words.size === 0) continue;
      const hit = groups.find((group) => [...group.words].filter((word) => words.has(word)).length >= 2);
      if (hit) hit.ids.push(item.id);
      else groups.push({ words, text: reason, ids: [item.id] });
    }
  }
  return groups.filter((group) => group.ids.length >= 2).map(({ text, ids }) => ({ text, ids }));
}

function renderRejectionGroups(): string {
  const groups = rejectionGroups().filter((group) => !contract.some((rule) => !rule.retiredAt && rule.text === group.text));
  if (!groups.length) return "";
  return groups
    .map(
      (group, index) => `<div class="alert pattern">
        <b>${group.ids.length} rejections say much the same thing</b>
        <span class="alt">“${escapeHtml(group.text.slice(0, 140))}”</span>
        <button class="link" type="button" data-pattern="${index}">Make it a standing rule…</button>
      </div>`,
    )
    .join("");
}

// --- markup phase -----------------------------------------------------------

function setMode(next: boolean): void {
  modeToggle.checked = next;
  toFrame({ type: "pe:setMode", value: next });
  // The SDK clears its side and reports back, but the panel must not depend on
  // that round trip: if the frame is mid-reload the hint would go on offering
  // to pin a note to a selection the document has already dropped.
  if (!next) unarm();
}

/**
 * Lets go of the half-made note, in both documents.
 *
 * There was no way to do this at all — clicking an element armed it and the
 * only exit was to write a note you did not want and then delete it.
 */
function unarm(): void {
  if (!armed) return;
  toFrame({ type: "pe:cancel", clientId: armed.clientId });
  armed = null;
  render();
}

/**
 * Arms one of the two document gestures, disarming the other.
 *
 * They are mutually exclusive in the SDK's click handler — the precedence list
 * decides for you — so two lit buttons would be the toolbar claiming something
 * the artifact will not honour.
 */
function armGesture(next: "suggest" | StructuralKind | null): void {
  gesture = next;
  toFrame({ type: "pe:suggest", value: next === "suggest" });
  toFrame({ type: "pe:structural", kind: next && next !== "suggest" ? next : "" });
  renderGestures();
}

modeToggle.addEventListener("change", () => setMode(modeToggle.checked));
suggestButton.addEventListener("click", () => armGesture(gesture === "suggest" ? null : "suggest"));
structuralSelect.addEventListener("change", () => {
  armGesture((structuralSelect.value || null) as StructuralKind | null);
});

input.addEventListener("input", () => render());
search.addEventListener("input", () => {
  query = search.value.trim().toLowerCase();
  render();
});

// The find box searches the *document*, not the notes: ⌘F filters a list that
// stops being navigable long before the document does.
findBox.addEventListener("input", () => {
  clearTimeout(findTimer);
  findTimer = setTimeout(() => toFrame({ type: "pe:find", query: findBox.value }), 180) as unknown as number;
});

// The overall note is saved as you type, not on send: losing it to a stray
// reload would cost more than the round trip does.
overall.addEventListener("input", () => {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(() => {
    void api("/review/note", body({ note: overall.value }));
  }, 400) as unknown as number;
  render();
});

addNote.addEventListener("click", () => void commitNote());
sendButton.addEventListener("click", () => void sendReview());

interface OutgoingItem {
  body?: string;
  selector: string;
  text: string;
  anchors?: Array<{ selector: string; text: string }>;
  tag: ItemTag;
  replacement?: string;
  op?: StructuralOp;
}

async function submitItem(item: OutgoingItem): Promise<ReviewItem | null> {
  const result = await guard("Adding the note", () =>
    send<{ items: ReviewItem[] }>("/items", body({ items: [item] })),
  );
  return result?.items[0] ?? null;
}

/**
 * Adds the typed note to the draft review. Still nothing leaves the browser.
 *
 * The text and the armed target survive a failure. Clearing them before the
 * POST resolved meant a server that said no — a note over the length cap, a
 * dropped connection — silently ate what the human had just written, and the
 * only evidence was a toast about a note that was no longer anywhere.
 */
async function commitNote(): Promise<boolean> {
  const text = input.value.trim();
  if (!text) return true;
  const pinned = armed;
  const item: OutgoingItem = pinned
    ? {
        body: text,
        selector: pinned.anchors[0]?.selector ?? "",
        text: pinned.anchors[0]?.text ?? "",
        anchors: pinned.anchors,
        tag: pinned.kind,
      }
    : { body: text, selector: "", text: "", tag: "page" };

  const created = await submitItem(item);
  if (!created) {
    render();
    return false;
  }
  if (pinned) toFrame({ type: "pe:bind", clientId: pinned.clientId, id: created.id });
  if (armed === pinned) armed = null;
  input.value = "";
  render();
  return true;
}

async function sendReview(): Promise<void> {
  if (!(await commitNote())) return;
  sendButton.disabled = true;
  const done = await guard("Sending the review", () => send("/review/send", body({})));
  if (done) {
    overall.value = "";
    toast("Review sent — the agent has the whole set");
  }
  render();
}

// --- standing contract, locks -----------------------------------------------

$("addRule").addEventListener("click", () => void addRule(ruleInput.value));

async function addRule(text: string): Promise<void> {
  if (!text.trim()) return;
  const done = await guard("Adding the rule", () => send("/contract", body({ text })));
  if (!done) return;
  ruleInput.value = "";
  toast("Rule added — it rides along with every review from now on");
}

$("clearTarget").addEventListener("click", () => unarm());

$("lockTarget").addEventListener("click", () => {
  const anchor = armed?.anchors[0];
  if (!anchor) return toast("Click an element first, then lock it", "error");
  openSheet(
    "Lock this region",
    `<div class="form">
       <p class="drawer-hint">The agent is told not to touch it. Locks constrain the agent, not you — you can still annotate a locked region.</p>
       <code>${escapeHtml(anchor.text.slice(0, 200) || anchor.selector)}</code>
       <input class="search" id="lockLabel" type="text" placeholder="What is it? e.g. the launch date (optional)">
       <div class="form-actions"><button class="ghost" type="button" data-close>Cancel</button><button type="button" data-confirm-lock>Lock it</button></div>
     </div>`,
  );
  overlay.querySelector("[data-confirm-lock]")?.addEventListener("click", () => {
    const label = $<HTMLInputElement>("lockLabel").value.trim();
    closeOverlay();
    void guard("Locking", async () => {
      await send("/locks", body({ selector: anchor.selector, text: anchor.text, ...(label ? { label } : {}) }));
      toast("Locked");
    });
  });
});

// --- card actions -----------------------------------------------------------

// The chips live in the panel head, above the list, so they need their own
// listener — hanging them off the list's delegate meant every chip was inert.
filtersBar.addEventListener("click", (event) => {
  const chip = (event.target as HTMLElement).closest("[data-filter]")?.getAttribute("data-filter");
  if (!chip) return;
  filter = chip as Filter;
  render();
});

list.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = (name: string) => target.closest(`[data-${name}]`)?.getAttribute(`data-${name}`);

  const drop = action("drop");
  if (drop) {
    void guard("Removing the note", () => send(`/items/${drop}`, { method: "DELETE" }));
    return;
  }

  if (target.closest("[data-cancel-repoint]")) {
    repointing = null;
    toFrame({ type: "pe:repoint", id: null });
    return render();
  }

  const jump = action("jump");
  if (jump) {
    const item = allItems().find((entry) => entry.id === jump);
    if (item) toFrame({ type: "pe:scrollTo", id: jump, selector: item.selector, text: item.text });
    return;
  }

  const accept = action("accept");
  if (accept) return void acceptItem(accept);

  const reject = action("reject");
  if (reject) return openRejectSheet(reject);

  const unverdict = action("unverdict");
  if (unverdict) {
    void guard("Undoing the verdict", async () => {
      await send(`/items/${unverdict}/unverdict`, body({}));
      toast("Verdict cleared");
    });
    return;
  }

  const promote = action("promote");
  if (promote) return openPromoteSheet(promote);

  const pattern = action("pattern");
  if (pattern !== null && pattern !== undefined) {
    const group = rejectionGroups()[Number(pattern)];
    if (group) openRuleSheet(group.text);
    return;
  }

  if (target.closest("[data-accept-all]")) return void acceptAll();

  const revert = action("revert");
  if (revert) return openRevertSheet(revert);

  const repoint = action("repoint");
  if (repoint) {
    repointing = repoint;
    setMode(true);
    toFrame({ type: "pe:repoint", id: repoint });
    return render();
  }

  const candidate = action("candidate");
  if (candidate) {
    const index = Number(target.closest("[data-candidate-index]")?.getAttribute("data-candidate-index") ?? -1);
    const choice = weakCandidates.get(candidate)?.[index];
    if (!choice) return;
    void guard("Re-pointing", async () => {
      await send(`/items/${candidate}/repoint`, body({ selector: choice.selector, text: choice.text }));
      weakCandidates.delete(candidate);
      anchorScores.delete(candidate);
      trackedIds.delete(candidate);
      syncTracking();
      toast("Re-pointed");
    });
    return;
  }

  const answer = action("answer");
  if (answer) {
    const field = list.querySelector<HTMLTextAreaElement>(`[data-keep="answer:${CSS.escape(answer)}"]`);
    const text = field?.value.trim();
    if (!text) return toast("Type an answer first", "error");
    void guard("Answering", async () => {
      await send(`/items/${answer}/answer-question`, body({ text }));
      // Cleared only once the server has it, for the same reason the note
      // composer keeps its text on failure.
      if (field) field.value = "";
      toast("Answered — the agent is unparked");
    });
    return;
  }

  const reply = action("reply");
  if (reply) {
    const field = list.querySelector<HTMLTextAreaElement>(`[data-keep="reply:${CSS.escape(reply)}"]`);
    const text = field?.value.trim();
    if (!text) return toast("Type a reply first", "error");
    void guard("Replying", async () => {
      await send(`/items/${reply}/reply`, body({ text }));
      if (field) field.value = "";
      toast("Sent to the agent with your next review");
    });
    return;
  }

  const alt = action("alt");
  if (alt) {
    const altId = target.closest("[data-alt-id]")?.getAttribute("data-alt-id");
    if (!altId) return;
    void guard("Choosing", async () => {
      await send(`/items/${alt}/choose`, body({ alternative: altId }));
      restoreLive();
      toast("Choice sent");
    });
    return;
  }

  const section = action("section");
  if (section !== null && section !== undefined) {
    const entry = sections[Number(section)];
    if (!entry) return;
    // An id resolves exactly; a heading with no id'd ancestor has only its text,
    // and passing both would have the SDK score the section's whole body against
    // one heading and land somewhere else entirely.
    toFrame({
      type: "pe:scrollTo",
      id: "",
      selector: entry.id ? `#${CSS.escape(entry.id)}` : "",
      text: entry.id ? "" : entry.text,
    });
    return;
  }
});

// Contract and lock controls live outside the list, in their own drawers.
document.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const value = (name: string) => target.closest(`[data-${name}]`)?.getAttribute(`data-${name}`);

  const retire = value("retire-rule");
  if (retire) {
    void guard("Retiring the rule", () => send(`/contract/${retire}`, { method: "DELETE" }));
    return;
  }
  const restore = value("restore-rule");
  if (restore) {
    void guard("Restoring the rule", () => send(`/contract/${restore}/restore`, body({})));
    return;
  }
  const unlock = value("unlock");
  if (unlock) {
    void guard("Unlocking", () => send(`/locks/${unlock}`, { method: "DELETE" }));
  }
});

$("sendChat").addEventListener("click", () => void sendChat());

async function sendChat(): Promise<void> {
  const text = chatInput.value.trim();
  if (!text) return;
  const done = await guard("Sending", () => send("/chat", body({ text })));
  // Kept on failure, like every other composer here.
  if (done) chatInput.value = "";
}

function allItems(): ReviewItem[] {
  return reviews.flatMap((review) => review.items);
}

function findItem(id: string): { item: ReviewItem; review: Review } | null {
  for (const review of reviews) {
    const item = review.items.find((entry) => entry.id === id);
    if (item) return { item, review };
  }
  return null;
}

// --- verdicts ---------------------------------------------------------------

async function acceptItem(id: string): Promise<void> {
  await guard("Accepting", () => send(`/items/${id}/accept`, body({})));
}

async function acceptItems(targets: ReviewItem[], what: string): Promise<void> {
  if (!targets.length) return;
  const done = await guard("Accepting", async () => {
    // Sequential rather than parallel: every one of these mutates the same
    // session document, and the store serializes them anyway.
    for (const item of targets) await send(`/items/${item.id}/accept`, body({}));
    return true;
  });
  if (done) {
    toast(`Accepted ${targets.length} ${what}${targets.length === 1 ? "" : "s"} — press u on a note to take one back`);
  }
}

/** How the agent described an item, for the confirmation list. */
function outcomeWord(item: ReviewItem): string {
  if (item.awaitingHuman) return "waiting on your answer";
  if (item.outcome === "caveat") return "applied with a caveat";
  if (item.outcome === "needs-call") return "needs your call";
  if (item.outcome === "skipped") return "not done";
  return "applied";
}

/**
 * Accept everything, but never quietly.
 *
 * A single button that swept up `needs-call` and `skipped` items alongside the
 * straightforward ones would settle the exact items the agent deliberately put
 * in front of a human — the ones it refused to guess at, and the ones it chose
 * not to do. So when the open set is all plain applies this just runs; when it
 * is not, it says what it is about to include and offers the narrower option
 * first.
 */
async function acceptAll(): Promise<void> {
  const open = openItems();
  const straightforward = straightforwardItems();
  const flagged = open.filter((item) => !straightforward.includes(item));

  if (!open.length) return;
  if (!flagged.length) return acceptItems(straightforward, "change");

  openSheet(
    "Accept all",
    `<div class="form">
       <p class="drawer-hint">${flagged.length} of these ${flagged.length === 1 ? "is" : "are"} flagged for you rather than simply applied:</p>
       <div class="flagged">
         ${flagged
           .map(
             (item) => `<div class="flagged-row">
               <span class="dkind ${escapeHtml(item.outcome ?? "applied")}">${escapeHtml(outcomeWord(item))}</span>
               <span class="flagged-body">${escapeHtml(item.body.slice(0, 90))}</span>
             </div>`,
           )
           .join("")}
       </div>
       <div class="form-actions">
         <button class="ghost" type="button" data-close>Cancel</button>
         ${straightforward.length ? `<button class="ghost" type="button" data-accept-safe>Accept only the ${straightforward.length} applied</button>` : ""}
         <button type="button" data-accept-every>Accept all ${open.length}</button>
       </div>
     </div>`,
  );

  overlay.querySelector("[data-accept-safe]")?.addEventListener("click", () => {
    closeOverlay();
    void acceptItems(straightforward, "change");
  });
  overlay.querySelector("[data-accept-every]")?.addEventListener("click", () => {
    closeOverlay();
    void acceptItems(open, "item");
  });
}

/**
 * Rejecting, with the option to put the text back.
 *
 * Rejection used to record a verdict and requeue, which left the agent's
 * unwanted paragraph sitting in the document until it got round to the next
 * review — the human said no and the page did not change.
 */
function openRejectSheet(id: string): void {
  const found = findItem(id);
  const revertable = Boolean(found?.review.baseVersion);
  openSheet(
    "Reject this change",
    `<div class="form">
       <p class="drawer-hint">This goes back to the agent in your next review, so say what is wrong with it.</p>
       <textarea id="rejectReason" rows="3" placeholder="e.g. this is more hedged than what it replaced"></textarea>
       <label class="check"><input type="checkbox" id="rejectRevert"${revertable ? "" : " disabled"}>
         <span>…and undo that change${revertable ? "" : " — unavailable, this review has no recorded starting point"}</span>
       </label>
       <div class="form-actions"><button class="ghost" type="button" data-close>Cancel</button><button type="button" data-confirm-reject>Reject</button></div>
     </div>`,
  );
  const confirm = overlay.querySelector("[data-confirm-reject]");
  confirm?.addEventListener("click", () => {
    const reason = $<HTMLTextAreaElement>("rejectReason").value.trim();
    const alsoRevert = $<HTMLInputElement>("rejectRevert").checked;
    if (!reason) return toast("Say what is wrong with it — the agent gets this back", "error");
    closeOverlay();
    void rejectItem(id, reason, alsoRevert);
  });
}

async function rejectItem(id: string, reason: string, alsoRevert: boolean): Promise<void> {
  // The whole document is computed before anything is written, so a revert that
  // cannot be worked out never becomes a half-applied one. `buildRevert` says
  // out loud why it refused; the verdict itself still goes through, because the
  // human's "no" is the part they cannot easily repeat.
  const document_ = alsoRevert ? await buildRevert(id) : null;

  const done = await guard("Rejecting", async () => {
    await send(`/items/${id}/reject`, body({ text: reason }));
    return true;
  });
  if (!done) return;

  if (document_) {
    const written = await guard("Undoing the change", async () => {
      await send("/write", body({ html: document_, itemId: id }));
      return true;
    });
    toast(written ? "Rejected, and the original is back in the document" : "Rejected — the document was left as it is");
  } else {
    toast(alsoRevert ? "Rejected — the document was left as it is" : "Added back to your next review");
  }
  offerPromotion(id, reason);
}

/**
 * The document with one section put back to how it was when the review was sent.
 *
 * Refuses rather than approximates. The item has to be locatable in *both*
 * documents — if the anchor cannot be found in the base snapshot there is
 * nothing to put back, and if it cannot be found in the current one there is
 * nowhere to put it — and the snapshot has to still exist, since history is
 * capped and an old review's starting point ages out.
 */
async function buildRevert(id: string): Promise<string | null> {
  const found = findItem(id);
  if (!found?.review.baseVersion) {
    toast("This review has no recorded starting point, so there is nothing to undo", "error");
    return null;
  }
  const before = await fetchVersion(found.review.baseVersion);
  if (!before) {
    toast("The version this review started from has aged out of history — nothing was undone", "error");
    return null;
  }
  const original = locateAnchor(new DOMParser().parseFromString(before, "text/html"), found.item);
  if (!original) {
    toast("Could not find this note's target in the original document — nothing was undone", "error");
    return null;
  }
  const spliced = spliceSection(found.item, original.outerHTML);
  if (!spliced) {
    toast("Could not find this note's target in the document as it stands — nothing was undone", "error");
    return null;
  }
  return spliced;
}

/** Offered after the fact, with the reason pre-filled: the reason is what
 *  generalises, and it has just been typed. */
function offerPromotion(id: string, reason: string): void {
  openSheet(
    "Make this a standing rule?",
    `<div class="form">
       <p class="drawer-hint">A standing rule is sent ahead of every future review, so the same correction does not have to be made in round four that was made in round one.</p>
       <textarea id="promoteText" rows="3">${escapeHtml(reason)}</textarea>
       <div class="form-actions"><button class="ghost" type="button" data-close>Not now</button><button type="button" data-confirm-promote="${escapeHtml(id)}">Make it a rule</button></div>
     </div>`,
  );
  wirePromote();
}

function openPromoteSheet(id: string): void {
  const found = findItem(id);
  const reason = [...(found?.item.thread ?? [])].reverse().find((message) => message.role === "human")?.text ?? "";
  offerPromotion(id, reason);
}

function wirePromote(): void {
  overlay.querySelector("[data-confirm-promote]")?.addEventListener("click", (event) => {
    const id = (event.currentTarget as HTMLElement).getAttribute("data-confirm-promote")!;
    const text = $<HTMLTextAreaElement>("promoteText").value.trim();
    if (!text) return toast("A rule needs some words", "error");
    closeOverlay();
    void guard("Promoting", async () => {
      await send(`/items/${id}/promote`, body({ text }));
      toast("Added to the standing contract");
    });
  });
}

/** The same sheet, for a rule with no single item behind it. */
function openRuleSheet(prefill: string): void {
  openSheet(
    "New standing rule",
    `<div class="form">
       <textarea id="promoteText" rows="3">${escapeHtml(prefill)}</textarea>
       <div class="form-actions"><button class="ghost" type="button" data-close>Cancel</button><button type="button" data-confirm-rule>Add rule</button></div>
     </div>`,
  );
  overlay.querySelector("[data-confirm-rule]")?.addEventListener("click", () => {
    const text = $<HTMLTextAreaElement>("promoteText").value.trim();
    closeOverlay();
    void addRule(text);
  });
}

function openRevertSheet(reviewId: string): void {
  openSheet(
    "Revert the whole review",
    `<div class="form">
       <p class="drawer-hint">Puts the document back to how it looked before you sent this review. It goes through the same watcher as any other change, so it morphs in place — and it is itself undoable.</p>
       <div class="form-actions"><button class="ghost" type="button" data-close>Cancel</button><button type="button" data-confirm-revert>Revert it</button></div>
     </div>`,
  );
  overlay.querySelector("[data-confirm-revert]")?.addEventListener("click", () => {
    closeOverlay();
    void guard("Reverting", async () => {
      await send(`/review/${reviewId}/revert`, body({}));
      attributedReviewId = null;
      toast("Reverted to before the review");
    });
  });
}

// --- previewing an alternative in the document ------------------------------

let altPreview: string | null = null;
let altTimer: number | undefined;

list.addEventListener("mouseover", (event) => {
  const button = (event.target as HTMLElement).closest<HTMLElement>("[data-alt-id]");
  if (!button) return;
  const itemId = button.getAttribute("data-alt")!;
  const altId = button.getAttribute("data-alt-id")!;
  clearTimeout(altTimer);
  altTimer = setTimeout(() => void previewAlternative(itemId, altId), 140) as unknown as number;
});

list.addEventListener("mouseout", (event) => {
  const from = (event.target as HTMLElement).closest(".alts");
  if (!from) return;
  const to = event.relatedTarget as Node | null;
  if (to && from.contains(to)) return;
  clearTimeout(altTimer);
  restoreLive();
});

async function previewAlternative(itemId: string, altId: string): Promise<void> {
  const found = findItem(itemId);
  const alt = found?.item.alternatives?.find((entry) => entry.id === altId);
  if (!found || !alt) return;
  const html = spliceSection(found.item, alt.html);
  if (!html) {
    toast("Could not place that option in the document to preview it", "error");
    return;
  }
  altPreview = itemId;
  toFrame({ type: "pe:preview", html });
}

/**
 * Puts the live document back on screen.
 *
 * Nothing may leave a preview up: it shows a version of the artifact the file
 * does not contain, and the next thing the human does — annotate, accept, send —
 * would be against text that is not there.
 */
function restoreLive(): void {
  if (previewing === null && altPreview === null) return;
  previewing = null;
  altPreview = null;
  void applyPatch();
}

// --- toolbar ----------------------------------------------------------------

undoButton.addEventListener("click", async () => {
  undoButton.disabled = true;
  const done = await guard("Undo", () => send("/restore", body({})));
  if (done) toast("Restored the previous version");
});

// --- theme ------------------------------------------------------------------

type Theme = "system" | "light" | "dark";
const THEME_ICON: Record<Theme, string> = { system: "◐", light: "☀", dark: "☾" };
const THEME_LABEL: Record<Theme, string> = {
  system: "Theme: following your system",
  light: "Theme: light",
  dark: "Theme: dark",
};

// --- resizing the entry area ------------------------------------------------
//
// The note field always had the browser's native corner grip, but it is a few
// pixels wide, resizes only itself, and forgets on reload — so writing anything
// longer than a sentence meant finding an invisible target every single time.
// The grip above the composer sizes the whole section and remembers.

const GRIP_KEY = "pe-composer-h";
/** Below this the field and the buttons stop coexisting. */
const MIN_COMPOSER = 132;
/** The notes list is the point of the panel, so it always keeps this much. */
const LIST_FLOOR = 132;

/**
 * The tallest the entry area may get.
 *
 * Measured against what is actually above it rather than a guess, so a panel
 * with four drawers open does not let the composer swallow the list.
 */
function maxComposer(): number {
  const panel = $("panel").getBoundingClientRect().height;
  const composer = $("composer").getBoundingClientRect().height;
  const listHeight = list.getBoundingClientRect().height;
  const others = panel - composer - listHeight;
  return Math.max(MIN_COMPOSER, panel - others - LIST_FLOOR);
}

function applyComposerHeight(height: number | null): void {
  const panel = $("panel");
  if (height === null) {
    panel.style.removeProperty("--composer-h");
    try {
      localStorage.removeItem(GRIP_KEY);
    } catch {
      // Private browsing; it just will not persist.
    }
    return;
  }
  const clamped = Math.round(Math.min(maxComposer(), Math.max(MIN_COMPOSER, height)));
  panel.style.setProperty("--composer-h", `${clamped}px`);
  try {
    localStorage.setItem(GRIP_KEY, String(clamped));
  } catch {
    // Ignored, as above.
  }
}

function restoreComposerHeight(): void {
  try {
    const stored = Number(localStorage.getItem(GRIP_KEY));
    if (Number.isFinite(stored) && stored > 0) applyComposerHeight(stored);
  } catch {
    // Ignored.
  }
}

{
  const grip = $("composerGrip");
  let startY = 0;
  let startHeight = 0;

  grip.addEventListener("pointerdown", (event) => {
    const pointer = event as PointerEvent;
    startY = pointer.clientY;
    startHeight = $("composer").getBoundingClientRect().height;
    grip.setPointerCapture(pointer.pointerId);
    document.body.classList.add("pe-resizing");
    event.preventDefault();
  });

  grip.addEventListener("pointermove", (event) => {
    if (!grip.hasPointerCapture((event as PointerEvent).pointerId)) return;
    // Dragging the grip upward makes the entry area taller, which is why the
    // delta is inverted.
    applyComposerHeight(startHeight + (startY - (event as PointerEvent).clientY));
  });

  const end = (event: Event) => {
    const pointer = event as PointerEvent;
    if (grip.hasPointerCapture(pointer.pointerId)) grip.releasePointerCapture(pointer.pointerId);
    document.body.classList.remove("pe-resizing");
  };
  grip.addEventListener("pointerup", end);
  grip.addEventListener("pointercancel", end);

  // Back to sizing itself from its content.
  grip.addEventListener("dblclick", () => {
    applyComposerHeight(null);
    toast("Note area reset");
  });

  grip.addEventListener("keydown", (event) => {
    const step = event.shiftKey ? 64 : 24;
    if (event.key === "ArrowUp" || event.key === "ArrowDown") {
      event.preventDefault();
      const current = $("composer").getBoundingClientRect().height;
      applyComposerHeight(current + (event.key === "ArrowUp" ? step : -step));
    }
    if (event.key === "Escape" || event.key === "Home") {
      event.preventDefault();
      applyComposerHeight(null);
    }
  });

  restoreComposerHeight();
}

function readTheme(): Theme {
  try {
    const stored = localStorage.getItem("pe-theme");
    return stored === "light" || stored === "dark" ? stored : "system";
  } catch {
    return "system";
  }
}

/**
 * Applies the theme to the chrome and forwards it to the artifact.
 *
 * The artifact is a separate document with its own stylesheet, so it cannot see
 * this choice — the SDK sets a matching attribute inside the frame, and the
 * design guidance asks artifact authors to honour `:root[data-theme]` alongside
 * the media query.
 */
function applyTheme(theme: Theme): void {
  if (theme === "system") delete document.documentElement.dataset.theme;
  else document.documentElement.dataset.theme = theme;
  try {
    if (theme === "system") localStorage.removeItem("pe-theme");
    else localStorage.setItem("pe-theme", theme);
  } catch {
    // Private browsing; the choice just will not persist.
  }
  const button = $<HTMLButtonElement>("theme");
  button.textContent = THEME_ICON[theme];
  button.title = `${THEME_LABEL[theme]} — click to change`;
  toFrame({ type: "pe:theme", value: theme });
}

let theme = readTheme();
applyTheme(theme);

$("theme").addEventListener("click", () => {
  const order: Theme[] = ["system", "light", "dark"];
  theme = order[(order.indexOf(theme) + 1) % order.length]!;
  applyTheme(theme);
  toast(THEME_LABEL[theme]);
});

// The system option has to keep tracking the OS after the page has loaded.
window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
  if (theme === "system") applyTheme("system");
});

$("collapse").addEventListener("click", () => layout.classList.toggle("collapsed"));
$("history").addEventListener("click", () => void openHistory());
$("record").addEventListener("click", () => void openRecord());
$("help").addEventListener("click", openHelp);
$("switcher").addEventListener("click", () => void openSwitcher());

// --- keyboard ---------------------------------------------------------------

function isTyping(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement;
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT";
}

/**
 * A keystroke, from either document.
 *
 * Keys pressed inside the artifact are relayed by the SDK as `pe:key`, because
 * the two documents cannot see each other's events. They arrive as a plain
 * object with no `preventDefault` — the SDK already called it on its side — so
 * the handler takes this shape rather than a KeyboardEvent.
 */
interface Keystroke {
  key: string;
  meta: boolean;
  shift: boolean;
  typing: boolean;
  preventDefault: () => void;
  isTab?: KeyboardEvent;
}

function fromFrame(key: string, meta: boolean, shift: boolean): Keystroke {
  return { key, meta, shift, typing: false, preventDefault: () => {} };
}

document.addEventListener(
  "keydown",
  (event) => {
    handleKey({
      key: event.key,
      meta: event.metaKey || event.ctrlKey,
      shift: event.shiftKey,
      typing: isTyping(event),
      preventDefault: () => event.preventDefault(),
      isTab: event,
    });
  },
  true,
);

function handleKey(event: Keystroke): void {
  const meta = event.meta;
  if (meta && event.key.toLowerCase() === "i") {
    event.preventDefault();
    return setMode(!modeToggle.checked);
  }
  if (meta && event.key.toLowerCase() === "e") {
    event.preventDefault();
    return armGesture(gesture === "suggest" ? null : "suggest");
  }
  if (meta && event.key === "Enter") {
    event.preventDefault();
    return void (event.shift ? sendReview() : commitNote());
  }
  if (meta && event.key.toLowerCase() === "f") {
    event.preventDefault();
    return search.focus();
  }
  if (meta && event.key.toLowerCase() === "z") {
    event.preventDefault();
    return undoButton.click();
  }
  if (meta && event.key.toLowerCase() === "h") {
    event.preventDefault();
    return void openHistory();
  }
  if (meta && event.key === "\\") {
    event.preventDefault();
    layout.classList.toggle("collapsed");
    return;
  }
  if (event.key === "Escape") {
    if (!overlay.hidden) return closeOverlay();
    if (gesture) return armGesture(null);
    if (repointing) {
      repointing = null;
      toFrame({ type: "pe:repoint", id: null });
      return render();
    }
    // Last, because the overlays and gestures are more urgent to escape from —
    // but before giving up, so Escape always means "take that back".
    if (armed) return unarm();
    return;
  }
  // A dialog owns the keyboard while it is open, including Tab.
  // Tab only ever arrives from the chrome's own document; a relayed key
  // has no event to trap.
  if (!overlay.hidden && event.key === "Tab" && event.isTab) return trapTab(event.isTab);

  if (event.typing || !overlay.hidden) {
    // Scrubbing belongs to the history sheet alone. Ungated, an arrow key
    // pressed over the shortcut list morphed the artifact to another version
    // behind a dialog that says nothing about versions.
    const scrubbing = !overlay.hidden && Boolean(overlay.querySelector(".versions"));
    if (scrubbing && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      void stepVersion(event.key === "ArrowRight" ? 1 : -1);
    }
    return;
  }

  // j/k through the notes, Enter to jump the document to the focused one.
  if (event.key === "j" || event.key === "k") {
    event.preventDefault();
    return moveCursor(event.key === "j" ? 1 : -1);
  }
  if (event.key === "Enter" && cursorId) {
    event.preventDefault();
    return focusedCard()?.querySelector<HTMLButtonElement>("[data-jump]")?.click();
  }
  // Verdicts from the keyboard. Triage is the one part of this tool that is a
  // list of yes/no decisions, and doing it a mouse-click at a time is why
  // reviews were being accepted wholesale instead of read.
  if (event.key === "a" || event.key === "r" || event.key === "u") {
    const card = focusedCard();
    const id = card?.dataset.id;
    if (!id) return;
    event.preventDefault();
    if (event.key === "a") return void acceptItem(id);
    if (event.key === "r") return openRejectSheet(id);
    return void guard("Undoing the verdict", () => send(`/items/${id}/unverdict`, body({})));
  }
  if (event.key === "/") {
    event.preventDefault();
    navigator_.open = true;
    return findBox.focus();
  }
  if (event.key === "?") {
    event.preventDefault();
    return openHelp();
  }
}

function cards(): HTMLElement[] {
  return [...list.querySelectorAll<HTMLElement>(".card")];
}

function focusedCard(): HTMLElement | undefined {
  return cards().find((card) => card.dataset.id === cursorId);
}

function moveCursor(delta: number): void {
  const all = cards();
  if (all.length === 0) return;
  const at = all.findIndex((card) => card.dataset.id === cursorId);
  const next = all[Math.max(0, Math.min(all.length - 1, (at < 0 ? -1 : at) + delta))];
  if (!next) return;
  cursorId = next.dataset.id ?? null;
  for (const card of all) card.classList.toggle("focused", card === next);
  next.scrollIntoView({ block: "nearest" });
  // The card takes real focus so a screen reader follows too, and so the
  // verdict keys have an unambiguous subject.
  next.focus({ preventScroll: true });
  // Moving through notes should move the document too — reading a review means
  // looking at the thing being reviewed, not the list.
  const item = allItems().find((entry) => entry.id === cursorId);
  if (item && item.tag !== "page") {
    toFrame({ type: "pe:scrollTo", id: item.id, selector: item.selector, text: item.text });
  }
}

// Clicking a card is the same statement as pressing j onto it.
list.addEventListener("focusin", (event) => {
  const card = (event.target as HTMLElement).closest<HTMLElement>(".card");
  if (!card?.dataset.id) return;
  cursorId = card.dataset.id;
  for (const other of cards()) other.classList.toggle("focused", other === card);
});

// --- overlays ---------------------------------------------------------------

/** Where focus was before the dialog opened, so it can be put back. */
let focusBeforeSheet: HTMLElement | null = null;

const FOCUSABLE = 'button, [href], input, select, textarea, [tabindex]:not([tabindex="-1"])';

function sheetFocusables(): HTMLElement[] {
  return [...overlay.querySelectorAll<HTMLElement>(FOCUSABLE)].filter((el) => !el.hasAttribute("disabled"));
}

/**
 * Keeps Tab inside the dialog.
 *
 * Without it Tab walks straight out into the panel behind the scrim, which is
 * inert to the mouse and not to the keyboard — so the focus ring vanishes into
 * a form the human cannot see and Enter submits something they are not looking
 * at.
 */
function trapTab(event: KeyboardEvent): void {
  const focusable = sheetFocusables();
  if (focusable.length === 0) return;
  const first = focusable[0]!;
  const last = focusable[focusable.length - 1]!;
  const active = document.activeElement;
  if (event.shiftKey && (active === first || !overlay.contains(active))) {
    event.preventDefault();
    last.focus();
  } else if (!event.shiftKey && active === last) {
    event.preventDefault();
    first.focus();
  }
}

function closeOverlay(): void {
  overlay.hidden = true;
  overlay.innerHTML = "";
  restoreLive();
  focusBeforeSheet?.focus();
  focusBeforeSheet = null;
}

overlay.addEventListener("click", (event) => {
  if (event.target === overlay) closeOverlay();
});

function openSheet(title: string, inner: string): void {
  focusBeforeSheet = document.activeElement instanceof HTMLElement ? document.activeElement : null;
  overlay.hidden = false;
  overlay.setAttribute("aria-label", title);
  overlay.innerHTML = `<div class="sheet">
    <header><h2>${escapeHtml(title)}</h2><button class="link" type="button" data-close>Close</button></header>
    ${inner}
  </div>`;
  for (const close of overlay.querySelectorAll("[data-close]")) close.addEventListener("click", closeOverlay);
  // Focus lands inside the dialog rather than staying on the button that opened
  // it, which is what makes Escape and Tab mean what they look like they mean.
  (overlay.querySelector<HTMLElement>("textarea, input") ?? sheetFocusables()[0])?.focus();
}

function openHelp(): void {
  const rows: Array<[string, string]> = [
    ["⌘I", "Toggle annotate mode"],
    ["⌘E", "Suggest mode — type the exact replacement"],
    ["Click", "Anchor an edit to an element"],
    ["Select text, then click", "Anchor to the selection instead"],
    ["⇧-click", "Add another element to the same edit (again to remove)"],
    ["⌘Enter", "Add the note you are typing"],
    ["⇧⌘Enter", "Send the review"],
    ["⌘F", "Filter notes"],
    ["/", "Find in the document"],
    ["⌘Z", "Undo the last change"],
    ["⌘H", "Version history"],
    ["← →", "Scrub versions while history is open"],
    ["⌘\\", "Hide or show the panel"],
    ["j / k", "Move through your notes (the document follows)"],
    ["Enter", "Jump the document to the focused note"],
    ["a / r", "Accept or reject the focused note"],
    ["u", "Undo a verdict on the focused note"],
    ["Theme button", "Cycle system → light → dark"],
    ["Click it again", "Un-select an element you did not mean to pick"],
    ["Esc", "Close an overlay, disarm a gesture, cancel re-pointing, or clear the selection"],
    ["?", "This list"],
  ];
  openSheet(
    "Shortcuts",
    `<div class="shortcuts">${rows
      .map(([keys, what]) => `<div><kbd>${escapeHtml(keys)}</kbd><span>${escapeHtml(what)}</span></div>`)
      .join("")}</div>`,
  );
}

async function openSwitcher(): Promise<void> {
  const data = await guard("Loading artifacts", async () => {
    const response = await fetch(`/api/sessions?t=${encodeURIComponent(token)}`);
    if (!response.ok) throw new Error(`server said ${response.status}`);
    return (await response.json()) as {
      sessions: Array<{ key: string; name: string; file: string; url: string; open: number; addressed: number }>;
    };
  });
  if (!data) return;

  openSheet(
    "Open artifacts",
    `<div class="sessions">${data.sessions
      .map(
        (entry) => `<a class="session ${entry.key === key ? "current" : ""}" href="${escapeHtml(entry.url)}">
          <span class="name">${escapeHtml(entry.name)}</span>
          <span class="path">${escapeHtml(entry.file)}</span>
          <span class="badges">${entry.open ? `<b class="open">${entry.open} open</b>` : ""}${
            entry.addressed ? `<b class="review">${entry.addressed} to review</b>` : ""
          }${entry.key === key ? '<b class="here">this one</b>' : ""}</span>
        </a>`,
      )
      .join("")}</div>`,
  );
}

/**
 * Diffs the artifact against how it looked when the review was sent, and works
 * out which note each change belongs to. Recomputed only when the review being
 * read changes, since it costs two fetches and two parses.
 */
async function refreshAttribution(): Promise<void> {
  const answered = answeredReview();
  if (!answered?.baseVersion) {
    attribution = null;
    attributedReviewId = null;
    return;
  }
  if (attributedReviewId === answered.id) return;

  const [before, after] = await Promise.all([
    fetchVersion(answered.baseVersion),
    fetch(`/artifact/${key}/raw?t=${encodeURIComponent(token)}`).then((response) => (response.ok ? response.text() : "")),
  ]);
  if (!before || !after) return;

  attribution = attributeChanges(
    before,
    after,
    answered.items.map((item) => ({ id: item.id, selector: item.selector, text: item.text })),
  );
  attributedReviewId = answered.id;
  render();
}

// --- versions ---------------------------------------------------------------

/** Snapshots are immutable, so one fetch per version is enough. */
const versionCache = new Map<number, string>();
let previewing: number | null = null;
/** The two versions being compared. B defaults to the newest, which is the
 *  question people ask first: what has changed since then. */
let compareA: number | null = null;
let compareB: number | null = null;

async function fetchVersion(seq: number): Promise<string> {
  const cached = versionCache.get(seq);
  if (cached !== undefined) return cached;
  const response = await fetch(`/api/${key}/versions/${seq}?t=${encodeURIComponent(token)}`);
  const html = response.ok ? await response.text() : "";
  if (html) versionCache.set(seq, html);
  return html;
}

function selectVersion(seq: number): void {
  for (const row of overlay.querySelectorAll<HTMLElement>(".version")) {
    row.classList.toggle("active", Number(row.dataset.seq) === seq);
  }
  for (const button of overlay.querySelectorAll<HTMLElement>("[data-a]")) {
    button.classList.toggle("active", Number(button.dataset.a) === compareA);
  }
  for (const button of overlay.querySelectorAll<HTMLElement>("[data-b]")) {
    button.classList.toggle("active", Number(button.dataset.b) === compareB);
  }
}

async function previewVersion(seq: number): Promise<void> {
  const html = await fetchVersion(seq);
  if (!html) return toast(`v${seq} has aged out of history`, "error");
  previewing = seq === (versions[versions.length - 1]?.seq ?? -1) ? null : seq;
  toFrame({ type: "pe:preview", html });
}

async function stepVersion(delta: number): Promise<void> {
  const current = previewing ?? versions[versions.length - 1]?.seq;
  const index = versions.findIndex((entry) => entry.seq === current);
  const next = versions[Math.min(versions.length - 1, Math.max(0, index + delta))];
  if (!next || next.seq === current) return;
  compareA = next.seq;
  selectVersion(next.seq);
  await Promise.all([previewVersion(next.seq), showDiff()]);
}

function versionRow(version: VersionMeta, isCurrent: boolean): string {
  return `<div class="version${isCurrent ? " active" : ""}" data-seq="${version.seq}">
    <button class="version-pick" type="button" data-pick="${version.seq}">
      <span class="seq">v${version.seq}${version.pinned ? ' <span class="pinned" title="pinned — exempt from the history cap">📌</span>' : ""}</span>
      <span class="vlabel">${version.label ? escapeHtml(version.label) : `<i>${version.origin === "open" ? "initial" : version.origin}</i>`}</span>
      <span class="when" data-at="${escapeHtml(version.at)}">${ago(version.at)}</span>
      ${isCurrent ? '<span class="current">current</span>' : ""}
    </button>
    <div class="vtools">
      <button class="ab" type="button" data-a="${version.seq}" title="Compare from here">A</button>
      <button class="ab" type="button" data-b="${version.seq}" title="Compare to here">B</button>
      <button class="link" type="button" data-name="${version.seq}" title="Give this version a name">name</button>
      <button class="link" type="button" data-pin="${version.seq}" title="${version.pinned ? "Unpin" : "Pin so it is never dropped"}">${version.pinned ? "unpin" : "pin"}</button>
    </div>
  </div>`;
}

/**
 * Fills the version strip from the current list.
 *
 * Separate from `openHistory` because naming and pinning are server round
 * trips: the sheet was built once and never repainted, so the human clicked
 * "pin", the server stored it, and the strip went on showing an unpinned
 * version — which reads as a control that does nothing.
 */
function paintVersions(): void {
  const strip = overlay.querySelector(".versions");
  if (!strip) return;
  const latest = versions[versions.length - 1];
  strip.innerHTML = [...versions]
    .reverse()
    .map((version) => versionRow(version, version.seq === latest?.seq))
    .join("");
  selectVersion(compareA ?? -1);
}

async function openHistory(): Promise<void> {
  const latest = versions[versions.length - 1];
  compareB = latest?.seq ?? null;
  compareA = versions[versions.length - 2]?.seq ?? latest?.seq ?? null;
  openSheet(
    "History",
    `<p class="scrub-hint">Click a version to see it in place. <kbd>←</kbd> <kbd>→</kbd> to scrub. <b>A</b> and <b>B</b> pick the two to compare.</p>
     <div class="versions"></div>
     <div class="diff" id="diffPane"><p class="empty">Pick a version to see what changed since it.</p></div>
     <details class="churn"><summary>Most rewritten sections</summary><div id="churnList"><p class="empty">Counting…</p></div></details>`,
  );

  paintVersions();
  void showDiff();
  void loadChurn();

  overlay.querySelector(".versions")?.addEventListener("click", (event) => {
    const target = event.target as HTMLElement;
    const attr = (name: string) => target.closest(`[data-${name}]`)?.getAttribute(`data-${name}`);

    const pick = attr("pick");
    if (pick) {
      const seq = Number(pick);
      compareA = seq;
      selectVersion(seq);
      void previewVersion(seq);
      void showDiff();
      return;
    }
    const a = attr("a");
    if (a) {
      compareA = Number(a);
      selectVersion(compareA);
      void showDiff();
      return;
    }
    const b = attr("b");
    if (b) {
      compareB = Number(b);
      selectVersion(compareA ?? -1);
      void showDiff();
      return;
    }
    const pin = attr("pin");
    if (pin) {
      const seq = Number(pin);
      const meta = versions.find((entry) => entry.seq === seq);
      void guard("Pinning", () => send(`/versions/${seq}/label`, body({ pinned: !meta?.pinned })));
      return;
    }
    const name = attr("name");
    if (name) beginNaming(Number(name));
  });

  // Warm the two the human is most likely to look at first, so the first click
  // moves rather than loads.
  if (latest) void fetchVersion(latest.seq);
  const previous = versions[versions.length - 2];
  if (previous) void fetchVersion(previous.seq);
}

/**
 * Names a version in place.
 *
 * A row of anonymous `v7`s is a history nobody reads: the one thing worth
 * recording is what a version *was* ("before the scope cut"), and that is known
 * at the moment it is looked at, not at the moment it was written.
 */
function beginNaming(seq: number): void {
  const row = overlay.querySelector<HTMLElement>(`.version[data-seq="${seq}"]`);
  const label = row?.querySelector<HTMLElement>(".vlabel");
  if (!label) return;
  const existing = versions.find((entry) => entry.seq === seq)?.label ?? "";
  label.innerHTML = `<input class="vname" type="text" value="${escapeHtml(existing)}" placeholder="e.g. before the scope cut">`;
  const field = label.querySelector<HTMLInputElement>(".vname")!;
  field.focus();
  field.select();
  let done = false;
  const commit = (save: boolean) => {
    if (done) return;
    done = true;
    // The input comes out of the DOM either way. While it is there the strip
    // refuses to repaint — it would eat a name being typed — so leaving it
    // behind meant the saved name, and any pin pressed afterwards, never
    // appeared at all.
    label.textContent = save ? field.value || existing : existing;
    if (save) void guard("Naming", () => send(`/versions/${seq}/label`, body({ label: field.value })));
  };
  field.addEventListener("keydown", (event) => {
    if (event.key === "Enter") {
      event.preventDefault();
      commit(true);
    }
    if (event.key === "Escape") {
      event.preventDefault();
      event.stopPropagation();
      commit(false);
    }
  });
  field.addEventListener("blur", () => commit(true));
}

async function showDiff(): Promise<void> {
  const pane = document.getElementById("diffPane");
  if (!pane) return;
  const a = compareA;
  const b = compareB ?? versions[versions.length - 1]?.seq;
  if (a === null || b === undefined) return;
  pane.innerHTML = `<p class="empty">Comparing…</p>`;

  const [oldHtml, newHtml] = await Promise.all([fetchVersion(a), fetchVersion(b)]);
  if (!oldHtml || !newHtml) {
    pane.innerHTML = `<p class="empty">One of those versions has aged out of history.</p>`;
    return;
  }
  const diff = diffDocuments(oldHtml, newHtml);
  const heading = `<p class="diff-head">v${a} → v${b}</p>`;
  const restore =
    a === versions[versions.length - 1]?.seq ? "" : `<button class="restore" type="button" data-restore="${a}">Restore v${a}</button>`;

  pane.innerHTML =
    heading +
    (diff.sections.length === 0
      ? `${restore}<p class="empty">${
          diff.unattributed
            ? "Content changed, but not inside any element with an id."
            : "No differences between these two versions."
        }</p>`
      : restore + diff.sections.map(renderSectionDiff).join(""));

  pane.querySelector("[data-restore]")?.addEventListener("click", async () => {
    const done = await guard("Restore", () => send("/restore", body({ seq: a })));
    previewing = null;
    closeOverlay();
    if (done) toast(`Restored v${a}`);
  });
}

/** The sharpest signal in the system: a section rewritten six times is one the
 *  human and the agent still disagree about. */
async function loadChurn(): Promise<void> {
  const data = await guard("Loading churn", () => send<{ churn: SectionChurn[] }>("/churn"));
  const pane = document.getElementById("churnList");
  if (!pane) return;
  const churn = data?.churn ?? [];
  pane.innerHTML = churn.length
    ? churn
        .map(
          (entry) => `<div class="churn-row">
            <span class="churn-count">${entry.rewrites}×</span>
            <span class="churn-label">${escapeHtml(entry.label)}</span>
            <span class="when" data-at="${escapeHtml(entry.lastAt)}">${ago(entry.lastAt)}</span>
          </div>`,
        )
        .join("")
    : `<p class="empty">Nothing has been rewritten more than once yet.</p>`;
}

// --- the record: transcript, packets, git, notifications --------------------

async function openRecord(): Promise<void> {
  const sendable = reviews.filter((review) => review.status !== "drafting");
  openSheet(
    "Record",
    `<div class="record">
       <section>
         <h3>Share</h3>
         <div class="row">
           <button type="button" data-copy-link>Copy the session link</button>
           <button type="button" data-export>Download a standalone copy</button>
         </div>
       </section>
       <section>
         <h3>The paper trail</h3>
         <p class="drawer-hint">Every note, verdict, answer and version, as markdown you can keep.</p>
         <div class="row"><button type="button" data-transcript>Download the transcript</button></div>
       </section>
       <section>
         <h3>Packets</h3>
         <p class="drawer-hint">Hand a review to someone with no server and no account. Theirs comes back as a file; its items land in your draft, never straight to your agent.</p>
         <div class="row">
           <select id="packetReview">${
             sendable.length
               ? sendable
                   .map(
                     (review) =>
                       `<option value="${escapeHtml(review.id)}">${review.items.length} item${review.items.length === 1 ? "" : "s"} · ${escapeHtml(review.note.slice(0, 40) || review.status)}</option>`,
                   )
                   .reverse()
                   .join("")
               : `<option value="">Nothing sent yet</option>`
           }</select>
           <button type="button" data-packet ${sendable.length ? "" : "disabled"}>Export</button>
         </div>
         <label class="import">Import a packet<input type="file" id="packetFile" accept="application/json,.json"></label>
       </section>
       ${
         companions.length
           ? `<section>
         <h3>Reviewed alongside</h3>
         <div class="companions">${companions.map((file) => `<code>${escapeHtml(file)}</code>`).join("")}</div>
       </section>`
           : ""
       }
       <section>
         <h3>Git</h3>
         <div id="gitStatus" class="git-status">Checking…</div>
         <textarea id="commitMessage" rows="2" placeholder="Commit message"></textarea>
         <div class="row"><button type="button" data-commit>Commit the artifact</button></div>
       </section>
       <section>
         <h3>Notifications</h3>
         <p class="drawer-hint">Tells you when your agent answers while this tab is in the background. Nothing is asked for until you press this.</p>
         <div class="row"><button type="button" data-notify>${notifyLabel()}</button></div>
       </section>
     </div>`,
  );

  overlay.querySelector("[data-copy-link]")?.addEventListener("click", () => {
    void navigator.clipboard.writeText(location.href).then(
      () => toast("Session link copied"),
      () => toast("Could not copy — the link is in your address bar", "error"),
    );
  });
  overlay.querySelector("[data-export]")?.addEventListener("click", () => {
    window.open(`/api/${key}/export?t=${encodeURIComponent(token)}`, "_blank");
  });
  overlay.querySelector("[data-transcript]")?.addEventListener("click", () => {
    window.open(`/api/${key}/transcript?t=${encodeURIComponent(token)}`, "_blank");
  });
  overlay.querySelector("[data-packet]")?.addEventListener("click", () => {
    const id = $<HTMLSelectElement>("packetReview").value;
    if (!id) return;
    window.open(`/api/${key}/packet/${encodeURIComponent(id)}?t=${encodeURIComponent(token)}`, "_blank");
  });
  overlay.querySelector("#packetFile")?.addEventListener("change", (event) => {
    const file = (event.target as HTMLInputElement).files?.[0];
    if (file) void importPacket(file);
  });
  overlay.querySelector("[data-commit]")?.addEventListener("click", () => void commit());
  overlay.querySelector("[data-notify]")?.addEventListener("click", (event) => {
    void enableNotifications(event.currentTarget as HTMLButtonElement);
  });

  void loadGit();
}

async function importPacket(file: File): Promise<void> {
  const result = await guard("Importing the packet", async () => {
    // Parsed here so a file that is not JSON at all fails with something the
    // human can act on, rather than as a 400 from a route about packets.
    const packet = JSON.parse(await file.text()) as unknown;
    return await send<{ items: number; drift: string; note: string }>(
      "/packet/import",
      body({ packet, from: file.name }),
    );
  });
  if (!result) return;
  closeOverlay();
  toast(`Imported ${result.items} item${result.items === 1 ? "" : "s"} into your draft`);
  // The drift warning is the whole point of importing through the tool rather
  // than by hand: the items anchor cleanly to the wrong paragraphs when the
  // document has moved on, and nothing else says so.
  if (result.drift === "changed") toast(result.note, "error", 12_000);
}

async function loadGit(): Promise<void> {
  const pane = document.getElementById("gitStatus");
  const data = await guard("Reading git", () =>
    send<{ git: { branch: string; tracked: boolean; dirty: boolean } | null; diff: string | null }>("/git"),
  );
  const target = document.getElementById("gitStatus") ?? pane;
  if (!target) return;
  if (!data?.git) {
    target.textContent = "This artifact is not inside a git repository.";
    return;
  }
  target.innerHTML = `<b>${escapeHtml(data.git.branch)}</b> · ${data.git.tracked ? "tracked" : "untracked"} · ${
    data.git.dirty ? "uncommitted changes" : "clean"
  }`;
}

async function commit(): Promise<void> {
  const message = $<HTMLTextAreaElement>("commitMessage").value.trim();
  if (!message) return toast("A commit needs a message", "error");
  const result = await guard("Committing", () =>
    send<{ committed: boolean; sha?: string; reason?: string }>("/git/commit", body({ message })),
  );
  if (!result) return;
  // Git degrades to "no" rather than throwing, so a refusal arrives as a 200
  // with a reason. Showing it is the difference between "it did not commit" and
  // "nothing happened".
  if (result.committed) {
    toast(`Committed ${result.sha?.slice(0, 8) ?? ""}`.trim());
    void loadGit();
  } else {
    toast(result.reason ?? "Nothing was committed", "error");
  }
}

// --- notifications ----------------------------------------------------------

function notifyOn(): boolean {
  try {
    return localStorage.getItem("pe-notify") === "on";
  } catch {
    return false;
  }
}

function notifyLabel(): string {
  if (typeof Notification === "undefined") return "Not supported in this browser";
  if (Notification.permission === "denied") return "Blocked in your browser settings";
  return notifyOn() ? "Turn off desktop notifications" : "Turn on desktop notifications";
}

/**
 * Permission is only ever requested from this click.
 *
 * Asking on load is the fastest way to a permanent `denied`: the browser shows a
 * prompt for a page the human has not used yet, they dismiss it, and the feature
 * can never be offered again from any tab on this origin.
 */
async function enableNotifications(button: HTMLButtonElement): Promise<void> {
  if (typeof Notification === "undefined") return;
  if (notifyOn()) {
    try {
      localStorage.setItem("pe-notify", "off");
    } catch {
      /* private browsing */
    }
    button.textContent = notifyLabel();
    return;
  }
  const permission = Notification.permission === "granted" ? "granted" : await Notification.requestPermission();
  if (permission !== "granted") {
    toast("Your browser refused notifications for this page", "error");
    button.textContent = notifyLabel();
    return;
  }
  try {
    localStorage.setItem("pe-notify", "on");
  } catch {
    /* private browsing */
  }
  button.textContent = notifyLabel();
  toast("You will be told when your agent answers");
}

function notify(text: string): void {
  if (!document.hidden || !notifyOn()) return;
  if (typeof Notification === "undefined" || Notification.permission !== "granted") return;
  try {
    new Notification(`${fileName} — your agent replied`, { body: text.slice(0, 180), tag: key });
  } catch {
    // Some browsers only allow this from a service worker. The toast and the
    // title badge have already done the job.
  }
}

/**
 * The count in the tab title.
 *
 * The whole latency problem this tool has is that the human is looking
 * somewhere else when the agent finishes. A number in the tab is the one signal
 * that reaches a backgrounded tab without asking anyone for permission.
 */
function updateTitle(): void {
  const count = awaitingCount();
  document.title = count ? `(${count}) ${fileName} — plan-editor` : `${fileName} — plan-editor`;
}

// --- ending -----------------------------------------------------------------

endButton.addEventListener("click", async () => {
  endButton.disabled = true;
  endButton.textContent = "Ending…";
  await guard("Ending the session", () => send("/end", body({})));
  stream?.close();
  setMode(false);
  window.close();
  setTimeout(showEndedScreen, 120);
});

function showEndedScreen(): void {
  if (document.querySelector(".ended-screen")) return;
  const screen = document.createElement("div");
  screen.className = "ended-screen";
  screen.innerHTML = `<div>
    <h1>Session ended</h1>
    <p>Nothing further is being sent to your agent. You can close this tab and pick the conversation back up in your terminal.</p>
    <p class="hint">Reopen any time with <code>plan-editor ${escapeHtml(bootstrap.file)}</code></p>
  </div>`;
  document.body.appendChild(screen);
}

// --- messages from the artifact SDK ----------------------------------------

function pushLocks(): void {
  toFrame({ type: "pe:locks", locks });
}

/** The raw document, so the panel can locate anchors and splice sections
 *  without ever reading into the frame. */
async function primeDocument(): Promise<void> {
  const response = await fetch(`/artifact/${key}/raw?t=${encodeURIComponent(token)}`);
  if (response.ok) {
    setCurrentHtml(await response.text());
    scheduleRender();
  }
}

/**
 * A verbatim or structural gesture is submitted the moment it completes.
 *
 * Both of them already carry the whole instruction — the replacement text, or
 * the operation and its target — so parking them in the composer to wait for a
 * sentence of prose would be asking the human to describe what they have just
 * finished pointing at.
 */
async function submitGesture(
  clientId: string,
  kind: "verbatim" | "structural",
  anchors: Array<{ selector: string; text: string; locked?: boolean }>,
  data: Record<string, unknown>,
): Promise<void> {
  const anchor = anchors[0];
  if (!anchor) return;
  const created = await submitItem({
    selector: anchor.selector,
    text: anchor.text,
    anchors,
    tag: kind,
    ...(kind === "verbatim" ? { replacement: String(data.replacement ?? "") } : {}),
    ...(kind === "structural" ? { op: data.op as StructuralOp } : {}),
  });
  if (!created) {
    // The gesture is gone from the panel, so it must go from the document too —
    // otherwise the element keeps the dashed outline of a note that does not
    // exist and every morph reports it.
    toFrame({ type: "pe:cancel", clientId });
    return;
  }
  toFrame({ type: "pe:bind", clientId, id: created.id });
  toast(
    anchor.locked
      ? "Added — note that this region is locked, so the agent has been told to leave it alone"
      : kind === "verbatim"
        ? "Your exact wording is in the review"
        : "Structural change added to the review",
  );
  render();
}

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== frame.contentWindow) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "pe:ready":
      setMode(modeToggle.checked);
      applyTheme(theme);
      trackedIds.clear();
      anchorScores.clear();
      weakCandidates.clear();
      syncTracking();
      pushLocks();
      toFrame({ type: "pe:outline" });
      void primeDocument();
      break;

    case "pe:toggleMode":
      setMode(!modeToggle.checked);
      break;

    // A key pressed inside the artifact. The two documents cannot see each
    // other's key events, so without this relay every shortcut except Cmd-I
    // was dead from the moment the human clicked the document — which is the
    // first thing they do.
    case "pe:key":
      handleKey(fromFrame(String(data.key), Boolean(data.meta), Boolean(data.shift)));
      break;

    // The human took a selection back inside the artifact (clicked it again,
    // pressed Escape, or left annotate mode). The panel has to let go of it
    // too, or it keeps offering to pin a note to something no longer marked.
    case "pe:unarmed":
      if (armed && armed.clientId === String(data.clientId)) {
        armed = null;
        render();
      }
      break;

    case "pe:annotate": {
      const clientId = String(data.clientId);
      const anchors = (data.anchors ?? []) as Array<{ selector: string; text: string; locked?: boolean }>;
      const kind = String(data.kind ?? "element");

      if (kind === "verbatim" || kind === "structural") {
        void submitGesture(clientId, kind, anchors, data);
        break;
      }

      if (armed?.clientId === clientId) {
        // A modifier-click extended the selection rather than starting a new
        // note — keep whatever has been typed so far.
        armed.anchors = anchors;
      } else if (!armed) {
        // Nothing was pinned when this text was typed, so there is no earlier
        // target it could belong to — it belongs to the element just clicked.
        //
        // Auto-committing here filed it as a *page* note instead, cleared the
        // box, and then displayed "Pinned to …" for the new target: the human's
        // note silently landed on the whole document rather than the thing they
        // clicked, and the panel said otherwise. The click and the first
        // keystroke are separated by a postMessage hop across the sandbox, so
        // anyone who types promptly after clicking hits it.
        armed = { clientId, anchors, kind: kind === "text" ? "text" : "element" };
      } else {
        // A different element while a note is half-written *and* already pinned
        // somewhere: commit it, so nothing is lost by moving on. If that commit
        // fails the typed text is still in the box and still belongs to the old
        // target, so the new gesture is cancelled rather than silently
        // inheriting it.
        void commitNote().then((committed) => {
          if (!committed) {
            toFrame({ type: "pe:cancel", clientId });
            return;
          }
          armed = { clientId, anchors, kind: kind === "text" ? "text" : "element" };
          render();
        });
        input.focus();
        break;
      }
      input.focus();
      render();
      break;
    }

    case "pe:repointed": {
      repointing = null;
      const id = String(data.id);
      void guard("Re-pointing", async () => {
        await send(`/items/${id}/repoint`, body({ selector: String(data.selector), text: String(data.text) }));
        weakCandidates.delete(id);
        anchorScores.delete(id);
        trackedIds.delete(id);
        syncTracking();
      });
      render();
      break;
    }

    // Every open note is re-anchored on load and after every patch. A note the
    // SDK could not place, or placed weakly, is the one case where the panel
    // would otherwise look correct and be pointing somewhere else.
    case "pe:trackResult": {
      for (const entry of (data.resolved ?? []) as Array<{ id: string; score: number }>) {
        anchorScores.set(entry.id, entry.score);
        weakCandidates.delete(entry.id);
      }
      for (const entry of (data.weak ?? []) as Array<{
        id: string;
        candidates: Array<{ selector: string; text: string; score: number }>;
      }>) {
        anchorScores.delete(entry.id);
        weakCandidates.set(entry.id, entry.candidates ?? []);
      }
      scheduleRender();
      break;
    }

    case "pe:outlined":
      sections = (data.sections ?? []) as Array<{ id: string; level: number; text: string }>;
      sectionCache = null;
      scheduleRender();
      break;

    case "pe:found": {
      const count = Number(data.count ?? 0);
      findCount.textContent = findBox.value.trim() ? (count ? `${count} in the document` : "no matches") : "";
      break;
    }

    // The chrome cannot see key events inside the frame, so an Escape pressed
    // over the artifact would otherwise leave a toolbar button lit with nothing
    // behind it.
    case "pe:gestureEnded": {
      const which = String(data.gesture);
      if (which === "repoint") repointing = null;
      if (which === "suggest" || which === "structural") gesture = null;
      render();
      break;
    }

    case "pe:morphed":
      void api("/morph-report", body({ addressed: data.addressed ?? [], orphaned: data.orphaned ?? [] }));
      // The document just changed shape, so the navigator is stale.
      toFrame({ type: "pe:outline" });
      break;

    case "pe:morphFailed":
      // Morphing arbitrary agent-written HTML is a heuristic. Say so out loud
      // rather than silently reloading — a blank frame with no explanation is
      // the worst thing this tool can do.
      toast("Could not patch in place — reloading the artifact", "error");
      frame.src = `/artifact/${key}/index.html?t=${encodeURIComponent(token)}&r=${Date.now()}`;
      break;
  }
});

// --- server stream ----------------------------------------------------------

let stream: EventSource | null = null;
let dropped = false;

function connect(): void {
  stream = new EventSource(`/events/${key}?t=${encodeURIComponent(token)}`);

  stream.addEventListener("open", () => {
    if (!dropped) return;
    dropped = false;
    setStatus(null);
    toast("Reconnected");
    void applyPatch();
  });

  // EventSource retries on its own, but silently — so a dead server looked
  // exactly like an idle one, which is most of why this felt unresponsive.
  stream.addEventListener("error", () => {
    dropped = true;
    setStatus("Disconnected from the plan-editor server — retrying…", {
      label: "Reload",
      run: () => location.reload(),
    });
  });

  stream.addEventListener("message", (event) => {
    const payload = JSON.parse(event.data) as ServerEvent;
    switch (payload.type) {
      case "patch":
        void applyPatch();
        break;
      case "sync": {
        reviews = payload.reviews;
        chat = payload.chat;
        contract = payload.contract ?? [];
        locks = payload.locks ?? [];
        companions = payload.companions ?? [];
        sectionCache = null;
        pushLocks();
        void refreshAttribution();
        // The server owns the draft note; only adopt it when the field is idle so
        // it never overwrites what is being typed.
        const note = draftReview()?.note ?? "";
        if (document.activeElement !== overall && overall.value !== note) overall.value = note;
        syncTracking();
        render();
        break;
      }
      case "versions":
        versions = payload.list;
        // A name or a pin lands as a `versions` event, so an open history sheet
        // has to take it — unless a name is being typed into it right now.
        if (!overlay.hidden && !overlay.querySelector(".vname")) paintVersions();
        render();
        break;
      case "presence": {
        presenceState = payload.state;
        agentView = payload.agent;
        presence.dataset.state = payload.state;
        const who = agentView.session ? ` · ${agentView.session}` : "";
        presence.textContent =
          presenceState === "working"
            ? `agent working…${who}`
            : presenceState === "listening"
              ? `${agentView.viaHooks ? "agent connected" : "agent listening"}${who}`
              : agentView.session
                ? `agent idle · ${agentView.session}`
                : "no agent";
        presence.title = agentView.session
          ? `Bound to Claude session ${agentView.session}…${
              agentView.lastContact ? `\nLast seen ${new Date(agentView.lastContact).toLocaleTimeString()}` : "\nNot seen yet"
            }`
          : "No agent session is bound to this artifact";
        render();
        break;
      }
      case "agent-reply":
        chat.push({ role: "agent", text: payload.text, at: new Date().toISOString() });
        $("conversation").setAttribute("open", "");
        toast("Your agent replied");
        notify(payload.text);
        render();
        break;
    }
  });
}

/** Fetches the new artifact HTML and hands it to the SDK to morph in place. */
async function applyPatch(): Promise<void> {
  const response = await fetch(`/artifact/${key}/raw?t=${encodeURIComponent(token)}`);
  if (!response.ok) {
    toast("Could not read the artifact", "error");
    return;
  }
  const html = await response.text();
  setCurrentHtml(html);
  previewing = null;
  altPreview = null;
  // The document moved, so what the agent did to it has to be recomputed —
  // otherwise the per-item diffs keep describing an edit two revisions old.
  attributedReviewId = null;
  void refreshAttribution();
  toFrame({ type: "pe:morph", html });
}

// Relative timestamps go stale on a page left open for an hour. Only the
// timestamps are rewritten: re-rendering the panel for this is what used to
// throw away the focus ring and any half-typed reply.
setInterval(refreshTimes, 60_000);

// A session the human already ended must not come back as a live UI. The status
// was in the bootstrap payload and read from it, and then nothing was done with
// it — so reloading an ended tab showed a working panel wired to a session that
// would refuse every write.
if (bootstrap.status === "ended") {
  showEndedScreen();
} else {
  connect();
}

render();






