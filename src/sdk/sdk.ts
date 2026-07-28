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

import { morphDocument, UI_ATTRIBUTE, type TrackedAnchor } from "./morph.ts";

const pending = new Map<string, TrackedAnchor>();
let annotateMode = false;
let hoverTarget: Element | null = null;

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
    const element = annotationTarget(target);
    const clientId = `c${Math.random().toString(36).slice(2, 10)}`;
    pending.set(clientId, { id: clientId, element });
    element.classList.add(PENDING_CLASS);
    post({
      type: "pe:annotate",
      clientId,
      selector: selectorFor(element),
      text: snippetFor(element),
      rect: element.getBoundingClientRect().toJSON(),
    });
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

/** Applies new artifact HTML in place and flashes what actually changed. */
function applyMorph(html: string): { addressed: string[]; orphaned: string[] } {
  const result = morphDocument(document.documentElement, html, pending.values());

  for (const element of result.changed) {
    element.classList.add(HIGHLIGHT_CLASS);
    setTimeout(() => element.classList.remove(HIGHLIGHT_CLASS), 1600);
  }

  const settled = new Set([...result.addressed, ...result.orphaned]);
  for (const [clientId, entry] of pending) {
    if (!settled.has(entry.id)) continue;
    entry.element.classList.remove(PENDING_CLASS);
    pending.delete(clientId);
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
      break;
    }

    case "pe:cancel": {
      const entry = pending.get(String(data.clientId));
      entry?.element.classList.remove(PENDING_CLASS);
      pending.delete(String(data.clientId));
      break;
    }

    // Re-anchors an annotation that was submitted in an earlier page session.
    // Without this the anchor map is empty after any reload, so a morph can
    // never mark those annotations addressed and they stay "waiting for agent"
    // forever even though the agent applied the edit.
    case "pe:track": {
      const id = String(data.id);
      if ([...pending.values()].some((entry) => entry.id === id)) break;
      const element = resolveAnchor(String(data.selector ?? ""), String(data.text ?? ""));
      if (!element) break;
      pending.set(`s:${id}`, { id, element });
      element.classList.add(PENDING_CLASS);
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

    case "pe:scrollTo": {
      const entry = pending.get(String(data.clientId));
      entry?.element.scrollIntoView({ behavior: "smooth", block: "center" });
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
.pe-annotate .pe-hover { outline: 2px solid #6366f1 !important; outline-offset: 2px; background: rgba(99,102,241,.06) !important; }
.${PENDING_CLASS} { outline: 2px dashed #f59e0b !important; outline-offset: 2px; animation: pe-pulse 1.6s ease-in-out infinite; }
.${HIGHLIGHT_CLASS} { animation: pe-flash 1.6s ease-out; }
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
