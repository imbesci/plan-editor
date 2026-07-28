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

function post(message: unknown): void {
  parent.postMessage(message, "*");
}

// --- selector derivation (agent hint only) ---------------------------------

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

function describe(elements: Element[]): Array<{ selector: string; text: string }> {
  return elements.map((element) => ({ selector: selectorFor(element), text: snippetFor(element) }));
}

function snippetFor(element: Element): string {
  return (element.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, 300);
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

function setMode(next: boolean): void {
  annotateMode = next;
  document.documentElement.classList.toggle("pe-annotate", next);
  clearHover();
}

function clearHover(): void {
  hoverTarget?.classList.remove("pe-hover");
  hoverTarget = null;
}

document.addEventListener(
  "mousemove",
  (event) => {
    if (!annotateMode) return;
    const target = event.target;
    if (!(target instanceof Element) || isInteractive(target)) return clearHover();
    const element = annotationTarget(target);
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
    if (!annotateMode) return;
    const target = event.target;
    if (!(target instanceof Element) || isInteractive(target)) return;
    event.preventDefault();
    event.stopPropagation();
    // A live text selection is a more precise statement of intent than the
    // element containing it, so it wins when one exists.
    const selection = window.getSelection();
    const selected = selection && !selection.isCollapsed ? selection.toString().replace(/\s+/g, " ").trim() : "";
    const anchorElement =
      selected && selection
        ? nearestElement(selection.getRangeAt(0).commonAncestorContainer) ?? annotationTarget(target)
        : annotationTarget(target);

    if (repointing) {
      post({
        type: "pe:repointed",
        id: repointing,
        selector: selectorFor(anchorElement),
        text: selected || snippetFor(anchorElement),
      });
      repointing = null;
      document.documentElement.classList.remove("pe-repoint");
      return;
    }

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
      post({ type: "pe:annotate", clientId: armedGroup.clientId, kind: "element", anchors: describe(armedGroup.elements) });
      selection?.removeAllRanges();
      return;
    }

    const clientId = `c${Math.random().toString(36).slice(2, 10)}`;
    armedGroup = { clientId, elements: [anchorElement] };
    pending.set(clientId, { id: clientId, elements: [anchorElement] });
    anchorElement.classList.add(PENDING_CLASS);
    post({
      type: "pe:annotate",
      clientId,
      kind: selected ? "text" : "element",
      anchors: selected
        ? [{ selector: selectorFor(anchorElement), text: selected }]
        : describe([anchorElement]),
    });
    selection?.removeAllRanges();
  },
  true,
);

// --- morph engine -----------------------------------------------------------

/**
 * Best-effort re-anchor for an annotation created in a previous page session.
 * Selector first (exact when the agent kept ids stable), then a text match so a
 * restructured document still finds its target.
 */
function resolveAnchor(selector: string, text: string): Element | null {
  if (selector) {
    try {
      const found = document.querySelector(selector);
      if (found) return found;
    } catch {
      // Malformed stored selector; fall through to text matching.
    }
  }
  const needle = text.trim();
  if (!needle) return null;
  for (const candidate of document.body.querySelectorAll("*")) {
    if (candidate.hasAttribute(UI_ATTRIBUTE)) continue;
    if ((candidate.textContent ?? "").replace(/\s+/g, " ").trim() === needle) return candidate;
  }
  return null;
}

const HIGHLIGHT_NAME = "pe-changed-words";
let highlightTimer: number | undefined;

/**
 * Highlights only the words that actually changed, using the CSS Custom
 * Highlight API so nothing in the artifact's DOM is touched — wrapping words in
 * spans would mutate content the next morph has to diff, and would show up in
 * exports.
 *
 * Falls back to flashing the whole element where the API is unavailable.
 */
function highlightChanges(changes: TextChange[], fallback: Element[]): void {
  const highlights = (CSS as unknown as { highlights?: Map<string, unknown> }).highlights;
  const HighlightCtor = (window as unknown as { Highlight?: new (...ranges: Range[]) => unknown }).Highlight;

  if (!highlights || !HighlightCtor) {
    for (const element of fallback) {
      element.classList.add(HIGHLIGHT_CLASS);
      setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), 1600);
    }
    return;
  }

  const ranges: Range[] = [];
  for (const change of changes) {
    const added = diffWords(change.before, change.after)
      .filter((op) => op.type === "add")
      .map((op) => op.text.trim())
      .filter(Boolean);
    if (added.length === 0) continue;
    ranges.push(...rangesForWords(change.element, added));
  }

  if (ranges.length === 0) {
    // The element changed but its text did not (an attribute, a reordering).
    // Flash the block rather than claiming nothing happened.
    for (const element of fallback) {
      element.classList.add(HIGHLIGHT_CLASS);
      setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), 1600);
    }
    return;
  }

  highlights.set(HIGHLIGHT_NAME, new HighlightCtor(...ranges));
  clearTimeout(highlightTimer);
  highlightTimer = setTimeout(() => highlights.delete(HIGHLIGHT_NAME), 2400) as unknown as number;
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

  highlightChanges(result.textChanges, result.changed);

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
    case "pe:setMode":
      setMode(Boolean(data.value));
      break;

    case "pe:bind": {
      // The server assigned a real id; re-key so morph reports use it.
      const clientId = String(data.clientId);
      const entry = pending.get(clientId);
      if (entry) entry.id = String(data.id);
      if (armedGroup?.clientId === clientId) armedGroup = null;
      break;
    }

    case "pe:cancel": {
      const clientId = String(data.clientId);
      for (const element of pending.get(clientId)?.elements ?? []) element.classList.remove(PENDING_CLASS);
      pending.delete(clientId);
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
      const specs = Array.isArray(data.anchors) && data.anchors.length
        ? (data.anchors as Array<{ selector?: string; text?: string }>)
        : [{ selector: String(data.selector ?? ""), text: String(data.text ?? "") }];
      const elements = specs
        .map((spec) => resolveAnchor(String(spec.selector ?? ""), String(spec.text ?? "")))
        .filter((element): element is Element => Boolean(element));
      if (elements.length === 0) break;
      pending.set(`s:${id}`, { id, elements });
      for (const element of elements) element.classList.add(PENDING_CLASS);
      break;
    }

    // Version scrubbing: morph to an arbitrary snapshot for preview, without
    // touching annotation state or reporting anything back.
    case "pe:preview": {
      try {
        morphDocument(document.documentElement, String(data.html), []);
      } catch (error) {
        post({ type: "pe:morphFailed", message: String(error) });
      }
      break;
    }

    case "pe:morph": {
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

    // Locate by tracked anchor first; fall back to the stored selector so
    // settled annotations (which are no longer tracked) still jump.
    case "pe:scrollTo": {
      const id = String(data.id ?? "");
      const tracked = [...pending.values()].find((entry) => entry.id === id);
      const element = tracked?.elements[0] ?? resolveAnchor(String(data.selector ?? ""), String(data.text ?? ""));
      if (!element) break;
      element.scrollIntoView({ behavior: "smooth", block: "center" });
      element.classList.add(HIGHLIGHT_CLASS);
      setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), 1600);
      break;
    }

    case "pe:repoint": {
      repointing = data.id ? String(data.id) : null;
      document.documentElement.classList.toggle("pe-repoint", Boolean(repointing));
      break;
    }
  }
});

// Chrome and artifact cannot see each other's key events (no allow-same-origin),
// so the hotkey needs a listener on both sides. This side just relays.
document.addEventListener(
  "keydown",
  (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      post({ type: "pe:toggleMode" });
    }
  },
  true,
);

const style = document.createElement("style");
style.setAttribute(UI_ATTRIBUTE, "");
style.textContent = `
.pe-annotate, .pe-annotate * { cursor: crosshair !important; }
.pe-repoint, .pe-repoint * { cursor: cell !important; }
.pe-repoint .pe-hover { outline-color: #f59e0b !important; }
.pe-annotate .pe-hover { outline: 2px solid #6366f1 !important; outline-offset: 2px; background: rgba(99,102,241,.06) !important; }
.${PENDING_CLASS} { outline: 2px dashed #f59e0b !important; outline-offset: 2px; animation: pe-pulse 1.6s ease-in-out infinite; }
.${HIGHLIGHT_CLASS} { animation: pe-flash 1.6s ease-out; }
::highlight(${HIGHLIGHT_NAME}) {
  background-color: rgba(34,197,94,.42);
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

post({ type: "pe:ready" });
