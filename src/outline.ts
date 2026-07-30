// Reading an artifact without reading all of it.
//
// The tool's own advice — "apply them by editing the file directly" — has a cost
// nothing accounted for: to edit one paragraph of a 50KB plan, an agent opens
// 50KB. That is ~13,000 tokens to change forty words, paid again on every round
// of a review, and the document is the one thing in this system that is already
// addressable. Every anchor, every churn count and every markdown source range
// is keyed by the same ids.
//
// So this module answers the two questions that make a targeted read possible:
// *what sections exist* (`outlineOf`) and *what is in this one* (`sectionSource`).
// Both are one-way reads of the source and neither ever writes, which keeps them
// on the right side of the rule that governs markdown: the file on disk is the
// truth, the render is presentation.
//
// It has no DOM, for the same reason `html-slice.ts` has none — it runs in the
// CLI, jsdom is a devDependency, and a malformed artifact is precisely when you
// want an answer rather than a thrown parser. And it inherits that module's
// discipline: anything it cannot bracket confidently is not reported, because a
// wrong slice would hand the agent one section's text under another's name.

import path from "node:path";

import { sectionsOf } from "./html-slice.ts";
import { isMarkdownPath, renderMarkdown } from "./markdown.ts";

export interface OutlineEntry {
  /** The anchor id. The same id churn, source ranges and morphing all key on. */
  id: string;
  heading: string | null;
  /** Heading level, when the section is led by one. */
  level: number | null;
  words: number;
  /** 1-indexed and inclusive, so it can be handed straight to a read. */
  line: number;
  endLine: number;
}

export interface ArtifactOutline {
  format: "html" | "markdown";
  bytes: number;
  words: number;
  lines: number;
  entries: OutlineEntry[];
  /**
   * Id'd blocks with no heading of their own — paragraphs, tables, code. Counted
   * rather than listed: they are addressable, and listing two hundred of them
   * would defeat the point of an outline.
   */
  unheadedBlocks: number;
}

export interface SectionSource {
  id: string;
  heading: string | null;
  line: number;
  endLine: number;
  /** Exactly what is in the file: markdown source, or the element's markup. */
  source: string;
}

function words(text: string): number {
  const trimmed = text.replace(/\s+/g, " ").trim();
  return trimmed ? trimmed.split(" ").length : 0;
}

function stripTags(markup: string): string {
  return markup.replace(/<[^>]*>/g, " ");
}

/**
 * A section's heading. Mirrors the rule `server.ts`'s churn list uses, so the
 * two never disagree about what a section is called.
 */
function headingOf(markup: string): { text: string; level: number | null } | null {
  const match = /<(h[1-6])\b[^>]*>([\s\S]*?)<\/\1>/i.exec(markup);
  if (!match) return null;
  const text = stripTags(match[2]!).replace(/\s+/g, " ").trim();
  if (!text) return null;
  return { text: text.slice(0, 120), level: Number(match[1]![1]) };
}

/** 1-indexed line of a character offset. */
function lineAt(source: string, offset: number): number {
  let line = 1;
  for (let at = 0; at < offset && at < source.length; at += 1) {
    if (source[at] === "\n") line += 1;
  }
  return line;
}

function markdownOutline(source: string): ArtifactOutline {
  const { blocks } = renderMarkdown(source);
  const levels = new Map<string, number>();
  for (const block of blocks) {
    const heading = /^h([1-6])$/.exec(block.kind);
    // The renderer names a section's heading block `<section-id>-h`, so the
    // level is recoverable without re-parsing the source.
    if (heading && block.id.endsWith("-h")) levels.set(block.id.slice(0, -2), Number(heading[1]));
  }

  const sections = blocks.filter((block) => block.kind === "section");
  const lines = source.split("\n");
  return {
    format: "markdown",
    bytes: Buffer.byteLength(source),
    words: words(source),
    lines: lines.length,
    entries: sections.map((block) => ({
      id: block.id,
      heading: block.text || null,
      level: levels.get(block.id) ?? null,
      // Counted from the source rather than from the rendered text: it is what
      // the human means by "cut this section by a third".
      words: words(lines.slice(block.line - 1, block.endLine).join("\n")),
      line: block.line,
      endLine: block.endLine,
    })),
    unheadedBlocks: blocks.filter((block) => block.kind !== "section" && !/^h[1-6]$/.test(block.kind)).length,
  };
}

function htmlOutline(source: string): ArtifactOutline {
  const sections = sectionsOf(source);
  const entries: OutlineEntry[] = [];
  let unheaded = 0;

  for (const [id, markup] of sections) {
    const heading = headingOf(markup);
    if (!heading) {
      unheaded += 1;
      continue;
    }
    // First occurrence, the same arbitration `sectionsOf` and `diffDocuments`
    // apply to duplicate ids. `doctor` reports duplicates as an error rather
    // than any of us guessing which was meant.
    const at = source.indexOf(markup);
    const line = at === -1 ? 1 : lineAt(source, at);
    entries.push({
      id,
      heading: heading.text,
      level: heading.level,
      words: words(stripTags(markup)),
      line,
      endLine: line + markup.split("\n").length - 1,
    });
  }

  return {
    format: "html",
    bytes: Buffer.byteLength(source),
    words: words(stripTags(source)),
    lines: source.split("\n").length,
    // Document order, because that is the order the human reads it in and the
    // order every id-based anchor implicitly refers to.
    entries: entries.sort((a, b) => a.line - b.line),
    unheadedBlocks: unheaded,
  };
}

export function outlineOf(file: string, source: string): ArtifactOutline {
  return isMarkdownPath(file) ? markdownOutline(source) : htmlOutline(source);
}

/**
 * One section, as it exists in the file.
 *
 * For markdown that is the raw source lines, never the render — the agent edits
 * the `.md`, and handing it HTML would invite it to write HTML back, which is
 * the one operation this codebase refuses to allow anywhere.
 *
 * Returns null rather than a best effort for an unknown or unbracketable id, so
 * the caller can list what does exist. An approximate slice would be a targeted
 * read that quietly returned the wrong target.
 */
export function sectionSource(file: string, source: string, id: string): SectionSource | null {
  if (isMarkdownPath(file)) {
    const block = renderMarkdown(source).blocks.find((entry) => entry.id === id);
    if (!block) return null;
    const lines = source.split("\n");
    return {
      id,
      heading: block.text || null,
      line: block.line,
      endLine: block.endLine,
      source: lines.slice(block.line - 1, block.endLine).join("\n"),
    };
  }

  const markup = sectionsOf(source).get(id);
  if (markup === undefined) return null;
  const at = source.indexOf(markup);
  const line = at === -1 ? 1 : lineAt(source, at);
  return {
    id,
    heading: headingOf(markup)?.text ?? null,
    line,
    endLine: line + markup.split("\n").length - 1,
    source: markup,
  };
}

// ---------------------------------------------------------------------------
// Comparing two revisions, by id.
//
// `diffDocuments` (src/sdk/diff.ts) already does this and does it better, but it
// needs a real DOM and so only ever runs in the browser — which means an agent
// has no way at all to check its own work. It applies a review, reports a
// summary, and finds out whether it changed more than it meant to only when a
// human notices. That asymmetry is the reason "changes you did not ask for" is a
// panel section and not a command.
//
// Section granularity rather than lines, for the same reason `diffDocuments` uses
// it: a line diff over HTML is useless, because one reflowed paragraph rewrites a
// 400-character line.
// ---------------------------------------------------------------------------

export interface SectionChangeSummary {
  id: string;
  kind: "added" | "removed" | "changed";
  heading: string | null;
  wordsBefore: number;
  wordsAfter: number;
}

export function diffSections(before: string, after: string): SectionChangeSummary[] {
  const old = sectionsOf(before);
  const now = sectionsOf(after);
  const changes: Array<SectionChangeSummary & { markup: string }> = [];

  for (const [id, markup] of now) {
    const previous = old.get(id);
    if (previous === markup) continue;
    changes.push({
      id,
      kind: previous === undefined ? "added" : "changed",
      heading: headingOf(markup)?.text ?? null,
      wordsBefore: previous === undefined ? 0 : words(stripTags(previous)),
      wordsAfter: words(stripTags(markup)),
      markup,
    });
  }
  for (const [id, markup] of old) {
    if (now.has(id)) continue;
    // A removed section can never be found by containment in the new document,
    // which is exactly why it has to be reported explicitly rather than inferred.
    changes.push({
      id,
      kind: "removed",
      heading: headingOf(markup)?.text ?? null,
      wordsBefore: words(stripTags(markup)),
      wordsAfter: 0,
      markup,
    });
  }

  /**
   * Only the innermost changed section, the same rule `diffDocuments` follows.
   *
   * Without it every ancestor of an edit is reported too, so a markdown artifact
   * answered a one-paragraph change with four entries — the paragraph, its
   * section, the document — and the outermost is present for *every* edit, which
   * is precisely the "flag `body` on everything" failure that rule exists to
   * prevent. Containment is a substring test because a child's markup is a
   * literal substring of its parent's, which is what `sectionsOf` guarantees.
   */
  const kept = changes.filter(
    (candidate) =>
      !changes.some(
        (other) =>
          other !== candidate &&
          other.kind === candidate.kind &&
          other.markup.length < candidate.markup.length &&
          candidate.markup.includes(other.markup),
      ),
  );
  return kept.map(({ markup: _markup, ...summary }) => summary);
}

/** How a targeted read is reported to an agent. */
export function describeOutline(file: string, outline: ArtifactOutline): Record<string, unknown> {
  const name = path.basename(file);
  return {
    file,
    format: outline.format,
    size: { bytes: outline.bytes, words: outline.words, lines: outline.lines },
    sections: outline.entries.map((entry) => ({
      id: entry.id,
      ...(entry.level ? { level: entry.level } : {}),
      heading: entry.heading,
      words: entry.words,
      source: `${name}:${entry.line}-${entry.endLine}`,
    })),
    ...(outline.unheadedBlocks ? { addressable_blocks_without_a_heading: outline.unheadedBlocks } : {}),
    next_step:
      outline.entries.length === 0
        ? `No id'd sections were found, so nothing here can be read or anchored by id. Run \`plan-editor doctor ${file} --fix\` ` +
          `to give the sections stable ids — that is also what decides whether a human's note comes back addressed or orphaned.`
        : `Read one section with \`plan-editor section ${file} --id <id>\` instead of opening the whole file — the ids above are ` +
          `the same ones review items anchor to. Use the line ranges if you would rather read the file directly.`,
  };
}
