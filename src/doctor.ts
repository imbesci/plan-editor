// Artifact linter, plus starter templates that pass it by construction.
//
// The README calls giving top-level sections stable `id` attributes "the single
// highest-value thing you can do" for this tool, and it means it literally:
// idiomorph matches on id first, so an id is the difference between an
// annotation coming back `addressed` and coming back `orphaned`. Nothing in the
// codebase ever checked. Every downstream anchoring failure traced back to an
// artifact that quietly broke that contract, and the symptom surfaced a long way
// from the cause — not as "this file has no ids" but as a note that mysteriously
// orphaned, in a session that had stopped thinking about markup hours earlier.
// This module makes the contract checkable up front, and ships templates that
// satisfy it so a new artifact never starts out broken.
//
// It scans with regexes rather than jsdom on purpose. It runs in the CLI, where
// there is no DOM and jsdom is a devDependency the shipped tool must not need,
// and it has to survive markup no parser would accept: a malformed artifact is
// exactly the moment you want the linter to talk, not throw.

import { isMarkdownPath, renderMarkdown } from "./markdown.ts";

export type Severity = "error" | "warning" | "info";

export interface Finding {
  severity: Severity;
  rule: string;
  message: string;
  fix?: string;
  line?: number;
}

/** Beyond this, one element is a slab rather than a paragraph. See `huge-element`. */
const HUGE_TEXT_CHARS = 4000;

/** A hundred id-less sections is one problem, not a hundred. See `missing-section-ids`. */
const MAX_SECTION_FINDINGS = 20;

const VOID_ELEMENTS = new Set([
  "area", "base", "br", "col", "embed", "hr", "img", "input",
  "link", "meta", "param", "source", "track", "wbr",
]);

/** Elements whose content is text, not markup — scanning inside them finds fake tags. */
const RAW_TEXT_ELEMENTS = new Set(["script", "style", "textarea", "title"]);

/** What counts as "the block a heading leads", for `missing-section-ids`. */
const SECTIONING_ELEMENTS = new Set([
  "section", "article", "header", "footer", "aside", "nav", "main",
]);

const HEADING_ELEMENTS = new Set(["h1", "h2", "h3"]);

/**
 * Never an annotation target and never reported as changed — the same set the
 * morph guards with `isStructuralRoot`. Without this, `<html>` is a text leaf on
 * any document whose only children are `<head>` and `<body>`, and every artifact
 * over 4000 characters gets told its root element is too big.
 */
const STRUCTURAL_ROOTS = new Set(["html", "head", "body"]);

/** Used to decide whether an element is a text leaf. See `huge-element`. */
const BLOCK_ELEMENTS = new Set([
  "address", "article", "aside", "blockquote", "dd", "details", "div", "dl", "dt",
  "fieldset", "figcaption", "figure", "footer", "form", "h1", "h2", "h3", "h4",
  "h5", "h6", "header", "hr", "li", "main", "nav", "ol", "p", "pre", "section",
  "table", "tbody", "td", "tfoot", "th", "thead", "tr", "ul",
]);

interface ElementNode {
  name: string;
  attrs: Record<string, string>;
  /** 1-indexed line of the opening tag. */
  line: number;
  parent: number;
  children: number[];
  textStart: number;
  textEnd: number;
}

interface ScanResult {
  nodes: ElementNode[];
  /** Source with raw-text bodies blanked, so text extraction never picks up CSS or JS. */
  masked: string;
  styles: string;
  styleLine: number | undefined;
  bodyIndex: number;
}

// Alternation order matters: comments first, so `<!-- <section> -->` never
// registers as markup. Each of the "swallow to a terminator" branches also
// accepts end-of-input, because an unterminated comment must consume the rest of
// the document rather than fall through and be re-read as a hundred stray tags.
const TAG_RE =
  /<!--[\s\S]*?(?:-->|$)|<!\[CDATA\[[\s\S]*?(?:\]\]>|$)|<![^>]*>|<\?[^>]*>|<(\/)?([a-zA-Z][^\s/>]*)((?:'[^']*'|"[^"]*"|[^'">])*)>/g;

const ATTR_RE =
  /([a-zA-Z_:][-a-zA-Z0-9_:.]*)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s"'=<>`]+)))?/g;

function parseAttributes(raw: string): Record<string, string> {
  const attrs: Record<string, string> = {};
  ATTR_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = ATTR_RE.exec(raw))) {
    const name = (match[1] ?? "").toLowerCase();
    if (!name) continue;
    // Later duplicates lose, matching how a browser resolves a repeated attribute.
    if (name in attrs) continue;
    attrs[name] = match[2] ?? match[3] ?? match[4] ?? "";
  }
  return attrs;
}

/** 1-indexed line lookup by character offset. */
function lineLookup(html: string): (index: number) => number {
  const starts = [0];
  for (let i = 0; i < html.length; i += 1) {
    if (html[i] === "\n") starts.push(i + 1);
  }
  return (index) => {
    let low = 0;
    let high = starts.length - 1;
    while (low < high) {
      const mid = (low + high + 1) >> 1;
      if ((starts[mid] ?? 0) <= index) low = mid;
      else high = mid - 1;
    }
    return low + 1;
  };
}

function decodeEntities(text: string): string {
  return text
    .replace(/&nbsp;/gi, " ")
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#0*39;|&apos;/gi, "'");
}

function textBetween(masked: string, start: number, end: number): string {
  if (!(end > start)) return "";
  return decodeEntities(masked.slice(start, end).replace(/<[^>]*>/g, " "))
    .replace(/\s+/g, " ")
    .trim();
}

/**
 * Builds a forgiving element tree. Mismatched and unclosed tags are tolerated —
 * a stray `</div>` with nothing to close is dropped, and anything still open at
 * the end is closed at end-of-input — because the documents most worth linting
 * are the ones a strict parser refuses.
 */
function scan(html: string): ScanResult {
  const lower = html.toLowerCase();
  const lineAt = lineLookup(html);
  const nodes: ElementNode[] = [];
  const open: number[] = [];
  const styles: string[] = [];
  let styleLine: number | undefined;
  let bodyIndex = -1;

  // Raw-text bodies are blanked in place (same length, newlines kept) so every
  // offset stays valid against the original source and line numbers stay honest.
  const maskRanges: Array<[number, number]> = [];

  TAG_RE.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG_RE.exec(html))) {
    const name = (match[2] ?? "").toLowerCase();
    if (!name) continue; // a comment, doctype, or processing instruction

    const isClosing = match[1] === "/";
    const rawAttrs = match[3] ?? "";
    const tagStart = match.index;
    const tagEnd = tagStart + match[0].length;

    if (isClosing) {
      const target = stackSlotOf(nodes, open, name);
      // A stray close with nothing to match is dropped rather than treated as an
      // error: it is the single most common thing wrong with hand-edited markup.
      if (target >= 0) {
        // Everything opened inside the element being closed is implicitly closed too.
        for (let i = open.length - 1; i >= target; i -= 1) {
          const idx = open[i];
          const node = idx === undefined ? undefined : nodes[idx];
          if (node) node.textEnd = tagStart;
        }
        open.length = target;
      }
      continue;
    }

    const selfClosing = /\/\s*$/.test(rawAttrs);
    const parent = open.length ? (open[open.length - 1] ?? -1) : -1;
    const node: ElementNode = {
      name,
      attrs: parseAttributes(rawAttrs),
      line: lineAt(tagStart),
      parent,
      children: [],
      textStart: tagEnd,
      textEnd: tagEnd,
    };
    const index = nodes.length;
    nodes.push(node);
    if (parent >= 0) nodes[parent]?.children.push(index);
    if (name === "body" && bodyIndex < 0) bodyIndex = index;

    if (selfClosing || VOID_ELEMENTS.has(name)) continue;

    if (RAW_TEXT_ELEMENTS.has(name)) {
      const closeAt = lower.indexOf(`</${name}`, tagEnd);
      const contentEnd = closeAt >= 0 ? closeAt : html.length;
      node.textEnd = contentEnd;
      maskRanges.push([tagEnd, contentEnd]);
      if (name === "style") {
        styles.push(html.slice(tagEnd, contentEnd));
        if (styleLine === undefined) styleLine = node.line;
      }
      // Resume at the close tag itself so it is consumed as an ordinary tag.
      TAG_RE.lastIndex = contentEnd;
      continue;
    }

    open.push(index);
  }

  for (const idx of open) {
    const node = nodes[idx];
    if (node) node.textEnd = html.length;
  }

  let masked = html;
  if (maskRanges.length) {
    const parts: string[] = [];
    let cursor = 0;
    for (const [start, end] of maskRanges) {
      if (start < cursor) continue;
      parts.push(masked.slice(cursor, start));
      parts.push(masked.slice(start, end).replace(/[^\n]/g, " "));
      cursor = end;
    }
    parts.push(masked.slice(cursor));
    masked = parts.join("");
  }

  return { nodes, masked, styles: styles.join("\n"), styleLine, bodyIndex };
}

/** Stack position of the innermost still-open element with this tag name, or -1. */
function stackSlotOf(nodes: ElementNode[], open: number[], name: string): number {
  for (let i = open.length - 1; i >= 0; i -= 1) {
    const idx = open[i];
    if (idx !== undefined && nodes[idx]?.name === name) return i;
  }
  return -1;
}

function ancestors(nodes: ElementNode[], index: number): number[] {
  const chain: number[] = [];
  let cursor = nodes[index]?.parent ?? -1;
  let guard = 0;
  while (cursor >= 0 && guard < 4096) {
    chain.push(cursor);
    cursor = nodes[cursor]?.parent ?? -1;
    guard += 1;
  }
  return chain;
}

/** A short human label, so a finding names the section the author recognises. */
function labelFor(nodes: ElementNode[], masked: string, index: number): string {
  const node = nodes[index];
  if (!node) return "";
  for (const child of node.children) {
    const candidate = nodes[child];
    if (candidate && /^h[1-6]$/.test(candidate.name)) {
      const heading = textBetween(masked, candidate.textStart, candidate.textEnd);
      if (heading) return heading.slice(0, 48);
    }
    // One level down covers the common `<section><div><h2>` wrapper.
    for (const grand of candidate?.children ?? []) {
      const deeper = nodes[grand];
      if (deeper && /^h[1-6]$/.test(deeper.name)) {
        const heading = textBetween(masked, deeper.textStart, deeper.textEnd);
        if (heading) return heading.slice(0, 48);
      }
    }
  }
  return textBetween(masked, node.textStart, node.textEnd).slice(0, 48);
}

function named(node: ElementNode, label: string): string {
  return label ? `<${node.name}> "${label}"` : `<${node.name}>`;
}

function checkIds(scanned: ScanResult, findings: Finding[]): void {
  const { nodes, bodyIndex } = scanned;

  const inBody = (index: number): boolean =>
    bodyIndex < 0 || index === bodyIndex || ancestors(nodes, index).includes(bodyIndex);

  let idsInBody = 0;
  const seen = new Map<string, number>();
  for (const [index, node] of nodes.entries()) {
    const id = node.attrs["id"]?.trim();
    if (!id) continue;
    if (inBody(index)) idsInBody += 1;
    const first = seen.get(id);
    if (first === undefined) {
      seen.set(id, node.line);
      continue;
    }
    // `diffDocuments` indexes ids first-occurrence-wins, so this element is not
    // merely ambiguous — it is invisible to the diff, and no change inside it can
    // ever be attributed to a note or reported back to the human.
    findings.push({
      severity: "error",
      rule: "duplicate-ids",
      message: `id "${id}" is used more than once (first at line ${first})`,
      fix: "Make every id unique. The diff indexes ids first-occurrence-wins, so the second element with a duplicate id is invisible to it and changes inside it are never attributed.",
      line: node.line,
    });
  }

  if (idsInBody === 0) {
    findings.push({
      severity: "error",
      rule: "no-ids-at-all",
      message: "nothing in the document body has an id",
      fix: 'Give each top-level section a stable id — <section id="risks">. Without one, idiomorph matches structurally, annotations orphan on the first rewrite, and every change is reported as unattributed because there is nothing to attribute it to.',
    });
  }
}

function checkSectionIds(scanned: ScanResult, findings: Finding[]): void {
  const { nodes, masked } = scanned;
  const flagged = new Set<number>();
  const candidates: Finding[] = [];

  const fix =
    'Add a stable id, e.g. <section id="risks">. Idiomorph matches on id first, so the id is what lets a section be updated in place rather than torn down — the difference between an annotation coming back addressed and coming back orphaned.';

  for (const [index, node] of nodes.entries()) {
    if (node.name !== "section" && node.name !== "article") continue;
    // Only outermost sections: a nested one inherits an anchor from its parent.
    const nested = ancestors(nodes, index).some((a) => {
      const name = nodes[a]?.name;
      return name === "section" || name === "article";
    });
    if (nested) continue;
    if (node.attrs["id"]?.trim()) continue;
    flagged.add(index);
    candidates.push({
      severity: "warning",
      rule: "missing-section-ids",
      message: `${named(node, labelFor(nodes, masked, index))} has no id`,
      fix,
      line: node.line,
    });
  }

  for (const [index, node] of nodes.entries()) {
    if (!HEADING_ELEMENTS.has(node.name)) continue;
    if (node.attrs["id"]?.trim()) continue;
    const holders = ancestors(nodes, index).filter((a) =>
      SECTIONING_ELEMENTS.has(nodes[a]?.name ?? ""),
    );
    // Any anchorable block above it is enough: the annotation lands on the
    // nearest id'd ancestor, so a nested id-less wrapper is not a failure.
    if (holders.some((h) => nodes[h]?.attrs["id"]?.trim())) continue;
    // Already reported as an id-less section; saying it twice is noise.
    if (holders.some((h) => flagged.has(h))) continue;
    candidates.push({
      severity: "warning",
      rule: "missing-section-ids",
      message: `<${node.name}> "${textBetween(masked, node.textStart, node.textEnd).slice(0, 48)}" leads a block with no id`,
      fix,
      line: node.line,
    });
  }

  candidates.sort((a, b) => (a.line ?? 0) - (b.line ?? 0));
  for (const finding of candidates.slice(0, MAX_SECTION_FINDINGS)) findings.push(finding);
  if (candidates.length > MAX_SECTION_FINDINGS) {
    findings.push({
      severity: "info",
      rule: "missing-section-ids",
      message: `…and ${candidates.length - MAX_SECTION_FINDINGS} more`,
      fix: "Fix the ones above first; a document with this many unanchored blocks is better re-generated from a template than patched.",
    });
  }
}

// ---------------------------------------------------------------------------
// Fixing the one finding that matters most.
//
// `missing-section-ids` is the only warning in this file whose fix is mechanical
// *and* whose absence breaks the tool rather than merely degrading it: idiomorph
// matches on id first, so an id-less section is torn down and rebuilt on every
// patch, and every note anchored inside it orphans. Reporting it and leaving the
// author to hand-edit thirty opening tags is advice they will skip — and the
// symptom then surfaces hours later as a note that mysteriously lost its place.
//
// The edit is deliberately the narrowest one that fixes it: an `id` attribute is
// inserted into an existing opening tag and nothing else in the document moves.
// No reformatting, no wrapping, no reordering — this runs against a file someone
// is in the middle of reviewing, and a fixer that reflows their markup would be
// indistinguishable from an agent rewriting it behind their back.
// ---------------------------------------------------------------------------

export interface AddedId {
  id: string;
  /** The element the id was added to, as the author would recognise it. */
  element: string;
  line: number;
}

function slugify(text: string): string {
  return text
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48);
}

/** Every id already in the document, so a generated one can never collide. */
function existingIds(nodes: ElementNode[]): Set<string> {
  const ids = new Set<string>();
  for (const node of nodes) {
    const id = node.attrs["id"]?.trim();
    if (id) ids.add(id);
  }
  return ids;
}

function claim(taken: Set<string>, base: string): string {
  const stem = base || "section";
  if (!taken.has(stem)) {
    taken.add(stem);
    return stem;
  }
  for (let n = 2; n < 1000; n += 1) {
    const candidate = `${stem}-${n}`;
    if (taken.has(candidate)) continue;
    taken.add(candidate);
    return candidate;
  }
  return `${stem}-${taken.size}`;
}

/**
 * The elements `checkSectionIds` would warn about, in one place.
 *
 * Shared with the linter on purpose: a fixer that disagreed with the check about
 * which elements need ids would either leave a reported warning standing or add
 * ids nobody asked for, and both read as the tool being wrong about its own rule.
 */
function unanchoredElements(scanned: ScanResult): number[] {
  const { nodes } = scanned;
  const flagged = new Set<number>();

  for (const [index, node] of nodes.entries()) {
    if (node.name !== "section" && node.name !== "article") continue;
    const nested = ancestors(nodes, index).some((a) => {
      const name = nodes[a]?.name;
      return name === "section" || name === "article";
    });
    if (nested) continue;
    if (node.attrs["id"]?.trim()) continue;
    flagged.add(index);
  }

  const headings = new Set<number>();
  for (const [index, node] of nodes.entries()) {
    if (!HEADING_ELEMENTS.has(node.name)) continue;
    if (node.attrs["id"]?.trim()) continue;
    const holders = ancestors(nodes, index).filter((a) => SECTIONING_ELEMENTS.has(nodes[a]?.name ?? ""));
    if (holders.some((h) => nodes[h]?.attrs["id"]?.trim())) continue;
    if (holders.some((h) => flagged.has(h))) continue;
    headings.add(index);
  }
  return [...flagged, ...headings].sort((a, b) => a - b);
}

/**
 * Adds a stable id to every section the linter would flag.
 *
 * Returns the original string unchanged when there is nothing to do, so a caller
 * can compare by identity and skip the write — rewriting a file with identical
 * content still bumps its mtime, which restarts the detached server (the code
 * signature) and wakes every watcher for no reason.
 */
export function addSectionIds(html: string): { html: string; added: AddedId[] } {
  let scanned: ScanResult;
  try {
    scanned = scan(html ?? "");
  } catch {
    return { html, added: [] };
  }
  const { nodes, masked } = scanned;
  const targets = unanchoredElements(scanned);
  if (targets.length === 0) return { html, added: [] };

  const taken = existingIds(nodes);
  const edits: Array<{ at: number; text: string; added: AddedId }> = [];

  for (const index of targets) {
    const node = nodes[index]!;
    // `textStart` is the offset just past the opening tag, so the `>` that ends
    // it sits at textStart - 1. Anything else means the scanner and the source
    // disagree about where this tag ended, and guessing an offset in someone's
    // document is not a risk worth taking to save them a keystroke.
    const close = node.textStart - 1;
    if (html[close] !== ">") continue;
    // A self-closing tag would put the id after the slash. Sections and headings
    // are never self-closing, so skipping is free and stays correct if that ever
    // changes.
    if (html[close - 1] === "/") continue;

    const label = /^h[1-6]$/.test(node.name)
      ? textBetween(masked, node.textStart, node.textEnd)
      : labelFor(nodes, masked, index);
    const id = claim(taken, slugify(label));
    edits.push({
      at: close,
      text: ` id="${id}"`,
      added: { id, element: named(node, label.slice(0, 48)), line: node.line },
    });
  }

  if (edits.length === 0) return { html, added: [] };

  // Applied back to front so every offset stays valid against the original.
  let output = html;
  for (const edit of [...edits].sort((a, b) => b.at - a.at)) {
    output = output.slice(0, edit.at) + edit.text + output.slice(edit.at);
  }
  return { html: output, added: edits.map((edit) => edit.added).sort((a, b) => a.line - b.line) };
}

const COLOUR_RE =
  /#[0-9a-fA-F]{3,8}\b|\brgba?\(|\bhsla?\(|\boklch\(|\bcolor-mix\(|(?:^|[\s;{])(?:color|background|background-color|border-color|fill|stroke)\s*:/;

const FORCED_DARK_RE = /\[\s*data-theme\s*[~|^$*]?=\s*["']?dark["']?\s*\]/;

function checkTheme(scanned: ScanResult, findings: Finding[]): void {
  if (!scanned.styles.trim()) return;
  if (!COLOUR_RE.test(scanned.styles)) return;
  if (FORCED_DARK_RE.test(scanned.styles)) return;
  // The chrome's theme toggle tells the artifact by setting `data-theme` on its
  // root. An artifact that only has the media query keeps following the OS, so it
  // stays light inside a chrome that just went dark and reads as a rendering bug.
  findings.push({
    severity: "warning",
    rule: "no-theme-support",
    message: "the document defines colours but has no [data-theme=\"dark\"] rule",
    fix: 'Write both forms: @media (prefers-color-scheme: dark) { :root:not([data-theme="light"]) { … } } for the OS default, and :root[data-theme="dark"] { … } so plan-editor\'s theme toggle reaches the artifact instead of leaving it light inside a dark chrome.',
    line: scanned.styleLine,
  });
}

function checkInjectedSdk(scanned: ScanResult, findings: Finding[]): void {
  for (const node of scanned.nodes) {
    if (node.name !== "script") continue;
    const src = node.attrs["src"]?.trim() ?? "";
    if (!/(^|\/)sdk\.js(\?|#|$)/.test(src)) continue;
    findings.push({
      severity: "warning",
      rule: "sdk-already-injected",
      message: `<script src="${src}"> is committed into the file`,
      fix: "Delete it. The server injects exactly one SDK tag when it serves the artifact; a committed copy means two, and the second one re-registers every listener. Nothing else is ever added, so the saved file is meant to render identically straight from disk.",
      line: node.line,
    });
  }
}

/**
 * A diagram's identity is its host element's `id`.
 *
 * The predecessor tool keyed diagrams by ordinal position among `.mermaid`
 * elements, so inserting one diagram above another silently reassigned every
 * saved scene to the wrong diagram. We key by `id` instead — which only works
 * if the author supplied one. Without it the SDK falls back to a hash of the
 * source, and the anchor moves the moment the agent edits the diagram.
 */
function checkDiagramIds(scanned: ScanResult, findings: Finding[]): void {
  for (const node of scanned.nodes) {
    const classes = (node.attrs["class"] ?? "").split(/\s+/);
    const isHost =
      classes.includes("mermaid") ||
      (node.name === "code" && classes.includes("language-mermaid"));
    if (!isHost) continue;
    // For `<pre><code class="language-mermaid">` the id belongs on the <pre>.
    const owner = node.name === "code" ? (scanned.nodes[node.parent] ?? node) : node;
    if ((owner.attrs["id"] ?? "").trim()) continue;
    findings.push({
      severity: "warning",
      rule: "diagram-without-id",
      message: "a Mermaid diagram has no id on its container",
      fix: 'Give it one — <pre class="mermaid" id="retry-flow">. Diagram identity is the container id, so without one a note pinned to a node re-anchors by content hash and moves as soon as the diagram is edited.',
      line: owner.line,
    });
  }
}

function checkHugeElements(scanned: ScanResult, findings: Finding[]): void {
  const { nodes, masked } = scanned;
  for (const [index, node] of nodes.entries()) {
    if (RAW_TEXT_ELEMENTS.has(node.name) || STRUCTURAL_ROOTS.has(node.name)) continue;
    // Only text leaves. A long section made of ordinary paragraphs is fine —
    // the annotation and the diff both land on the paragraph — so reporting the
    // section as well as its contents would flag every well-formed document.
    const hasBlockChild = node.children.some((child) =>
      BLOCK_ELEMENTS.has(nodes[child]?.name ?? ""),
    );
    if (hasBlockChild) continue;
    const text = textBetween(masked, node.textStart, node.textEnd);
    if (text.length <= HUGE_TEXT_CHARS) continue;
    findings.push({
      severity: "warning",
      rule: "huge-element",
      message: `<${node.name}> holds ${text.length} characters as one element ("${text.slice(0, 40)}…")`,
      fix: "Split it into smaller blocks and give each one an id. An annotation pinned here makes the whole slab the diff unit, so the word-level highlight has nothing useful to point at and every edit inside it looks like the whole thing changed.",
      line: node.line,
    });
  }
}

type RefKind = "remote" | "absolute" | "escape";

function classifyRef(tag: string, attr: string, rawValue: string): RefKind | null {
  const value = rawValue.trim();
  if (!value || value.startsWith("#")) return null;
  if (/^(?:mailto|tel|sms|data|javascript|blob|about):/i.test(value)) return null;
  // The injected SDK has its own rule; reporting it twice helps nobody.
  if (/^\/?sdk\.js(?:[?#]|$)/.test(value)) return null;

  // An <a> to an external site resolves perfectly well in an export — it is a
  // hyperlink, not an asset. Only things the page must *load* are flagged.
  const isResource =
    attr === "src" || (tag === "link" && attr === "href") || (tag === "object" && attr === "data");

  if (value.startsWith("//") || /^[a-z][a-z0-9+.-]*:\/\//i.test(value)) {
    return isResource ? "remote" : null;
  }
  if (value.startsWith("/")) return "absolute";

  let depth = 0;
  for (const segment of value.split("#")[0]?.split("?")[0]?.split("/") ?? []) {
    if (segment === "" || segment === ".") continue;
    if (segment === "..") depth -= 1;
    else depth += 1;
    if (depth < 0) return "escape";
  }
  return null;
}

const REF_MESSAGES: Record<RefKind, { message: string; fix: string }> = {
  remote: {
    message: "loads from the network",
    fix: "Inline it or copy the asset next to the artifact. An export is the file plus its sibling assets, so a remote reference is missing the moment the reader is offline or behind a different network.",
  },
  absolute: {
    message: "is an absolute path",
    fix: "Make it relative to the artifact (./assets/logo.png). Only files inside the artifact's own directory are served, and an absolute path resolves against whatever host opens the exported file.",
  },
  escape: {
    message: "points outside the artifact directory",
    fix: "Copy it in beside the artifact. Asset serving is confined to the artifact's directory by realpath, so this 404s in the browser and is simply absent from an export.",
  },
};

function checkExternalRefs(scanned: ScanResult, findings: Finding[]): void {
  for (const node of scanned.nodes) {
    for (const attr of ["src", "href", "data"] as const) {
      const value = node.attrs[attr];
      if (value === undefined) continue;
      if (attr === "data" && node.name !== "object") continue;
      const kind = classifyRef(node.name, attr, value);
      if (!kind) continue;
      const detail = REF_MESSAGES[kind];
      findings.push({
        severity: "warning",
        rule: "external-references",
        message: `<${node.name} ${attr}="${value.trim().slice(0, 60)}"> ${detail.message}`,
        fix: detail.fix,
        line: node.line,
      });
    }
  }
}

/**
 * Lints an artifact. Never throws: malformed input produces findings, because the
 * documents most in need of linting are exactly the ones that do not parse.
 */
export function inspectArtifact(html: string): Finding[] {
  const findings: Finding[] = [];
  let scanned: ScanResult;
  try {
    scanned = scan(html ?? "");
  } catch {
    // Defence in depth. The scanner is written not to throw, but a linter that
    // takes down the CLI is worse than a linter that says nothing.
    return [
      {
        severity: "error",
        rule: "unreadable",
        message: "the document could not be scanned at all",
        fix: "Check that the file is HTML and not, say, a truncated download.",
      },
    ];
  }

  checkIds(scanned, findings);
  checkSectionIds(scanned, findings);
  checkTheme(scanned, findings);
  checkInjectedSdk(scanned, findings);
  checkHugeElements(scanned, findings);
  checkExternalRefs(scanned, findings);
  checkDiagramIds(scanned, findings);
  return findings;
}

// ---------------------------------------------------------------------------
// Templates
// ---------------------------------------------------------------------------
//
// Every section carries an id, and both dark-mode forms are present, so a
// document started from one of these satisfies the anchoring contract before a
// single word of it is true. Telling an author to add ids after the fact never
// worked; the file already exists by then and the ids are the first thing an
// agent's rewrite drops.

function escapeHtml(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;");
}

const DARK_VARS = `    --bg: #131211;
    --surface: #1b1a18;
    --fg: #f0ede8;
    --muted: #a6a29b;
    --faint: #7d7973;
    --line: #2e2c29;
    --accent: #e8785e;
    --accent-soft: #2a1c18;
    --ok: #6bbd86;
    --warn: #d8a03f;`;

const BASE_CSS = `  :root {
    --bg: #fbfaf8;
    --surface: #ffffff;
    --fg: #1c1b19;
    --muted: #6b6862;
    --faint: #93908a;
    --line: #e6e2db;
    --accent: #b8442e;
    --accent-soft: #fbeeea;
    --ok: #3f7d54;
    --warn: #a8730f;
    --radius: 10px;
  }
  /* Follows the OS by default, but honours plan-editor's theme toggle when the
     reader has made an explicit choice — hence both selectors. With only the
     media query the artifact stays light inside a chrome that just went dark. */
  @media (prefers-color-scheme: dark) {
    :root:not([data-theme="light"]) {
${DARK_VARS}
    }
  }
  :root[data-theme="dark"] {
${DARK_VARS}
  }
  * { box-sizing: border-box; }
  body {
    margin: 0;
    background: var(--bg);
    color: var(--fg);
    font: 16px/1.65 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
    -webkit-font-smoothing: antialiased;
  }
  .wrap { max-width: 860px; margin: 0 auto; padding: 0 24px 96px; }

  #masthead { padding: 72px 0 44px; border-bottom: 1px solid var(--line); }
  .eyebrow {
    font-size: 12px; letter-spacing: .16em; text-transform: uppercase;
    color: var(--accent); font-weight: 600; margin: 0 0 14px;
  }
  #masthead h1 {
    font: 600 46px/1.1 ui-serif, Georgia, "Times New Roman", serif;
    margin: 0 0 16px; letter-spacing: -.02em;
  }
  .lede { font-size: 19px; color: var(--muted); margin: 0 0 28px; max-width: 60ch; }
  .meta { display: flex; flex-wrap: wrap; gap: 8px 28px; font-size: 13px; color: var(--faint); }
  .meta b { color: var(--muted); font-weight: 600; }

  section { padding-top: 52px; }
  h2 {
    font: 600 13px/1 ui-sans-serif, sans-serif; letter-spacing: .14em;
    text-transform: uppercase; color: var(--faint);
    margin: 0 0 20px; padding-bottom: 10px; border-bottom: 1px solid var(--line);
  }
  h3 { font-size: 17px; margin: 30px 0 10px; letter-spacing: -.01em; }
  p { margin: 0 0 16px; max-width: 68ch; }
  ul, ol { margin: 0 0 16px; padding-left: 22px; max-width: 68ch; }
  li { margin-bottom: 7px; }
  code {
    font: 13px ui-monospace, SFMono-Regular, Menlo, monospace;
    background: var(--accent-soft); color: var(--accent);
    padding: 1px 5px; border-radius: 4px;
  }
  .caption { font-size: 13px; color: var(--faint); margin: 0 0 4px; }

  .cols { display: grid; grid-template-columns: 1fr 1fr; gap: 20px; }
  @media (max-width: 680px) { .cols { grid-template-columns: 1fr; } }
  .card {
    background: var(--surface); border: 1px solid var(--line);
    border-radius: var(--radius); padding: 20px 22px;
  }
  .card h3 { margin-top: 0; font-size: 15px; }
  .card ul { margin-bottom: 0; padding-left: 18px; font-size: 15px; }
  .card.negative h3 { color: var(--muted); }

  .loop { list-style: none; padding: 0; counter-reset: step; }
  .loop li {
    counter-increment: step; position: relative;
    padding: 12px 0 12px 46px; border-bottom: 1px solid var(--line);
  }
  .loop li:last-child { border-bottom: 0; }
  .loop li::before {
    content: counter(step); position: absolute; left: 0; top: 12px;
    width: 26px; height: 26px; border-radius: 50%;
    background: var(--accent-soft); color: var(--accent);
    font-size: 12px; font-weight: 700;
    display: grid; place-items: center;
  }

  .table-scroll { overflow-x: auto; margin-bottom: 18px; }
  table { border-collapse: collapse; width: 100%; font-size: 14.5px; min-width: 520px; }
  th, td { text-align: left; padding: 10px 14px; border-bottom: 1px solid var(--line); vertical-align: top; }
  th { font-size: 12px; letter-spacing: .07em; text-transform: uppercase; color: var(--faint); font-weight: 600; }
  td code { white-space: nowrap; }

  .phase {
    display: grid; grid-template-columns: 96px 1fr; gap: 18px;
    padding: 16px 0; border-bottom: 1px solid var(--line);
  }
  .phase:last-child { border-bottom: 0; }
  .phase-tag {
    font-size: 12px; font-weight: 700; letter-spacing: .08em; text-transform: uppercase;
    color: var(--accent); padding-top: 2px;
  }
  .phase h3 { margin: 0 0 6px; font-size: 16px; }
  .phase p { margin: 0; font-size: 15px; color: var(--muted); }
  @media (max-width: 680px) { .phase { grid-template-columns: 1fr; gap: 4px; } }

  .question {
    background: var(--surface); border: 1px solid var(--line);
    border-left: 3px solid var(--warn);
    border-radius: 0 var(--radius) var(--radius) 0;
    padding: 16px 20px; margin-bottom: 12px;
  }
  .question h3 { margin: 0 0 6px; font-size: 15.5px; }
  .question p { margin: 0; font-size: 15px; color: var(--muted); }
  .question .lean { display: block; margin-top: 8px; font-size: 14px; color: var(--faint); }
  .question .lean b { color: var(--warn); font-weight: 600; }

  .risk { display: grid; grid-template-columns: 1fr 1fr; gap: 0 20px; font-size: 15px; }
  .risk > div { padding: 12px 0; border-bottom: 1px solid var(--line); }
  .risk .what { font-weight: 600; }
  .risk .how { color: var(--muted); }
  @media (max-width: 680px) {
    .risk { grid-template-columns: 1fr; }
    .risk .what { border-bottom: 0; padding-bottom: 0; }
  }

  .verdict { font-weight: 600; color: var(--ok); }
  .verdict.warn { color: var(--warn); }

  footer { margin-top: 56px; padding-top: 24px; border-top: 1px solid var(--line); font-size: 13.5px; color: var(--faint); }`;

interface Shell {
  title: string;
  eyebrow: string;
  lede: string;
  meta: Array<[string, string]>;
  sections: string;
}

function page(shell: Shell): string {
  const meta = shell.meta
    .map(([label, value]) => `    <span><b>${label}</b> ${value}</span>`)
    .join("\n");
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${shell.title}</title>
<style>
${BASE_CSS}
</style>
</head>
<body>
<div class="wrap">

<header id="masthead">
  <p class="eyebrow">${shell.eyebrow}</p>
  <h1>${shell.title}</h1>
  <p class="lede">${shell.lede}</p>
  <div class="meta">
${meta}
  </div>
</header>

${shell.sections}
<footer>
  Draft — annotate anything above and it comes back to the agent that wrote it.
</footer>

</div>
</body>
</html>
`;
}

function planTemplate(rawTitle: string): string {
  const title = escapeHtml(rawTitle);
  return page({
    title,
    eyebrow: "Product plan · draft",
    lede: `One paragraph on what ${title} is and who it is for. If this sentence needs a second one to make sense, the plan is not ready to review.`,
    meta: [
      ["Status", "Draft for review"],
      ["Scope", "Replace with the honest estimate"],
      ["Owner", "Replace with a name"],
    ],
    sections: `<section id="idea">
  <h2>The idea</h2>
  <p>What is broken today, in the reader's terms rather than the system's. Name the moment the problem is felt.</p>
  <p>Then what ${title} does about it, and why that shape rather than the obvious alternative. This is the paragraph reviewers argue with, so leave the reasoning visible.</p>
</section>

<section id="scope">
  <h2>Scope</h2>
  <div class="cols">
    <div class="card" id="goals">
      <h3>Goals</h3>
      <ul>
        <li>The outcome that makes this worth building</li>
        <li>A second outcome, stated so it can be checked</li>
        <li>A constraint that is really a goal in disguise</li>
      </ul>
    </div>
    <div class="card negative" id="non-goals">
      <h3>Non-goals</h3>
      <ul>
        <li>The tempting adjacent feature, listed so the conversation is short</li>
        <li>Something a reader would otherwise assume is included</li>
        <li>Work deliberately deferred, with the deferral owned</li>
      </ul>
    </div>
  </div>
</section>

<section id="approach">
  <h2>Approach</h2>
  <ol class="loop">
    <li>The first thing that happens, and what the reader sees.</li>
    <li>The step after it, including whatever the system decides.</li>
    <li>Where the interesting failure lives, and what happens then.</li>
    <li>How the flow ends, and what state is left behind.</li>
  </ol>
</section>

<section id="milestones">
  <h2>Milestones</h2>
  <div class="phase">
    <div class="phase-tag">Phase 1</div>
    <div>
      <h3>Working</h3>
      <p>The smallest thing that is genuinely usable end to end. Deliberately unpolished — the goal is correct, not nice.</p>
    </div>
  </div>
  <div class="phase">
    <div class="phase-tag">Phase 2</div>
    <div>
      <h3>Legible</h3>
      <p>The work that makes it read the way it behaves. Usually where most of the perceived value lands.</p>
    </div>
  </div>
  <div class="phase">
    <div class="phase-tag">Stretch</div>
    <div>
      <h3>Additive</h3>
      <p>Genuinely optional, so it can slip without threatening the date.</p>
    </div>
  </div>
</section>

<section id="open-questions">
  <h2>Open questions</h2>
  <p>The decisions worth arguing about before any code exists. Everything else should be legible from the plan above.</p>
  <div class="question" id="q-first">
    <h3>State the question as a question</h3>
    <p>The case for each side, in one sentence each. If one side has no case, it is not an open question.</p>
    <span class="lean"><b>Leaning:</b> say which way, so a reviewer can disagree with something concrete.</span>
  </div>
  <div class="question" id="q-second">
    <h3>The second thing that could go either way</h3>
    <p>What it costs to choose wrong, and whether the choice is reversible later.</p>
    <span class="lean"><b>Leaning:</b> the cheaper-to-undo option, unless there is a reason not to.</span>
  </div>
</section>

<section id="risks">
  <h2>Risks</h2>
  <div class="risk">
    <div class="what">The way this most plausibly fails</div>
    <div class="how">What would be done about it, concretely enough to be checked later.</div>
    <div class="what">The scope creep that changes the product</div>
    <div class="how">Named as a risk so the conversation about it is short.</div>
    <div class="what">The dependency outside this team's control</div>
    <div class="how">The fallback, and when the call to use it has to be made.</div>
  </div>
</section>

`,
  });
}

function specTemplate(rawTitle: string): string {
  const title = escapeHtml(rawTitle);
  return page({
    title,
    eyebrow: "Specification · draft",
    lede: `What ${title} must do, precisely enough that two people implementing it separately would build the same thing.`,
    meta: [
      ["Status", "Draft for review"],
      ["Version", "0.1"],
      ["Owner", "Replace with a name"],
    ],
    sections: `<section id="overview">
  <h2>Overview</h2>
  <p>One paragraph on what this specifies and what sits either side of it. A reader should be able to tell from here whether the answer they want is in this document.</p>
  <p>State the assumption everything below rests on. When that assumption changes, this is the paragraph that has to be rewritten first.</p>
</section>

<section id="requirements">
  <h2>Requirements</h2>
  <ol class="loop">
    <li><strong>Must</strong> — the behaviour without which this is not done.</li>
    <li><strong>Must</strong> — a second, written so it can be tested rather than argued about.</li>
    <li><strong>Should</strong> — expected, but a good reason may override it.</li>
    <li><strong>May</strong> — permitted, deliberately not required.</li>
  </ol>
</section>

<section id="interface">
  <h2>Interface</h2>
  <p>The surface other code depends on. Everything not listed here is an implementation detail and may change without notice.</p>
  <div class="table-scroll">
    <table>
      <thead>
        <tr><th>Name</th><th>Type</th><th>Notes</th></tr>
      </thead>
      <tbody>
        <tr>
          <td><code>fieldOne</code></td>
          <td><code>string</code></td>
          <td>What it means, and what makes a value invalid.</td>
        </tr>
        <tr>
          <td><code>fieldTwo</code></td>
          <td><code>number | null</code></td>
          <td>Why null is a real state here rather than a missing value.</td>
        </tr>
        <tr>
          <td><code>fieldThree</code></td>
          <td><code>"a" | "b"</code></td>
          <td>Why the set is closed, and what adding a third case would cost.</td>
        </tr>
      </tbody>
    </table>
  </div>
</section>

<section id="behaviour">
  <h2>Behaviour</h2>
  <h3>The normal path</h3>
  <p>What happens when everything is as expected, in order, with the observable result at each step.</p>
  <h3>Edge cases</h3>
  <ul>
    <li>Empty input — what is returned, and whether it is an error.</li>
    <li>Concurrent callers — who wins, and whether the loser is told.</li>
    <li>Partial failure — what is rolled back and what is kept.</li>
  </ul>
</section>

<section id="out-of-scope">
  <h2>Out of scope</h2>
  <div class="cols">
    <div class="card negative" id="excluded">
      <h3>Not specified here</h3>
      <ul>
        <li>The neighbouring concern with its own document</li>
        <li>Anything intentionally left to the implementation</li>
      </ul>
    </div>
    <div class="card" id="assumptions">
      <h3>Assumed</h3>
      <ul>
        <li>What callers are trusted to have done already</li>
        <li>The environment this is allowed to depend on</li>
      </ul>
    </div>
  </div>
</section>

<section id="open-questions">
  <h2>Open questions</h2>
  <div class="question" id="q-first">
    <h3>The unresolved decision</h3>
    <p>What is genuinely undecided, and who has to decide it before implementation can start.</p>
    <span class="lean"><b>Leaning:</b> state a default, so silence resolves it rather than blocking.</span>
  </div>
</section>

`,
  });
}

function reportTemplate(rawTitle: string): string {
  const title = escapeHtml(rawTitle);
  return page({
    title,
    eyebrow: "Report · draft",
    lede: `What was found in ${title}, what it means, and what should happen next. The summary below is the whole report for most readers.`,
    meta: [
      ["Status", "Draft for review"],
      ["Period", "Replace with the window covered"],
      ["Author", "Replace with a name"],
    ],
    sections: `<section id="summary">
  <h2>Summary</h2>
  <p>The finding, stated first and without hedging. If a reader stops here, this sentence is what they carry away.</p>
  <p>Then the one caveat that would change the conclusion, so nobody has to hunt for it in the method section.</p>
</section>

<section id="method">
  <h2>Method</h2>
  <p>What was measured, over what window, and by what means. Enough that someone could repeat it and expect the same answer.</p>
  <ul>
    <li>Source of the data, and how much of it was excluded.</li>
    <li>The comparison, and why that baseline rather than another.</li>
    <li>Where the measurement is known to be imprecise.</li>
  </ul>
</section>

<section id="findings">
  <h2>Findings</h2>
  <div id="finding-one">
    <h3>The first finding, as a claim</h3>
    <p>The evidence, then what it implies. Keep the claim and the interpretation in separate sentences so a reviewer can accept one and reject the other.</p>
  </div>
  <div id="finding-two">
    <h3>The second finding</h3>
    <p>Including the part that was surprising, and whether it survived a second look.</p>
  </div>
  <div id="finding-three">
    <h3>What did not show up</h3>
    <p>The expected effect that was absent. Absence is a finding, and leaving it out is how a report quietly overstates itself.</p>
  </div>
</section>

<section id="data">
  <h2>Data</h2>
  <div class="table-scroll">
    <table>
      <thead>
        <tr><th>Measure</th><th>Before</th><th>After</th><th>Note</th></tr>
      </thead>
      <tbody>
        <tr><td>First measure</td><td>—</td><td>—</td><td>What moved, and by how much.</td></tr>
        <tr><td>Second measure</td><td>—</td><td>—</td><td>Whether the change is larger than the noise.</td></tr>
        <tr><td>Third measure</td><td>—</td><td>—</td><td>Flat, and why that is the interesting part.</td></tr>
      </tbody>
    </table>
  </div>
  <p class="caption">Replace the dashes with real numbers, or delete the row.</p>
</section>

<section id="recommendations">
  <h2>Recommendations</h2>
  <ol class="loop">
    <li><span class="verdict">Do this</span> — the action the findings actually support, with its owner.</li>
    <li><span class="verdict warn">Watch this</span> — not yet actionable, and what would make it so.</li>
    <li><span class="verdict">Stop this</span> — what the evidence says is not worth continuing.</li>
  </ol>
</section>

<section id="next-steps">
  <h2>Next steps</h2>
  <div class="phase">
    <div class="phase-tag">This week</div>
    <div>
      <h3>The immediate action</h3>
      <p>Small enough to start now, specific enough to know when it is done.</p>
    </div>
  </div>
  <div class="phase">
    <div class="phase-tag">Next</div>
    <div>
      <h3>The follow-up</h3>
      <p>What it depends on, and who is waiting on it.</p>
    </div>
  </div>
</section>

`,
  });
}

export const TEMPLATES: Record<"plan" | "spec" | "report", (title: string) => string> = {
  plan: planTemplate,
  spec: specTemplate,
  report: reportTemplate,
};

export function renderTemplate(kind: keyof typeof TEMPLATES, title: string): string {
  return TEMPLATES[kind](title);
}

/**
 * Lints an artifact given its path, which is what every caller actually has.
 *
 * Markdown must be rendered first. Linting the raw source as HTML reports
 * `no-ids-at-all` on every `.md` file and then advises adding
 * `<section id="…">` to it — advice that is not merely useless but actively
 * wrong, since the renderer derives an id per block and there is no markup for
 * the author to add.
 */
export function inspectArtifactSource(file: string, source: string): Finding[] {
  if (!isMarkdownPath(file)) return inspectArtifact(source);
  const findings = inspectArtifact(renderMarkdown(source, { title: file }).html);
  // `sdk-already-injected` cannot apply: the render is generated fresh on every
  // read and the SDK tag is added after it.
  return findings.filter((finding) => finding.rule !== "sdk-already-injected");
}
