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
