// The morph engine, kept pure so it can be tested against a DOM without a
// browser. sdk.ts is a thin wrapper that supplies the live document and wires
// the postMessage channel.

import { Idiomorph } from "idiomorph";

export const UI_ATTRIBUTE = "data-pe-ui";

export interface TrackedAnchor {
  /** Server-assigned annotation id once bound, client id before that. */
  id: string;
  /**
   * Every element this edit covers. Usually one, but an edit can span a chunk
   * of the document ("tighten all four of these") — in which case it counts as
   * addressed when *any* of them changed, and orphaned only when all are gone.
   */
  elements: Element[];
}

export interface TextChange {
  element: Element;
  before: string;
  after: string;
}

export interface MorphResult {
  /** Tracked anchors whose own markup changed — the agent addressed them. */
  addressed: string[];
  /** Tracked anchors whose element no longer exists. */
  orphaned: string[];
  /** Deepest changed elements, for highlighting. */
  changed: Element[];
  /**
   * Before/after text for each changed element, captured during the walk — the
   * old text is gone by the time the morph returns. Lets the caller highlight
   * the words that actually changed instead of flooding a whole paragraph.
   */
  textChanges: TextChange[];
}

function isUiNode(node: Node): boolean {
  return (
    typeof (node as Element).hasAttribute === "function" && (node as Element).hasAttribute(UI_ATTRIBUTE)
  );
}

/**
 * html/head/body are never a useful "change". Idiomorph passes the callback a
 * normalized *clone* of the element it is morphing into — not the live node — so
 * identity comparison cannot exclude them, and they always compare as different
 * even for an identical document. Recording one would flash the entire page on
 * every patch and mark every open edit addressed. Their descendants report the
 * real edit anyway.
 */
function isStructuralRoot(element: Element): boolean {
  const name = element.nodeName;
  return name === "HTML" || name === "HEAD" || name === "BODY";
}

/**
 * Our own classes (`pe-pending` on a tracked anchor, `pe-hover`, `pe-changed`)
 * live on the artifact's real elements, so the live DOM always differs from the
 * file in ways the agent had nothing to do with. Comparing without them is what
 * stops the tool highlighting its own bookkeeping — which flooded whole sections
 * green on every patch.
 */
function markupWithoutOurClasses(element: Element): string {
  if (!/\bpe-[a-z]/.test(element.className || "") && !/\bpe-[a-z]/.test(element.innerHTML)) {
    return element.outerHTML;
  }
  const clone = element.cloneNode(true) as Element;
  for (const node of [clone, ...clone.querySelectorAll("[class]")]) {
    const kept = (node.getAttribute("class") ?? "")
      .split(/\s+/)
      .filter((name) => name && !name.startsWith("pe-"))
      .join(" ");
    if (kept) node.setAttribute("class", kept);
    else node.removeAttribute("class");
  }
  return clone.outerHTML;
}

function isSdkScript(node: Node): boolean {
  const element = node as Element;
  return element.nodeName === "SCRIPT" && (element.getAttribute?.("src") ?? "").endsWith("/sdk.js");
}

/**
 * Applies `html` to `root` in place and reports what actually changed.
 *
 * "Changed" means an element's own serialized markup differs — not merely that
 * idiomorph visited it. Every ancestor of an edit also differs, so the highlight
 * set is narrowed to the deepest changed elements while the addressed check uses
 * the full set (an annotation on a section is addressed when anything inside it
 * changed).
 */
export function morphDocument(root: Element, html: string, tracked: Iterable<TrackedAnchor>): MorphResult {
  const changed = new Set<Element>();
  const textBefore = new Map<Element, { before: string; after: string }>();
  const ownerDocument = root.ownerDocument;

  // Morph <head> and <body> separately rather than replacing <html> wholesale.
  //
  // Morphing documentElement with morphStyle "outerHTML" passes jsdom but fails
  // in a real browser ("newContent is not iterable"), and because idiomorph
  // mutates as it walks, a mid-walk throw leaves the document half-destroyed —
  // a blank page, not a clean failure. Head/body innerHTML morphs never touch
  // the root and were the only variant that survived a real-browser check.
  const parsed = new DOMParser().parseFromString(html, "text/html");
  const ownerDoc = ownerDocument ?? root.ownerDocument;
  const liveHead = ownerDoc?.head ?? root.querySelector("head");
  const liveBody = ownerDoc?.body ?? root.querySelector("body");

  const options = {
    morphStyle: "innerHTML" as const,
    // NOT `ignoreActive` — that skips the active element and its whole subtree,
    // and with nothing focused the active element is <body>, so the entire page
    // would silently refuse to morph. `ignoreActiveValue` preserves what the
    // user is typing in a focused field without skipping anything.
    ignoreActiveValue: true,
    callbacks: {
      beforeNodeMorphed: (oldNode: Node, newNode: Node) => {
        // Never let a morph disturb our own injected UI or the SDK script tag.
        if (isUiNode(oldNode) || isSdkScript(oldNode)) return false;
        const oldElement = oldNode as Element;
        const newElement = newNode as Element;
        if (oldElement.outerHTML === undefined || newElement.outerHTML === undefined) return true;
        // Identical subtree: skip entirely. Saves work and keeps it out of the
        // changed set, which is what makes the highlight precise.
        if (markupWithoutOurClasses(oldElement) === markupWithoutOurClasses(newElement)) return false;
        if (!isStructuralRoot(oldElement)) {
          changed.add(oldElement);
          // Captured here because the old text no longer exists once the walk
          // has moved past this node.
          textBefore.set(oldElement, {
            before: (oldElement.textContent ?? "").replace(/\s+/g, " ").trim(),
            after: (newElement.textContent ?? "").replace(/\s+/g, " ").trim(),
          });
        }
        return true;
      },
      beforeNodeRemoved: (node: Node) => !isUiNode(node),
    },
  };

  if (liveHead && parsed.head) Idiomorph.morph(liveHead, parsed.head, options);
  if (liveBody && parsed.body) Idiomorph.morph(liveBody, parsed.body, options);

  const changedList = [...changed];
  const deepest = changedList.filter(
    (element) => !changedList.some((other) => other !== element && element.contains(other)),
  );

  const addressed: string[] = [];
  const orphaned: string[] = [];
  for (const anchor of tracked) {
    const attached = anchor.elements.filter((element) =>
      ownerDocument ? ownerDocument.contains(element) : root.contains(element),
    );
    if (attached.length === 0) {
      // Report rather than guess. A false "done" silently drops feedback the
      // human cared about, which is worse than asking them to confirm.
      orphaned.push(anchor.id);
      continue;
    }
    if (attached.some((element) => changed.has(element))) addressed.push(anchor.id);
  }

  const textChanges: TextChange[] = [];
  for (const element of deepest) {
    const texts = textBefore.get(element);
    if (texts && texts.before !== texts.after) {
      textChanges.push({ element, before: texts.before, after: texts.after });
    }
  }

  return { addressed, orphaned, changed: deepest, textChanges };
}
