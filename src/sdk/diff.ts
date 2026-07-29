// Element-level diff between two versions of an artifact.
//
// A line diff over HTML is close to useless — one reflowed paragraph rewrites a
// 400-character line and the reader learns nothing. Because the tool already
// asks artifact authors to put stable `id`s on sections (it is what makes
// morphing precise), the same ids give a diff that reads the way a person thinks
// about the document: which sections changed, and what their text was before and
// after.
//
// Runs in the browser, where a real DOM is already available, so there is no
// server-side HTML parser to maintain.

export interface SectionChange {
  id: string;
  kind: "changed" | "added" | "removed";
  label: string;
  before?: string;
  after?: string;
}

export interface DocumentDiff {
  sections: SectionChange[];
  /** Changes outside any id'd element, which cannot be attributed precisely. */
  unattributed: number;
}

function normalizeText(element: Element | null): string {
  return (element?.textContent ?? "").replace(/\s+/g, " ").trim();
}

/** A short human label for a section: its heading if it has one, else its id. */
function labelFor(element: Element): string {
  const heading = element.querySelector("h1, h2, h3, h4, legend, summary");
  const text = normalizeText(heading);
  if (text) return text.slice(0, 60);
  const own = normalizeText(element);
  return own ? own.slice(0, 60) : element.id;
}

function idMap(doc: Document): Map<string, Element> {
  const map = new Map<string, Element>();
  for (const element of doc.querySelectorAll("[id]")) {
    if (!map.has(element.id)) map.set(element.id, element);
  }
  return map;
}

/**
 * Reports only the *innermost* changed id'd element for each change, so editing
 * one paragraph does not also report its section, its main, and its body.
 */
export function diffDocuments(oldHtml: string, newHtml: string): DocumentDiff {
  const parser = new DOMParser();
  const before = parser.parseFromString(oldHtml, "text/html");
  const after = parser.parseFromString(newHtml, "text/html");

  const beforeIds = idMap(before);
  const afterIds = idMap(after);
  const sections: SectionChange[] = [];

  const changedElements: Element[] = [];
  for (const [id, afterElement] of afterIds) {
    const beforeElement = beforeIds.get(id);
    if (!beforeElement) {
      sections.push({ id, kind: "added", label: labelFor(afterElement) });
      continue;
    }
    if (beforeElement.outerHTML !== afterElement.outerHTML) changedElements.push(afterElement);
  }

  for (const element of changedElements) {
    // Skip ancestors of another changed element: the child is the real edit.
    if (changedElements.some((other) => other !== element && element.contains(other))) continue;
    const beforeElement = beforeIds.get(element.id) ?? null;
    sections.push({
      id: element.id,
      kind: "changed",
      label: labelFor(element),
      before: normalizeText(beforeElement),
      after: normalizeText(element),
    });
  }

  for (const [id, beforeElement] of beforeIds) {
    if (!afterIds.has(id)) sections.push({ id, kind: "removed", label: labelFor(beforeElement) });
  }

  // Anything that moved without an id to hang it on. Reported as a count rather
  // than guessed at, so the view never claims precision it does not have.
  const beforeBody = normalizeText(before.body);
  const afterBody = normalizeText(after.body);
  const unattributed = sections.length === 0 && beforeBody !== afterBody ? 1 : 0;

  return { sections, unattributed };
}

/**
 * Word-level diff of two strings, for showing what changed inside one section.
 * Standard LCS; the inputs are a paragraph or two, so the quadratic table is
 * irrelevant in practice and the result is far more readable than a char diff.
 */
export type WordOp = { type: "same" | "add" | "remove"; text: string };

export function diffWords(before: string, after: string): WordOp[] {
  const a = before ? before.split(/(\s+)/).filter((token) => token !== "") : [];
  const b = after ? after.split(/(\s+)/).filter((token) => token !== "") : [];

  const table: number[][] = Array.from({ length: a.length + 1 }, () => new Array<number>(b.length + 1).fill(0));
  for (let i = a.length - 1; i >= 0; i -= 1) {
    for (let j = b.length - 1; j >= 0; j -= 1) {
      table[i]![j] = a[i] === b[j] ? table[i + 1]![j + 1]! + 1 : Math.max(table[i + 1]![j]!, table[i]![j + 1]!);
    }
  }

  const ops: WordOp[] = [];
  const push = (type: WordOp["type"], text: string) => {
    const last = ops[ops.length - 1];
    if (last && last.type === type) last.text += text;
    else ops.push({ type, text });
  };

  let i = 0;
  let j = 0;
  while (i < a.length && j < b.length) {
    if (a[i] === b[j]) {
      push("same", a[i]!);
      i += 1;
      j += 1;
    } else if (table[i + 1]![j]! >= table[i]![j + 1]!) {
      push("remove", a[i]!);
      i += 1;
    } else {
      push("add", b[j]!);
      j += 1;
    }
  }
  while (i < a.length) push("remove", a[i++]!);
  while (j < b.length) push("add", b[j++]!);

  return ops;
}

// ---------------------------------------------------------------------------
// Attributing changes to the notes that asked for them.
//
// A summary tells you what the agent says it did. This tells you what it
// actually did, next to the note that asked for it — and, just as importantly,
// what it changed that nobody asked about. Applying a whole review at once is
// only trustworthy if unrequested changes are visible rather than buried.
// ---------------------------------------------------------------------------

export interface AttributionInput {
  id: string;
  selector: string;
  text: string;
}

export interface Attribution {
  /** Changed sections, keyed by the id of the item that asked for them. */
  byItem: Map<string, SectionChange[]>;
  /** Changes not covered by any item. */
  unrequested: SectionChange[];
}

/**
 * An item owns a change when its anchor and the changed element overlap in
 * either direction: a note on a whole section owns edits inside it, and a note
 * on one paragraph is owned by the section reported as changed around it.
 */
export function attributeChanges(
  oldHtml: string,
  newHtml: string,
  items: AttributionInput[],
): Attribution {
  const diff = diffDocuments(oldHtml, newHtml);
  const parser = new DOMParser();
  const before = parser.parseFromString(oldHtml, "text/html");
  const after = parser.parseFromString(newHtml, "text/html");

  const find = (doc: Document, item: AttributionInput): Element | null => {
    if (item.selector) {
      try {
        const found = doc.querySelector(item.selector);
        if (found) return found;
      } catch {
        // Malformed stored selector; fall through to text.
      }
    }
    const needle = item.text.replace(/\s+/g, " ").trim();
    if (!needle) return null;
    return (
      [...doc.body.querySelectorAll("*")].find(
        (candidate) => (candidate.textContent ?? "").replace(/\s+/g, " ").trim() === needle,
      ) ?? null
    );
  };

  /** Nearest id'd element, since ids are what the diff reports against. */
  const idOf = (element: Element | null): string | null => {
    for (let node: Element | null = element; node; node = node.parentElement) {
      if (node.id) return node.id;
    }
    return null;
  };

  const anchors = items.map((item) => {
    // Prefer the new document, but fall back through the *old* one: the anchor
    // text was captured before the agent touched it, so matching it against the
    // rewritten document fails on exactly the items that did change.
    const element = find(after, item) ?? (idOf(find(before, item)) ? after.getElementById(idOf(find(before, item))!) : null);
    return { id: item.id, element };
  });

  const byItem = new Map<string, SectionChange[]>();
  const unrequested: SectionChange[] = [];

  for (const section of diff.sections) {
    const element = after.getElementById(section.id);
    const owners = anchors.filter(
      (anchor) =>
        anchor.element &&
        element &&
        (anchor.element === element || anchor.element.contains(element) || element.contains(anchor.element)),
    );

    if (owners.length === 0) {
      // A removed section has no element in the new document, so it can never be
      // attributed by containment — but the human still needs to see it went.
      unrequested.push(section);
      continue;
    }
    for (const owner of owners) {
      byItem.set(owner.id, [...(byItem.get(owner.id) ?? []), section]);
    }
  }

  return { byItem, unrequested };
}
