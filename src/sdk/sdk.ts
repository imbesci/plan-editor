// Runs inside the artifact iframe, which is sandboxed with `allow-scripts` but
// deliberately WITHOUT `allow-same-origin`. Two consequences shape this file:
//
//   1. The iframe has an opaque origin, so it cannot usefully fetch from the
//      server. All network access lives in the chrome, which holds the session
//      token; the SDK only ever receives HTML over postMessage. The SDK never
//      sees the token.
//   2. It cannot read the chrome's DOM. Everything is postMessage.
//
// Annotated elements are tracked by live Element reference, not by selector.
// Selectors are a hint for the agent and nothing else — they do not survive the
// agent rewriting the file, which is the entire problem this tool exists to fix.
// Across a *reload* there is no live reference left to hold, and re-finding the
// element from a stored anchor is `anchor.ts` — read its header before touching
// anything on the resolution path.
//
// Every node and every class this file adds to the artifact is `data-pe-ui` /
// `pe-`-prefixed, without exception. `morphDocument` skips the former and
// `markupWithoutOurClasses` strips the latter before comparing markup; anything
// that escapes both makes the live DOM permanently differ from the file, so the
// element is reported changed on every single patch — which flashes it green
// and marks every open annotation on it addressed.

import { bestMatch, CONFIDENT, hashText, normalizeText, shingles, similarity } from "./anchor.ts";
import { diagramNodeAt, refreshDiagrams, setDiagramTheme } from "./diagram.ts";
import { diffWords } from "./diff.ts";
import { morphDocument, UI_ATTRIBUTE, type TextChange, type TrackedAnchor } from "./morph.ts";

const pending = new Map<string, TrackedAnchor>();
/** The group currently being built, so a modifier-click can extend it. */
let armedGroup: { clientId: string; elements: Element[] } | null = null;
let annotateMode = false;
let hoverTarget: Element | null = null;
/** When set, the next click re-anchors this orphaned annotation instead of
 *  creating a new one. */
let repointing: string | null = null;

const HIGHLIGHT_CLASS = "pe-changed";
const PENDING_CLASS = "pe-pending";
const EDITING_CLASS = "pe-editing";
const SUBJECT_CLASS = "pe-subject";
const LOCKED_CLASS = "pe-locked";

/**
 * Annotations re-tracked from the store are keyed `s:<id>` so they cannot
 * collide with a live client id. `pe:cancel` used to look up the raw id and so
 * could never delete one of these — a re-tracked annotation stayed pending
 * forever, kept its dashed outline after the human cancelled it, and went on
 * being reported addressed by every subsequent morph. Every lookup now goes
 * through `pendingEntry`, which accepts either key.
 */
const TRACK_PREFIX = "s:";

function post(message: unknown): void {
  parent.postMessage(message, "*");
}

function pendingEntry(key: string): { key: string; entry: TrackedAnchor } | null {
  const direct = pending.get(key);
  if (direct) return { key, entry: direct };
  const tracked = pending.get(TRACK_PREFIX + key);
  return tracked ? { key: TRACK_PREFIX + key, entry: tracked } : null;
}

function newClientId(): string {
  return `c${Math.random().toString(36).slice(2, 10)}`;
}

// --- anchors ----------------------------------------------------------------

/**
 * Raised from 300. The snippet is what a human reads in the review panel, so it
 * cannot be unbounded, but at 300 characters it was also the *only* record of
 * what the note pointed at — and a truncated needle can never equal an
 * untruncated haystack, so every paragraph longer than a tweet became
 * permanently unmatchable after a reload.
 *
 * Stays under protocol.ts's MAX_TEXT (2000) so a submitted item is never
 * rejected at the edge for a snippet this file chose.
 */
const SNIPPET_LIMIT = 1200;

interface AnchorSpec {
  selector: string;
  text: string;
  hash?: string;
  shingles?: string[];
  /** Set when the anchored element is inside a locked region. */
  locked?: boolean;
  /**
   * Set when the click landed on a node inside a rendered diagram. The anchor
   * itself still points at the diagram's *source* block — the thing that exists
   * in the file — and this only says which part of the picture was meant.
   */
  node?: { id: string; label: string };
}

function selectorFor(element: Element): string {
  const parts: string[] = [];
  let current: Element | null = element;
  while (current && current !== document.documentElement && parts.length < 6) {
    if (current.id) {
      parts.unshift(`#${CSS.escape(current.id)}`);
      break;
    }
    const parentElement: Element | null = current.parentElement;
    if (!parentElement) break;
    const siblings = Array.from(parentElement.children).filter((child) => child.tagName === current!.tagName);
    const index = siblings.indexOf(current) + 1;
    parts.unshift(siblings.length > 1 ? `${current.tagName.toLowerCase()}:nth-of-type(${index})` : current.tagName.toLowerCase());
    current = parentElement;
  }
  return parts.join(" > ");
}

/** Whitespace-collapsed text, untruncated. */
function fullTextOf(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim();
}

function snippetFor(element: Element): string {
  return fullTextOf(element).slice(0, SNIPPET_LIMIT);
}

/**
 * The durable record of what a note points at.
 *
 * `text` is clipped for the human, but `hash` and `shingles` are computed over
 * the FULL text — that asymmetry is the entire fix. Hashing the clipped snippet
 * would bake the truncation into the identity, so the stored anchor would only
 * ever match another equally-truncated copy of itself, which is nothing that
 * exists in the document.
 */
function anchorFor(element: Element, text?: string): AnchorSpec {
  const full = text ?? fullTextOf(element);
  return {
    selector: selectorFor(element),
    text: full.slice(0, SNIPPET_LIMIT),
    hash: hashText(full),
    shingles: shingles(full),
    // A lock constrains the agent, not the human, so the click still annotates —
    // but the chrome needs to know to warn before it is sent.
    ...(isLocked(element) ? { locked: true } : {}),
  };
}

function describe(elements: Element[]): AnchorSpec[] {
  return elements.map((element) => anchorFor(element));
}

function specFrom(raw: Record<string, unknown>): AnchorSpec {
  return {
    selector: typeof raw.selector === "string" ? raw.selector : "",
    text: typeof raw.text === "string" ? raw.text : "",
    ...(typeof raw.hash === "string" ? { hash: raw.hash } : {}),
    ...(Array.isArray(raw.shingles)
      ? { shingles: raw.shingles.filter((value): value is string => typeof value === "string") }
      : {}),
  };
}

// --- resolution -------------------------------------------------------------

interface Candidate {
  item: Element;
  text: string;
}

interface Resolution {
  element: Element | null;
  score: number;
  /** Ranked alternatives, populated only when nothing resolved confidently. */
  candidates: Array<{ selector: string; text: string; score: number }>;
}

/**
 * Worth offering as a re-point candidate.
 *
 * Measured on this scorer: a paragraph the agent half-rewrote but whose opening
 * survives lands near 0.48, two unrelated paragraphs near 0.01, and a paragraph
 * reworded end to end near 0.05 — i.e. a full reword is lexically
 * indistinguishable from noise and no threshold can rescue it. So the floor sits
 * well above that band. Offering the human three near-random paragraphs would be
 * false precision; an empty list at least says plainly that the anchor is gone.
 */
const WEAK_FLOOR = 0.25;
const MAX_WEAK = 3;
const MAX_CANDIDATES = 4000;
const SKIP_TAGS = new Set(["SCRIPT", "STYLE", "NOSCRIPT", "TEMPLATE", "LINK", "META", "TITLE"]);

/**
 * Every scorable element, with its text extracted once.
 *
 * Cached because the chrome re-tracks every open annotation on load, one
 * `pe:track` per item: extracting `textContent` for the whole body per anchor
 * made a reload quadratic in a document's size, and a plan with forty open
 * notes visibly hitched before it became interactive. Invalidated on anything
 * that rewrites the document, which is the only thing that can change it.
 */
let candidateCache: Candidate[] | null = null;

function invalidateCandidates(): void {
  candidateCache = null;
}

function candidateElements(): Candidate[] {
  if (candidateCache) return candidateCache;
  const list: Candidate[] = [];
  for (const element of document.body.querySelectorAll("*")) {
    if (SKIP_TAGS.has(element.tagName)) continue;
    // `closest` rather than `hasAttribute`: our own injected UI has children,
    // and a badge's text must never be offered as somewhere a note could live.
    if (element.closest(`[${UI_ATTRIBUTE}]`)) continue;
    const text = normalizeText(element.textContent ?? "");
    if (!text) continue;
    list.push({ item: element, text });
    if (list.length >= MAX_CANDIDATES) break;
  }
  candidateCache = list;
  return list;
}

function querySelectorSafe(selector: string): Element | null {
  if (!selector) return null;
  try {
    return document.querySelector(selector);
  } catch {
    // Malformed stored selector; scoring still has a chance.
    return null;
  }
}

/**
 * Re-finds the element an anchor was written against.
 *
 * Selector first, because when the agent kept ids stable it is exact and free.
 * But the hit is *verified* against the stored hash/shingles before it is
 * accepted: a `p:nth-of-type(3)` recorded before the agent inserted a paragraph
 * now names a different paragraph with total confidence, and silently attaching
 * a note to the wrong element is worse than admitting it was lost — the human
 * can fix "we lost this", and cannot even see "this now points somewhere else".
 *
 * Failing that, every candidate is scored and the best is taken only at or
 * above CONFIDENT. Below that the caller gets the ranked near-misses instead,
 * because offering three one-click choices is the difference between re-pointing
 * and hunting through the document by hand.
 */
function resolveAnchor(spec: AnchorSpec): Resolution {
  const hit = querySelectorSafe(spec.selector);
  const hasMaterial = Boolean(spec.hash || spec.shingles?.length || normalizeText(spec.text));

  // Nothing stored to verify against (an old record, or an anchor on an empty
  // element). A selector hit is still real evidence and there is nothing to
  // contradict it, so it is accepted — but at exactly the threshold, never
  // claiming a confidence that was never measured.
  if (hit && !hasMaterial) return { element: hit, score: CONFIDENT, candidates: [] };
  if (!hasMaterial) return { element: null, score: 0, candidates: [] };

  if (hit) {
    const score = similarity(spec, hit.textContent ?? "");
    if (score >= CONFIDENT) return { element: hit, score, candidates: [] };
  }

  const pool = candidateElements();
  const best = bestMatch(spec, pool);
  if (best && best.score >= CONFIDENT) return { element: best.item, score: best.score, candidates: [] };

  // Only now pay for a full ranking: the common case resolves on the first pass
  // and never builds this list at all.
  const ranked = pool
    .map((candidate) => ({ element: candidate.item, score: similarity(spec, candidate.text) }))
    .filter((candidate) => candidate.score >= WEAK_FLOOR)
    // Stable sort, so equal scores stay in document order — the same tie rule
    // `bestMatch` applies, which keeps a re-point list from reshuffling itself
    // between reloads.
    .sort((a, b) => b.score - a.score)
    .slice(0, MAX_WEAK);

  return {
    element: best ? best.item : null,
    score: best ? best.score : 0,
    candidates: ranked.map((candidate) => ({
      selector: selectorFor(candidate.element),
      text: snippetFor(candidate.element),
      score: candidate.score,
    })),
  };
}

// --- annotation targeting ---------------------------------------------------

const NATIVE_CONTROLS = new Set(["BUTTON", "INPUT", "SELECT", "TEXTAREA", "OPTION", "LABEL", "SUMMARY", "A"]);

function isInteractive(element: Element): boolean {
  let current: Element | null = element;
  while (current) {
    if (NATIVE_CONTROLS.has(current.tagName)) return true;
    if (current.hasAttribute("contenteditable")) return true;
    current = current.parentElement;
  }
  return false;
}

function nearestElement(node: Node): Element | null {
  return node.nodeType === Node.ELEMENT_NODE ? (node as Element) : node.parentElement;
}

/** Walks up to the nearest element worth annotating, so a click on a bare text
 *  node inside a paragraph annotates the paragraph. */
function annotationTarget(element: Element): Element {
  let current = element;
  while (current.parentElement && current.textContent && current.textContent.trim().length === 0) {
    current = current.parentElement;
  }
  return current;
}

/** True while any click gesture is armed. Hover and click interception are
 *  gated on this rather than on `annotateMode` alone, now that suggest and the
 *  structural gestures can be armed with annotate mode off. */
function gestureArmed(): boolean {
  return annotateMode || suggestMode || structural !== null || repointing !== null;
}

/**
 * Drops the half-made note — the one the human armed by clicking but has not
 * written yet.
 *
 * Only ever the *armed* group: everything else in `pending` is a real note that
 * exists on the server, and clearing those marks would tell the human their
 * feedback had gone away.
 *
 * There was no path to this at all. Clicking an element left it outlined with
 * no way to take it back short of writing a note you did not want and deleting
 * it from the panel.
 */
function clearArmed(): boolean {
  if (!armedGroup) return false;
  const clientId = armedGroup.clientId;
  const found = pendingEntry(clientId);
  if (found) {
    for (const element of found.entry.elements) element.classList.remove(PENDING_CLASS);
    pending.delete(found.key);
  }
  // Belt and braces: the group holds the live element references, so this
  // catches anything the pending map lost track of.
  for (const element of armedGroup.elements) element.classList.remove(PENDING_CLASS);
  armedGroup = null;
  post({ type: "pe:unarmed", clientId });
  return true;
}

function setMode(next: boolean): void {
  annotateMode = next;
  document.documentElement.classList.toggle("pe-annotate", next);
  // Leaving annotate mode abandons whatever was mid-selection. Keeping it meant
  // the outline survived the mode that produced it, so the document looked
  // marked up while none of the tools that made the mark were available.
  if (!next) clearArmed();
  clearHover();
}

function clearHover(): void {
  hoverTarget?.classList.remove("pe-hover");
  hoverTarget = null;
}

document.addEventListener(
  "mousemove",
  (event) => {
    if (!gestureArmed() || editing) return;
    const target = event.target;
    if (!(target instanceof Element) || isInteractive(target)) return clearHover();
    const diagram = diagramNodeAt(target);
    // Our own UI is never annotatable — with exactly one exception, which is why
    // this carve-out is written as "is it a diagram?" and not as "is it UI?".
    // A rendered diagram is `data-pe-ui` because it is generated here, but it is
    // also the only generated thing a click is *about*.
    if (!diagram && target.closest(`[${UI_ATTRIBUTE}]`)) return clearHover();
    // The whole node, never the <rect> or <text> under the cursor.
    const element = diagram ? diagram.element : annotationTarget(target);
    if (element === hoverTarget) return;
    clearHover();
    hoverTarget = element;
    element.classList.add("pe-hover");
  },
  true,
);

document.addEventListener(
  "click",
  (event) => {
    // While a suggestion is open the element owns its own clicks — intercepting
    // them would make it impossible to place a caret in the text being edited.
    if (editing) return;
    if (!gestureArmed()) return;
    const target = event.target;
    if (!(target instanceof Element) || isInteractive(target)) return;
    // See the hover handler: a rendered diagram is the one piece of `data-pe-ui`
    // a click may land on. Everything else of ours is bookkeeping, and anchoring
    // a note to it would point the agent at markup that is in no file.
    const diagram = diagramNodeAt(target);
    if (!diagram && target.closest(`[${UI_ATTRIBUTE}]`)) return;
    event.preventDefault();
    event.stopPropagation();

    // A live text selection is a more precise statement of intent than the
    // element containing it, so it wins when one exists. Not inside a diagram,
    // though: a selection there is a selection of generated SVG text, which
    // exists nowhere in the file the agent will open.
    const selection = window.getSelection();
    const selected =
      !diagram && selection && !selection.isCollapsed ? selection.toString().replace(/\s+/g, " ").trim() : "";
    const anchorElement = diagram
      ? diagram.host
      : selected && selection
        ? nearestElement(selection.getRangeAt(0).commonAncestorContainer) ?? annotationTarget(target)
        : annotationTarget(target);

    // The extra thing a diagram click knows. `anchorFor` still describes the
    // source block, so the note resolves like any other; this rides alongside so
    // the agent is told "the node labelled X in this diagram" rather than being
    // left to guess which of forty boxes was meant.
    const nodeRef = diagram?.nodeId ? { node: { id: diagram.nodeId, label: diagram.label } } : {};

    // Gesture precedence, most specific first. Each of these is armed
    // explicitly by the chrome, so an armed gesture always beats plain
    // annotation — a click that did something other than what the armed button
    // says would be indefensible.
    if (repointing) {
      post({
        type: "pe:repointed",
        id: repointing,
        ...anchorFor(anchorElement, selected || undefined),
        ...nodeRef,
      });
      endGesture("repoint", "completed");
      return;
    }

    if (structural) {
      handleStructuralClick(anchorElement);
      selection?.removeAllRanges();
      return;
    }

    if (suggestMode) {
      if (diagram) {
        // The source block is hidden behind its picture, so there is nothing on
        // screen to type over: `beginSuggest` would make a `display:none`
        // element contenteditable, fail to focus it, and leave the human looking
        // at a click that did nothing.
        showHint("A diagram is generated from its source — annotate it instead");
        setTimeout(hideHint, 1800);
      } else {
        beginSuggest(anchorElement);
      }
      selection?.removeAllRanges();
      return;
    }

    if (!annotateMode) return;

    // Shift/Cmd-click extends the current selection instead of starting a new
    // one, so a single instruction can cover a chunk of the document.
    const extend = Boolean((event.shiftKey || event.metaKey) && armedGroup);
    if (extend && armedGroup) {
      if (armedGroup.elements.includes(anchorElement)) {
        // Clicking a chosen element again removes it — the only sane way to undo
        // a mis-click mid-selection.
        armedGroup.elements = armedGroup.elements.filter((element) => element !== anchorElement);
        anchorElement.classList.remove(PENDING_CLASS);
      } else {
        armedGroup.elements.push(anchorElement);
        anchorElement.classList.add(PENDING_CLASS);
      }
      pending.set(armedGroup.clientId, { id: armedGroup.clientId, elements: [...armedGroup.elements] });
      // No `node` on a chunk: extending a selection is a statement about the
      // blocks it covers, and naming one box inside one of several diagrams
      // would claim a precision the gesture does not have.
      post({ type: "pe:annotate", clientId: armedGroup.clientId, kind: "element", anchors: describe(armedGroup.elements) });
      selection?.removeAllRanges();
      return;
    }

    // Clicking the armed element again takes the selection back. Without this
    // the only way out of a mis-click was to write a note you did not want and
    // then delete it — and a plain click just re-armed the same element under a
    // new id, so it looked like nothing happened.
    if (armedGroup && armedGroup.elements.length === 1 && armedGroup.elements[0] === anchorElement) {
      clearArmed();
      selection?.removeAllRanges();
      return;
    }

    const clientId = newClientId();
    armedGroup = { clientId, elements: [anchorElement] };
    pending.set(clientId, { id: clientId, elements: [anchorElement] });
    anchorElement.classList.add(PENDING_CLASS);
    post({
      type: "pe:annotate",
      clientId,
      kind: selected ? "text" : "element",
      anchors: [{ ...anchorFor(anchorElement, selected || undefined), ...nodeRef }],
    });
    selection?.removeAllRanges();
  },
  true,
);

// --- suggest mode: the human types the words -------------------------------
//
// "Change 'leverage' to 'use'" is a round trip and an ambiguity; the replacement
// text is neither. So suggest mode lets the human type the exact words they
// want and sends those.
//
// The document must NOT keep the typed text. The artifact is agent-owned and
// this is a *proposal*: leaving it in place would mean the DOM no longer matches
// the file on disk, so the next morph would fight the human's edit, and the
// change attribution would credit the agent with words it never wrote. The
// original markup is restored the instant the edit is committed.

let suggestMode = false;
let editing: { element: Element; original: string; markup: string } | null = null;

function setSuggest(next: boolean): void {
  if (!next) finishSuggest(false);
  suggestMode = next;
  document.documentElement.classList.toggle("pe-suggest", next);
  clearHover();
}

function beginSuggest(element: Element): void {
  if (editing) return;
  const original = fullTextOf(element);
  // Nothing to replace verbatim. Silently doing nothing here would read as a
  // dead click, so say why.
  if (!original) {
    showHint("Nothing to edit here — pick an element with text");
    setTimeout(hideHint, 1800);
    return;
  }

  editing = { element, original, markup: element.innerHTML };
  element.setAttribute("contenteditable", "plaintext-only");
  // `plaintext-only` is not universal; where it is unrecognised the element is
  // not editable at all, which looks exactly like a broken feature.
  if (element instanceof HTMLElement && !element.isContentEditable) {
    element.setAttribute("contenteditable", "true");
  }
  element.classList.add(EDITING_CLASS);
  clearHover();
  showHint("Type your replacement · Enter to propose · Esc to cancel");

  if (element instanceof HTMLElement) element.focus();
  const range = document.createRange();
  range.selectNodeContents(element);
  range.collapse(false);
  const selection = window.getSelection();
  selection?.removeAllRanges();
  selection?.addRange(range);
}

function finishSuggest(commit: boolean): void {
  if (!editing) return;
  // Cleared first: restoring the markup below blurs the element, and the
  // resulting `focusout` would otherwise re-enter this function.
  const { element, original, markup } = editing;
  editing = null;

  const proposed = fullTextOf(element);
  element.removeAttribute("contenteditable");
  element.classList.remove(EDITING_CLASS);
  hideHint();
  if (element.innerHTML !== markup) element.innerHTML = markup;
  if (element instanceof HTMLElement) element.blur();
  invalidateCandidates();

  if (!commit || !proposed || proposed === original) return;

  const clientId = newClientId();
  pending.set(clientId, { id: clientId, elements: [element] });
  element.classList.add(PENDING_CLASS);
  post({
    type: "pe:annotate",
    clientId,
    kind: "verbatim",
    replacement: proposed,
    // The anchor is the text as the agent last wrote it, not as the human just
    // typed it — the agent has to find the passage in its own document.
    anchors: [anchorFor(element, original)],
  });
}

// Guarded on the target, not merely on `editing`: focusing the element also
// fires a focusout at whatever held focus before it, so an unguarded listener
// committed and closed the suggestion in the same tick it opened — the element
// flashed editable and immediately was not.
document.addEventListener(
  "focusout",
  (event) => {
    if (editing && event.target === editing.element) finishSuggest(true);
  },
  true,
);

// --- structural gestures ----------------------------------------------------
//
// "Move Risks above Milestones but leave the intro" is an id-set operation
// dressed up as a sentence, and the agent has to parse it back out. Pointing at
// the two elements says it exactly.

type StructuralKind = "delete" | "move-before" | "move-after" | "split" | "merge";

const STRUCTURAL_KINDS: StructuralKind[] = ["delete", "move-before", "move-after", "split", "merge"];
/** Kinds that need a second click for the other element involved. */
const TWO_STEP = new Set<StructuralKind>(["move-before", "move-after", "merge"]);

const GESTURE_HINT: Record<StructuralKind, [string, string]> = {
  delete: ["Click the element to delete", ""],
  split: ["Click the element to split", ""],
  "move-before": ["Click the element to move", "Now click what it should go before"],
  "move-after": ["Click the element to move", "Now click what it should go after"],
  merge: ["Click the first element", "Now click the one to merge it with"],
};

let structural: { kind: StructuralKind; subject: Element | null } | null = null;

function setStructural(kind: StructuralKind | null): void {
  structural?.subject?.classList.remove(SUBJECT_CLASS);
  structural = kind ? { kind, subject: null } : null;
  const root = document.documentElement;
  root.classList.toggle("pe-structural", Boolean(kind));
  // A distinct class per kind, so the hover treatment tells the human which
  // gesture is armed. An armed delete that looked like an armed move is a
  // destructive click made on a wrong assumption.
  for (const candidate of STRUCTURAL_KINDS) root.classList.toggle(`pe-op-${candidate}`, kind === candidate);
  clearHover();
  if (kind) showHint(GESTURE_HINT[kind][0]);
  else hideHint();
}

function handleStructuralClick(element: Element): void {
  if (!structural) return;
  const { kind } = structural;

  if (!TWO_STEP.has(kind)) {
    postStructural(element, { kind });
    endGesture("structural", "completed");
    return;
  }

  if (!structural.subject) {
    structural.subject = element;
    element.classList.add(SUBJECT_CLASS);
    showHint(GESTURE_HINT[kind][1]);
    return;
  }

  const subject = structural.subject;
  // Moving something relative to itself is a no-op the agent would have to
  // reason about; ignore the click and leave the gesture armed.
  if (subject === element) return;
  postStructural(subject, {
    kind,
    targetSelector: selectorFor(element),
    targetText: snippetFor(element),
  });
  endGesture("structural", "completed");
}

function postStructural(subject: Element, op: { kind: StructuralKind; targetSelector?: string; targetText?: string }): void {
  const clientId = newClientId();
  pending.set(clientId, { id: clientId, elements: [subject] });
  subject.classList.add(PENDING_CLASS);
  post({ type: "pe:annotate", clientId, kind: "structural", op, anchors: [anchorFor(subject)] });
}

/**
 * Ends whichever gesture is armed and tells the chrome.
 *
 * The chrome cannot see our key events (no `allow-same-origin`), so an Escape
 * pressed over the artifact left its toolbar button lit with nothing behind it —
 * the human then clicked expecting a gesture that had already been cancelled.
 */
function endGesture(gesture: "structural" | "suggest" | "repoint", reason: "completed" | "cancelled"): void {
  const kind = structural?.kind ?? null;
  if (gesture === "structural") setStructural(null);
  if (gesture === "suggest") setSuggest(false);
  if (gesture === "repoint") {
    repointing = null;
    document.documentElement.classList.remove("pe-repoint");
  }
  hideHint();
  post({ type: "pe:gestureEnded", gesture, reason, ...(kind ? { kind } : {}) });
}

// --- hint bar ---------------------------------------------------------------

let hintNode: HTMLElement | null = null;

/** Created and removed rather than toggled with `hidden`: the artifact's own
 *  stylesheet is arbitrary, and any author `display:` rule silently beats the
 *  UA rule behind `[hidden]`, which is how a permanently-visible overlay once
 *  covered a whole page. A node that does not exist cannot be un-hidden. */
function showHint(text: string): void {
  if (!hintNode) {
    hintNode = document.createElement("div");
    hintNode.setAttribute(UI_ATTRIBUTE, "");
    hintNode.className = "pe-hint";
    document.body.appendChild(hintNode);
  }
  hintNode.textContent = text;
}

function hideHint(): void {
  hintNode?.remove();
  hintNode = null;
}

// --- locks ------------------------------------------------------------------
//
// A lock constrains the agent, not the human: clicking one still annotates, and
// the anchor simply carries `locked: true` so the chrome can warn. Blocking the
// click would be the tool telling its user what they are allowed to think about
// their own document.

interface LockSpec extends AnchorSpec {
  id: string;
  label?: string;
}

let locks: LockSpec[] = [];
const lockedElements = new Set<Element>();
const lockBadges: Array<{ node: HTMLElement; element: Element }> = [];
let lockLayer: HTMLElement | null = null;

function isLocked(element: Element): boolean {
  for (let node: Element | null = element; node; node = node.parentElement) {
    if (lockedElements.has(node)) return true;
  }
  return false;
}

/**
 * Badges live in one absolutely-positioned layer appended to `<body>`, never
 * inside the locked element itself.
 *
 * Putting a badge inside the element would leave the live element permanently
 * different from the file: `markupWithoutOurClasses` strips our *classes*, not
 * our nodes, so the extra child makes the element compare as changed on every
 * patch — flashing it and marking every annotation on it addressed. Page
 * coordinates (rect + scroll offset) mean scrolling costs nothing; only resize
 * and reflow need a reposition.
 */
function lockLayerNode(): HTMLElement {
  if (lockLayer?.isConnected) return lockLayer;
  lockLayer = document.createElement("div");
  lockLayer.setAttribute(UI_ATTRIBUTE, "");
  lockLayer.className = "pe-lock-layer";
  document.body.appendChild(lockLayer);
  return lockLayer;
}

function applyLocks(): void {
  for (const element of lockedElements) element.classList.remove(LOCKED_CLASS);
  lockedElements.clear();
  lockBadges.length = 0;
  const layer = lockLayerNode();
  layer.textContent = "";

  for (const lock of locks.slice(0, 100)) {
    const resolution = resolveAnchor(lock);
    // A weakly-resolved lock is not marked at all. Painting "locked" on an
    // element the agent was never told to leave alone teaches the human a rule
    // the agent is not following.
    if (!resolution.element || resolution.score < CONFIDENT) continue;
    resolution.element.classList.add(LOCKED_CLASS);
    lockedElements.add(resolution.element);

    const badge = document.createElement("span");
    badge.setAttribute(UI_ATTRIBUTE, "");
    badge.className = "pe-lock-badge";
    badge.textContent = lock.label ? `locked · ${lock.label}` : "locked";
    layer.appendChild(badge);
    lockBadges.push({ node: badge, element: resolution.element });
  }
  positionLockBadges();
}

function positionLockBadges(): void {
  for (const { node, element } of lockBadges) {
    const rect = element.getBoundingClientRect();
    if (rect.width === 0 && rect.height === 0) {
      node.style.display = "none";
      continue;
    }
    node.style.display = "";
    node.style.top = `${rect.top + window.scrollY}px`;
    node.style.left = `${rect.left + window.scrollX}px`;
  }
}

window.addEventListener("resize", positionLockBadges, { passive: true });

// --- outline ----------------------------------------------------------------

/**
 * The document's headings, for a navigator in the chrome.
 *
 * Past roughly fifteen notes the review panel stops being a list you can scan
 * and becomes one you scroll, and the only structure the human has in their head
 * is the document's own — so the panel borrows it.
 */
function outline(): Array<{ id: string; level: number; text: string }> {
  const sections: Array<{ id: string; level: number; text: string }> = [];
  for (const heading of document.body.querySelectorAll("h1, h2, h3, h4")) {
    if (heading.closest(`[${UI_ATTRIBUTE}]`)) continue;
    const text = fullTextOf(heading).slice(0, 160);
    if (!text) continue;
    // The nearest enclosing id, because scrolling wants something the agent's
    // rewrite is likely to keep — a heading's own id if it has one, else the
    // section that contains it.
    const owner = heading.closest("[id]");
    sections.push({ id: owner?.id ?? "", level: Number(heading.tagName.slice(1)), text });
  }
  return sections;
}

// --- in-document find -------------------------------------------------------

const CHANGE_HIGHLIGHT = "pe-changed-words";
/** Deliberately a different registry name from CHANGE_HIGHLIGHT. Reusing one
 *  name means a search silently erases the highlight showing what the agent
 *  just changed, which is the tool's main output. */
const FIND_HIGHLIGHT = "pe-find-matches";
const MAX_FIND_RANGES = 500;

function highlightRegistry(): Map<string, unknown> | null {
  return (CSS as unknown as { highlights?: Map<string, unknown> }).highlights ?? null;
}

function highlightConstructor(): (new (...ranges: Range[]) => unknown) | null {
  return (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight ?? null;
}

/** Text nodes worth searching or highlighting: the artifact's own, never ours. */
function artifactTextNodes(root: Element): Text[] {
  const nodes: Text[] = [];
  const walker = document.createTreeWalker(root, NodeFilter.SHOW_TEXT, {
    acceptNode: (node: Node) => {
      const parent = node.parentElement;
      if (!parent) return NodeFilter.FILTER_REJECT;
      if (SKIP_TAGS.has(parent.tagName)) return NodeFilter.FILTER_REJECT;
      if (parent.closest(`[${UI_ATTRIBUTE}]`)) return NodeFilter.FILTER_REJECT;
      return NodeFilter.FILTER_ACCEPT;
    },
  });
  for (let node = walker.nextNode(); node; node = walker.nextNode()) nodes.push(node as Text);
  return nodes;
}

function runFind(query: string): number {
  const registry = highlightRegistry();
  const Ctor = highlightConstructor();
  const needle = query.trim().toLowerCase();
  if (!needle) {
    registry?.delete(FIND_HIGHLIGHT);
    return 0;
  }

  const ranges: Range[] = [];
  for (const node of artifactTextNodes(document.body)) {
    const haystack = (node.textContent ?? "").toLowerCase();
    let from = 0;
    for (;;) {
      const at = haystack.indexOf(needle, from);
      if (at === -1) break;
      const range = document.createRange();
      range.setStart(node, at);
      range.setEnd(node, at + needle.length);
      ranges.push(range);
      from = at + needle.length;
      if (ranges.length >= MAX_FIND_RANGES) break;
    }
    if (ranges.length >= MAX_FIND_RANGES) break;
  }

  // Count and scroll even without the Highlight API — a count with no colour is
  // still an answer, whereas a silent no-op reads as a broken search box.
  if (registry && Ctor) {
    if (ranges.length) registry.set(FIND_HIGHLIGHT, new Ctor(...ranges));
    else registry.delete(FIND_HIGHLIGHT);
  }
  const first = ranges[0];
  if (first) scrollTo(nearestElement(first.startContainer));
  return ranges.length;
}

/**
 * Scrolling is best-effort and must never take the reply down with it.
 *
 * `pe:find` and `pe:scrollTo` both answer the chrome *after* scrolling, so a
 * throw here (an artifact that shadows `scrollIntoView`, an element detached
 * between resolution and scroll) does not merely fail to scroll — it swallows
 * the reply, and the chrome's search box waits forever for a count that is
 * already computed.
 */
function scrollTo(element: Element | null): void {
  if (!element || typeof element.scrollIntoView !== "function") return;
  try {
    element.scrollIntoView({ behavior: "smooth", block: "center" });
  } catch {
    // A stale layout is not worth a failed message.
  }
}

// --- change highlighting ----------------------------------------------------

let highlightTimer: number | undefined;

/**
 * Highlights only the words that actually changed, using the CSS Custom
 * Highlight API so nothing in the artifact's DOM is touched — wrapping words in
 * spans would mutate content the next morph has to diff, and would show up in
 * exports.
 *
 * Falls back to flashing the whole element where the API is unavailable. That
 * fallback was described in this comment for several revisions without existing:
 * on a browser without `CSS.highlights` the tool reported a successful patch and
 * showed the human absolutely nothing, which is indistinguishable from a morph
 * that silently did nothing at all.
 */
function highlightChanges(changes: TextChange[]): void {
  const registry = highlightRegistry();
  const Ctor = highlightConstructor();

  const changedWords = changes.map((change) => ({
    element: change.element,
    added: diffWords(change.before, change.after)
      .filter((op) => op.type === "add")
      .map((op) => op.text.trim())
      .filter(Boolean),
  }));

  if (!registry || !Ctor) {
    for (const change of changedWords) {
      if (change.added.length === 0) continue;
      flashElement(change.element);
    }
    return;
  }

  const ranges: Range[] = [];
  for (const change of changedWords) {
    if (change.added.length === 0) continue;
    ranges.push(...rangesForWords(change.element, change.added));
  }

  // No words changed means nothing worth pointing at. Flashing the enclosing
  // block instead is how a one-word edit came to paint a whole section green.
  if (ranges.length === 0) return;

  registry.set(CHANGE_HIGHLIGHT, new Ctor(...ranges));
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => registry.delete(CHANGE_HIGHLIGHT), 2400) as unknown as number;
}

function flashElement(element: Element): void {
  element.classList.add(HIGHLIGHT_CLASS);
  setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), 1600);
}

/** Ranges covering each added word inside `element`, walking its text nodes. */
function rangesForWords(element: Element, words: string[]): Range[] {
  const ranges: Range[] = [];
  const walker = document.createTreeWalker(element, NodeFilter.SHOW_TEXT);
  const needles = words.slice(0, 200);

  for (let node = walker.nextNode(); node; node = walker.nextNode()) {
    const text = node.textContent ?? "";
    for (const word of needles) {
      let from = 0;
      for (;;) {
        const at = text.indexOf(word, from);
        if (at === -1) break;
        const range = document.createRange();
        range.setStart(node, at);
        range.setEnd(node, at + word.length);
        ranges.push(range);
        from = at + word.length;
        if (ranges.length > 400) return ranges;
      }
    }
  }
  return ranges;
}

/** Applies new artifact HTML in place and highlights what actually changed. */
function applyMorph(html: string): { addressed: string[]; orphaned: string[] } {
  const result = morphDocument(document.documentElement, html, pending.values());

  invalidateCandidates();
  highlightChanges(result.textChanges);
  // Locks are re-resolved rather than assumed: the agent may have replaced the
  // very element a lock named, and a badge left floating over unlocked prose
  // asserts a constraint nobody is enforcing.
  applyLocks();

  // The agent may have rewritten a diagram's source, and the picture is
  // generated from it rather than contained in the patch. Not awaited: the morph
  // result has to go back to the chrome now, and the first diagram on a page
  // costs a 2.6MB fetch. Every diagram whose source hash is unchanged is skipped,
  // so an edit elsewhere in the document costs one hash apiece.
  //
  // Lock badges are repositioned afterwards because a diagram appearing changes
  // the height of everything below it, and the badges live in page coordinates.
  void refreshDiagrams().then(() => positionLockBadges());

  const settled = new Set([...result.addressed, ...result.orphaned]);
  for (const [clientId, entry] of pending) {
    if (!settled.has(entry.id)) continue;
    for (const element of entry.elements) element.classList.remove(PENDING_CLASS);
    pending.delete(clientId);
    if (armedGroup?.clientId === clientId) armedGroup = null;
  }

  return { addressed: result.addressed, orphaned: result.orphaned };
}

// --- chrome channel ---------------------------------------------------------

window.addEventListener("message", (event: MessageEvent) => {
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    // The artifact is its own document, so it cannot see the chrome's choice.
    // `color-scheme` fixes form controls and scrollbars for free; `data-theme`
    // is what an artifact's own stylesheet can hook into.
    case "pe:theme": {
      const value = String(data.value ?? "system");
      const root = document.documentElement;
      if (value === "system") {
        delete root.dataset.theme;
        root.style.colorScheme = "";
      } else {
        root.dataset.theme = value;
        root.style.colorScheme = value;
      }
      // A diagram's colours are baked into generated SVG rather than resolved
      // from CSS, so it is the one thing on the page that does not follow this
      // for free — it has to be drawn again.
      setDiagramTheme(value);
      break;
    }

    case "pe:setMode":
      setMode(Boolean(data.value));
      break;

    case "pe:bind": {
      // The server assigned a real id; re-key so morph reports use it.
      const clientId = String(data.clientId);
      const found = pendingEntry(clientId);
      if (found) found.entry.id = String(data.id);
      if (armedGroup?.clientId === clientId) armedGroup = null;
      break;
    }

    case "pe:cancel": {
      const clientId = String(data.clientId ?? data.id ?? "");
      const found = pendingEntry(clientId);
      if (found) {
        for (const element of found.entry.elements) element.classList.remove(PENDING_CLASS);
        pending.delete(found.key);
      }
      if (armedGroup?.clientId === clientId) armedGroup = null;
      break;
    }

    // Re-anchors an annotation that was submitted in an earlier page session.
    // Without this the anchor map is empty after any reload, so a morph can
    // never mark those annotations addressed and they stay "waiting for agent"
    // forever even though the agent applied the edit.
    case "pe:track": {
      const id = String(data.id);
      if ([...pending.values()].some((entry) => entry.id === id)) break;
      const specs: AnchorSpec[] =
        Array.isArray(data.anchors) && data.anchors.length
          ? (data.anchors as Array<Record<string, unknown>>).map((entry) => specFrom(entry ?? {}))
          : [specFrom(data)];

      const elements: Element[] = [];
      const nearMisses: Array<{ selector: string; text: string; score: number }> = [];
      let score = 0;
      for (const spec of specs) {
        const resolution = resolveAnchor(spec);
        if (resolution.element && resolution.score >= CONFIDENT) {
          elements.push(resolution.element);
          // The best of the group, mirroring the chunk rule in morph.ts: a
          // multi-element edit counts as addressed when ANY of its elements
          // changed, so its confidence is the confidence of its best anchor.
          score = Math.max(score, resolution.score);
        } else {
          nearMisses.push(...resolution.candidates);
        }
      }

      if (elements.length > 0) {
        pending.set(TRACK_PREFIX + id, { id, elements });
        for (const element of elements) element.classList.add(PENDING_CLASS);
        post({ type: "pe:trackResult", resolved: [{ id, score }], weak: [] });
        break;
      }

      // Deduped by selector: a multi-anchor item scores the same document
      // several times, and offering the human the same paragraph three times
      // as three different choices is worse than offering it once.
      const seen = new Set<string>();
      const ranked: Array<{ selector: string; text: string; score: number }> = [];
      for (const candidate of [...nearMisses].sort((a, b) => b.score - a.score)) {
        if (seen.has(candidate.selector)) continue;
        seen.add(candidate.selector);
        ranked.push(candidate);
        if (ranked.length >= MAX_WEAK) break;
      }
      // Reported even when empty: "we could not find this" is information the
      // chrome must show. Saying nothing leaves the note looking tracked.
      post({ type: "pe:trackResult", resolved: [], weak: [{ id, candidates: ranked }] });
      break;
    }

    // Version scrubbing: morph to an arbitrary snapshot for preview, without
    // touching annotation state or reporting anything back.
    case "pe:preview": {
      // A preview is a different version of the document, so a half-typed
      // suggestion has nothing left to attach to. Drop it rather than propose
      // words the human never finished.
      finishSuggest(false);
      try {
        morphDocument(document.documentElement, String(data.html), []);
        invalidateCandidates();
        positionLockBadges();
        // A preview is a different revision of the document, so a diagram
        // rendered from the live source is now a picture of text the page no
        // longer contains — which is the one thing a version preview must not
        // show.
        void refreshDiagrams().then(() => positionLockBadges());
      } catch (error) {
        post({ type: "pe:morphFailed", message: String(error) });
      }
      break;
    }

    case "pe:morph": {
      // An agent patch landing mid-suggestion commits it rather than discarding
      // it: the human's typed words are recoverable from a proposal they can
      // cancel, and unrecoverable if we throw them away.
      finishSuggest(true);
      try {
        const result = applyMorph(String(data.html));
        post({ type: "pe:morphed", ...result });
      } catch (error) {
        // Morphing is a heuristic over arbitrary agent-written HTML. If it ever
        // throws, fall back to the thing that always works.
        post({ type: "pe:morphFailed", message: String(error) });
      }
      break;
    }

    // Locate by tracked anchor first; fall back to the stored anchor so
    // settled annotations (which are no longer tracked) still jump.
    case "pe:scrollTo": {
      const id = String(data.id ?? "");
      const tracked = [...pending.values()].find((entry) => entry.id === id);
      const resolution = tracked ? null : resolveAnchor(specFrom(data));
      // A weak resolution is good enough to scroll to — landing near the right
      // place is useful, and unlike tracking it changes nothing.
      const element = tracked?.elements[0] ?? (resolution && resolution.score >= WEAK_FLOOR ? resolution.element : null);
      if (!element) break;
      scrollTo(element);
      flashElement(element);
      break;
    }

    case "pe:repoint": {
      repointing = data.id ? String(data.id) : null;
      document.documentElement.classList.toggle("pe-repoint", Boolean(repointing));
      if (repointing) showHint("Click the element this note belongs to");
      else hideHint();
      break;
    }

    case "pe:suggest":
      setSuggest(Boolean(data.value));
      break;

    case "pe:structural": {
      const kind = String(data.kind ?? "") as StructuralKind;
      setStructural(STRUCTURAL_KINDS.includes(kind) ? kind : null);
      break;
    }

    case "pe:locks": {
      locks = (Array.isArray(data.locks) ? data.locks : []).map((entry) => {
        const raw = (entry ?? {}) as Record<string, unknown>;
        return {
          id: String(raw.id ?? ""),
          ...specFrom(raw),
          ...(typeof raw.label === "string" ? { label: raw.label } : {}),
        };
      });
      applyLocks();
      break;
    }

    case "pe:outline":
      post({ type: "pe:outlined", sections: outline() });
      break;

    case "pe:find":
      post({ type: "pe:found", count: runFind(String(data.query ?? "")) });
      break;
  }
});

// Chrome and artifact cannot see each other's key events (no allow-same-origin),
// so the hotkey needs a listener on both sides. This side just relays.
document.addEventListener(
  "keydown",
  (event) => {
    if (editing) {
      if (event.key === "Escape") {
        event.preventDefault();
        finishSuggest(false);
      } else if (event.key === "Enter" && !event.shiftKey) {
        // Enter proposes; Shift-Enter is a newline, because a replacement can
        // legitimately be two paragraphs.
        event.preventDefault();
        finishSuggest(true);
      }
      return;
    }

    if (event.key === "Escape") {
      if (structural) return endGesture("structural", "cancelled");
      if (suggestMode) return endGesture("suggest", "cancelled");
      if (repointing) return endGesture("repoint", "cancelled");
      // Nothing armed in the document, but a half-made note might be.
      if (clearArmed()) return;
      post({ type: "pe:key", key: "Escape", meta: false, shift: false });
      return;
    }

    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      post({ type: "pe:toggleMode" });
      return;
    }

    // Everything else the chrome binds has to be relayed too.
    //
    // Only Cmd-I ever was, so every other shortcut died the moment focus
    // entered the artifact — which is immediately, because clicking the
    // document is the primary interaction. j/k, a/r/u, the overlays, undo:
    // all of them looked broken in exactly the situation you would use them.
    if (typingInArtifact(event)) return;
    const key = event.key;
    const meta = event.metaKey || event.ctrlKey;
    const relay = meta ? META_KEYS.has(key.toLowerCase()) || key === "Enter" : PLAIN_KEYS.has(key);
    if (!relay) return;
    // The chrome cannot preventDefault on an event in this document, so the
    // browser's own binding (Cmd-F, quick-find on "/") has to be stopped here.
    event.preventDefault();
    post({ type: "pe:key", key, meta, shift: event.shiftKey });
  },
  true,
);

/**
 * Chrome shortcuts that take a modifier.
 *
 * Adding a chrome shortcut means adding it here too. There is no way for the
 * chrome alone to notice it is missing: the binding simply does nothing from the
 * moment focus enters the artifact, which is immediately, because clicking the
 * document is the primary interaction.
 */
const META_KEYS = new Set(["e", "f", "k", "z", "h", "\\"]);
/** Chrome shortcuts that are a bare key, and so must never fire mid-typing. */
const PLAIN_KEYS = new Set(["j", "k", "a", "r", "u", "n", ".", "/", "?", "Enter", "ArrowLeft", "ArrowRight"]);

/**
 * True when the keystroke belongs to a field in the artifact rather than to the
 * chrome. An artifact can legitimately contain inputs, and `j` typed into one
 * must not scroll the review list.
 */
function typingInArtifact(event: KeyboardEvent): boolean {
  const target = event.target as HTMLElement | null;
  if (!target) return false;
  if (["INPUT", "TEXTAREA", "SELECT"].includes(target.tagName)) return true;
  return typeof target.closest === "function" && Boolean(target.closest("[contenteditable]"));
}

const style = document.createElement("style");
style.setAttribute(UI_ATTRIBUTE, "");
style.textContent = `
.pe-annotate, .pe-annotate * { cursor: crosshair !important; }
.pe-repoint, .pe-repoint * { cursor: cell !important; }
.pe-suggest, .pe-suggest * { cursor: text !important; }
.pe-structural, .pe-structural * { cursor: pointer !important; }
.pe-repoint .pe-hover { outline-color: #f59e0b !important; }
.pe-annotate .pe-hover { outline: 2px solid #6366f1 !important; outline-offset: 2px; background: rgba(99,102,241,.06) !important; }
.pe-suggest .pe-hover { outline: 2px solid #10b981 !important; outline-offset: 2px; background: rgba(16,185,129,.06) !important; }

/* One treatment per armed gesture. A delete that hovers like a move is a
   destructive click made on a wrong assumption. */
.pe-op-delete .pe-hover { outline: 2px solid #ef4444 !important; outline-offset: 2px; background: rgba(239,68,68,.08) !important; text-decoration: line-through !important; }
.pe-op-split .pe-hover { outline: 2px dashed #a855f7 !important; outline-offset: 2px; background: linear-gradient(transparent 48%, rgba(168,85,247,.5) 48%, rgba(168,85,247,.5) 52%, transparent 52%) !important; }
.pe-op-move-before .pe-hover { outline: 2px solid #3b82f6 !important; outline-offset: 2px; border-top: 3px solid #3b82f6 !important; }
.pe-op-move-after .pe-hover { outline: 2px solid #3b82f6 !important; outline-offset: 2px; border-bottom: 3px solid #3b82f6 !important; }
.pe-op-merge .pe-hover { outline: 2px solid #14b8a6 !important; outline-offset: 2px; background: rgba(20,184,166,.08) !important; }
.${SUBJECT_CLASS} { outline: 2px solid #3b82f6 !important; outline-offset: 3px; background: rgba(59,130,246,.10) !important; }

.${EDITING_CLASS} { outline: 2px solid #10b981 !important; outline-offset: 3px; background: rgba(16,185,129,.08) !important; cursor: text !important; }
/* Scoped to annotate mode on purpose. The marks are an annotating affordance,
   so leaving the mode has to leave a clean document — otherwise the outlines
   outlive the toolbar that explains them, and a reader who toggled annotate off
   is still looking at a marked-up page with no way to unmark it. Tracking is by
   live element reference, not by this class, so hiding it costs nothing. */
.pe-annotate .${PENDING_CLASS} { outline: 2px dashed #f59e0b !important; outline-offset: 2px; animation: pe-pulse 1.6s ease-in-out infinite; }
.${HIGHLIGHT_CLASS} { animation: pe-flash 1.6s ease-out; }
.${LOCKED_CLASS} { outline: 1px dashed rgba(100,116,139,.7) !important; outline-offset: 4px; }

.pe-hint {
  position: fixed; left: 50%; bottom: 16px; transform: translateX(-50%);
  z-index: 2147483000; pointer-events: none;
  font: 500 12px/1.4 ui-sans-serif, system-ui, sans-serif;
  color: #f8fafc; background: rgba(15,23,42,.92);
  padding: 6px 12px; border-radius: 999px; box-shadow: 0 6px 20px rgba(0,0,0,.28);
}
.pe-lock-layer { position: absolute; top: 0; left: 0; width: 0; height: 0; pointer-events: none; z-index: 2147482000; }
.pe-lock-badge {
  position: absolute; transform: translateY(-100%);
  font: 600 10px/1 ui-sans-serif, system-ui, sans-serif; letter-spacing: .04em; text-transform: uppercase;
  color: #f8fafc; background: rgba(71,85,105,.92);
  padding: 3px 6px; border-radius: 4px; white-space: nowrap;
}

::highlight(${CHANGE_HIGHLIGHT}) {
  background-color: rgba(34,197,94,.42);
  color: inherit;
}
::highlight(${FIND_HIGHLIGHT}) {
  background-color: rgba(250,204,21,.55);
  color: inherit;
}
@keyframes pe-pulse { 0%,100% { outline-color: #f59e0b; } 50% { outline-color: rgba(245,158,11,.25); } }
@keyframes pe-flash {
  0% { background-color: rgba(34,197,94,.35); }
  100% { background-color: transparent; }
}
@media (prefers-reduced-motion: reduce) {
  .${PENDING_CLASS}, .${HIGHLIGHT_CLASS} { animation: none; }
}
`;
document.head.appendChild(style);

// First render. `refreshDiagrams` returns immediately for a document with no
// diagram in it, which is most of them — nothing is fetched, no stylesheet is
// injected, and no listener is registered until one is actually found.
void refreshDiagrams();

post({ type: "pe:ready" });
