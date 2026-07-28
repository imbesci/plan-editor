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

export interface MorphResult {
  /** Tracked anchors whose own markup changed — the agent addressed them. */
  addressed: string[];
  /** Tracked anchors whose element no longer exists. */
  orphaned: string[];
  /** Deepest changed elements, for highlighting. */
  changed: Element[];
}

function isUiNode(node: Node): boolean {
  return (
    typeof (node as Element).hasAttribute === "function" && (node as Element).hasAttribute(UI_ATTRIBUTE)
  );
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
  const ownerDocument = root.ownerDocument;

  // Parse to a node rather than handing idiomorph the raw string. Artifact files
  // start with a doctype, and morphing <html> from a string that carries one
  // raises HierarchyRequestError ("Invalid insertion of html node in #document
  // node") because the doctype comes along with the parsed fragment.
  const incoming = new DOMParser().parseFromString(html, "text/html").documentElement;

  Idiomorph.morph(root, incoming, {
    morphStyle: "outerHTML",
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
        if (oldElement.outerHTML === newElement.outerHTML) return false;
        // The root is never a useful "change": idiomorph hands us a normalized
        // clone here, so <html> compares as different even for an identical
        // document. Recording it would flash the whole page on every patch.
        if (oldElement !== root) changed.add(oldElement);
        return true;
      },
      beforeNodeRemoved: (node: Node) => !isUiNode(node),
    },
  });

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

  return { addressed, orphaned, changed: deepest };
}
