// Markdown → HTML, so a `.md` plan can be reviewed in the browser like any other
// artifact.
//
// **This is the forward direction only, and it always will be.** The markdown
// file stays the source of truth: the agent edits the `.md` directly, exactly as
// it edits `.html` today, and the browser only ever renders it. There is
// deliberately no HTML → Markdown converter anywhere in this module. A round
// trip through one is the single change that could corrupt the human's file —
// every reflowed list, dropped reference link and re-indented fence would be
// written back over their prose on every patch — so the option is not offered at
// all. If something needs to change in the document, it changes in the markdown.
//
// Raw HTML in the source is escaped, never passed through. A plan is text a
// human or an agent wrote; `<script>` in it is content, not markup. The artifact
// iframe is sandboxed, but the document is still the user's and the sandbox is a
// second line of defence, not a licence to inject whatever the file contains.

export interface RenderedBlock {
  id: string;
  /** 1-indexed, inclusive. */
  line: number;
  endLine: number;
  kind: string;
  text: string;
}

export interface RenderedMarkdown {
  html: string;
  blocks: RenderedBlock[];
}

const MARKDOWN_EXTENSIONS = [".md", ".markdown", ".mdx"];

/**
 * `.mdx` is rendered as plain markdown — component syntax comes out as escaped
 * text rather than being executed, which is the same call as everywhere else
 * here: show the file, do not run it.
 */
export function isMarkdownPath(file: string): boolean {
  const lower = file.toLowerCase();
  return MARKDOWN_EXTENSIONS.some((extension) => lower.endsWith(extension));
}

// ---------------------------------------------------------------------------
// Block parsing
// ---------------------------------------------------------------------------

interface SourceLine {
  text: string;
  /** 1-indexed line in the original file, preserved through every recursion so
      `blocks` can point at PLAN.md:42 rather than at an offset into a fragment. */
  n: number;
}

interface Span {
  line: number;
  endLine: number;
}

interface ListItem extends Span {
  children: Block[];
}

type Block =
  | (Span & { kind: "heading"; level: number; text: string })
  | (Span & { kind: "paragraph"; text: string })
  | (Span & { kind: "code"; code: string; lang: string })
  | (Span & { kind: "list"; ordered: boolean; start: number; tight: boolean; items: ListItem[] })
  | (Span & { kind: "quote"; children: Block[] })
  | (Span & { kind: "table"; head: string[]; align: (string | null)[]; rows: string[][] })
  | (Span & { kind: "hr" });

interface SectionNode {
  kind: "section";
  heading: Extract<Block, { kind: "heading" }>;
  children: Node[];
}

type Node = Block | SectionNode;

const HEADING = /^ {0,3}(#{1,6})(?:[ \t]+(.*?))?[ \t]*$/;
const FENCE = /^ {0,3}(`{3,}|~{3,})[ \t]*(.*)$/;
const HR = /^ {0,3}(?:(?:\*[ \t]*){3,}|(?:-[ \t]*){3,}|(?:_[ \t]*){3,})$/;
const QUOTE = /^ {0,3}>[ \t]?/;
const LIST_ITEM = /^([ \t]*)([-+*]|\d{1,9}[.)])(?:([ \t]+)(.*)|[ \t]*$)/;
const TABLE_DELIM = /^ {0,3}\|?[ \t]*:?-+:?[ \t]*(?:\|[ \t]*:?-+:?[ \t]*)*\|?[ \t]*$/;
const INDENTED_CODE = /^(?: {4}|\t)/;

function isBlank(line: string): boolean {
  return line.trim() === "";
}

function indentOf(line: string): number {
  const match = /^[ ]*/.exec(line);
  return match ? match[0].length : 0;
}

/** True for lines that interrupt a running paragraph. */
function startsNewBlock(line: string): boolean {
  if (isBlank(line)) return true;
  if (HEADING.test(line)) return true;
  if (FENCE.test(line)) return true;
  if (HR.test(line)) return true;
  if (QUOTE.test(line)) return true;
  if (LIST_ITEM.test(line)) return true;
  return false;
}

function toLines(source: string): SourceLine[] {
  return source.split(/\r\n|\r|\n/).map((raw, index) => ({
    // Leading tabs become four spaces up front: every list and code decision
    // below is arithmetic on indent width, and mixing the two units makes a
    // tab-indented nested list parse as a sibling of its parent.
    text: raw.replace(/^[ \t]+/, (run) => run.replace(/\t/g, "    ")),
    n: index + 1,
  }));
}

function parseBlocks(lines: SourceLine[]): Block[] {
  const blocks: Block[] = [];
  let i = 0;

  while (i < lines.length) {
    const current = lines[i]!;
    const text = current.text;

    if (isBlank(text)) {
      i += 1;
      continue;
    }

    const fence = FENCE.exec(text);
    if (fence) {
      const marker = fence[1]!;
      const lang = fence[2]!.trim().split(/\s+/)[0] ?? "";
      const body: SourceLine[] = [];
      const start = current.n;
      let end = current.n;
      let closed = false;
      i += 1;
      while (i < lines.length) {
        const line = lines[i]!;
        end = line.n;
        if (new RegExp(`^ {0,3}${marker[0] === "`" ? "`" : "~"}{${marker.length},}[ \\t]*$`).test(line.text)) {
          closed = true;
          i += 1;
          break;
        }
        body.push(line);
        i += 1;
      }
      // An unterminated fence runs to EOF rather than being abandoned: the file
      // is being edited live, so it is routinely read mid-write and half a code
      // block is still better than the rest of the document turning into prose.
      // Its trailing blanks are dropped, since the file's final newline is not
      // code and would otherwise show as an empty line that keeps moving.
      if (!closed) {
        while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
        end = body[body.length - 1]?.n ?? start;
      }
      blocks.push({
        kind: "code",
        code: body.map((line) => line.text).join("\n"),
        lang,
        line: start,
        endLine: end,
      });
      continue;
    }

    const heading = HEADING.exec(text);
    if (heading) {
      const raw = (heading[2] ?? "").replace(/[ \t]+#+[ \t]*$/, "");
      blocks.push({
        kind: "heading",
        level: heading[1]!.length,
        text: raw.trim(),
        line: current.n,
        endLine: current.n,
      });
      i += 1;
      continue;
    }

    // HR before list: `- - -` matches both, and a rule is never a bullet.
    if (HR.test(text)) {
      blocks.push({ kind: "hr", line: current.n, endLine: current.n });
      i += 1;
      continue;
    }

    if (QUOTE.test(text)) {
      const inner: SourceLine[] = [];
      const start = current.n;
      let end = current.n;
      while (i < lines.length) {
        const line = lines[i]!;
        if (QUOTE.test(line.text)) {
          inner.push({ text: line.text.replace(QUOTE, ""), n: line.n });
        } else if (isBlank(line.text) || startsNewBlock(line.text)) {
          break;
        } else {
          inner.push({ text: line.text, n: line.n }); // lazy continuation
        }
        end = line.n;
        i += 1;
      }
      blocks.push({ kind: "quote", children: parseBlocks(inner), line: start, endLine: end });
      continue;
    }

    if (LIST_ITEM.test(text)) {
      const parsed = parseList(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    const delimiter = lines[i + 1];
    if (text.includes("|") && delimiter && TABLE_DELIM.test(delimiter.text) && delimiter.text.includes("-")) {
      const parsed = parseTable(lines, i);
      blocks.push(parsed.block);
      i = parsed.next;
      continue;
    }

    if (INDENTED_CODE.test(text)) {
      const body: SourceLine[] = [];
      const start = current.n;
      while (i < lines.length && (INDENTED_CODE.test(lines[i]!.text) || isBlank(lines[i]!.text))) {
        body.push(lines[i]!);
        i += 1;
      }
      while (body.length > 0 && isBlank(body[body.length - 1]!.text)) body.pop();
      blocks.push({
        kind: "code",
        code: body.map((line) => line.text.replace(/^(?: {4}|\t)/, "")).join("\n"),
        lang: "",
        line: start,
        endLine: body[body.length - 1]?.n ?? start,
      });
      continue;
    }

    const paragraph: string[] = [];
    const start = current.n;
    let end = current.n;
    while (i < lines.length && !startsNewBlock(lines[i]!.text)) {
      const line = lines[i]!;
      const next = lines[i + 1];
      if (line.text.includes("|") && next && TABLE_DELIM.test(next.text) && next.text.includes("-")) break;
      paragraph.push(line.text.trim());
      end = line.n;
      i += 1;
    }
    blocks.push({ kind: "paragraph", text: paragraph.join("\n"), line: start, endLine: end });
  }

  return blocks;
}

function parseList(lines: SourceLine[], from: number): { block: Block; next: number } {
  const first = LIST_ITEM.exec(lines[from]!.text)!;
  const ordered = /\d/.test(first[2]!);
  const start = ordered ? Number.parseInt(first[2]!, 10) : 1;
  const items: ListItem[] = [];
  let loose = false;
  let i = from;
  const firstLine = lines[from]!.n;
  let lastLine = firstLine;

  while (i < lines.length) {
    const marker = LIST_ITEM.exec(lines[i]!.text);
    if (!marker || HR.test(lines[i]!.text)) break;
    if (/\d/.test(marker[2]!) !== ordered) break; // a different marker type is a different list

    const contentIndent = marker[1]!.length + marker[2]!.length + (marker[3]?.length ?? 1);
    const itemLines: SourceLine[] = [{ text: marker[4] ?? "", n: lines[i]!.n }];
    const itemStart = lines[i]!.n;
    let itemEnd = lines[i]!.n;
    i += 1;

    while (i < lines.length) {
      const line = lines[i]!;
      if (isBlank(line.text)) {
        const next = lines[i + 1];
        const continues = next !== undefined && !isBlank(next.text) && indentOf(next.text) >= contentIndent;
        const sibling = next !== undefined && LIST_ITEM.test(next.text) && !HR.test(next.text);
        // A blank line only stays inside the list if something follows it that
        // belongs to the list; otherwise the list ended and the blank is just
        // separation. Trailing blanks must not make the last item loose.
        if (!continues && !sibling) break;
        loose = true;
        itemLines.push({ text: "", n: line.n });
        i += 1;
        if (!continues) break;
        continue;
      }
      if (indentOf(line.text) >= contentIndent) {
        itemLines.push({ text: line.text.slice(contentIndent), n: line.n });
        itemEnd = line.n;
        i += 1;
        continue;
      }
      if (LIST_ITEM.test(line.text) || startsNewBlock(line.text)) break;
      itemLines.push({ text: line.text.trim(), n: line.n }); // lazy continuation
      itemEnd = line.n;
      i += 1;
    }

    while (itemLines.length > 0 && isBlank(itemLines[itemLines.length - 1]!.text)) itemLines.pop();
    items.push({ children: parseBlocks(itemLines), line: itemStart, endLine: itemEnd });
    lastLine = itemEnd;
  }

  return {
    block: { kind: "list", ordered, start, tight: !loose, items, line: firstLine, endLine: lastLine },
    next: i,
  };
}

/** Splits a table row on unescaped pipes. */
function splitRow(line: string): string[] {
  const cells: string[] = [];
  let cell = "";
  for (let i = 0; i < line.length; i += 1) {
    const ch = line[i]!;
    if (ch === "\\" && line[i + 1] === "|") {
      cell += "|";
      i += 1;
      continue;
    }
    if (ch === "|") {
      cells.push(cell);
      cell = "";
      continue;
    }
    cell += ch;
  }
  cells.push(cell);
  if (cells.length > 0 && cells[0]!.trim() === "") cells.shift();
  if (cells.length > 0 && cells[cells.length - 1]!.trim() === "") cells.pop();
  return cells.map((value) => value.trim());
}

function parseTable(lines: SourceLine[], from: number): { block: Block; next: number } {
  const head = splitRow(lines[from]!.text);
  const align = splitRow(lines[from + 1]!.text).map((spec) => {
    const left = spec.startsWith(":");
    const right = spec.endsWith(":");
    if (left && right) return "center";
    if (right) return "right";
    if (left) return "left";
    return null;
  });

  const rows: string[][] = [];
  let i = from + 2;
  let end = lines[from + 1]!.n;
  while (i < lines.length) {
    const line = lines[i]!;
    if (isBlank(line.text) || !line.text.includes("|") || HEADING.test(line.text)) break;
    const cells = splitRow(line.text);
    while (cells.length < head.length) cells.push("");
    rows.push(cells.slice(0, head.length));
    end = line.n;
    i += 1;
  }

  return { block: { kind: "table", head, align, rows, line: lines[from]!.n, endLine: end }, next: i };
}

// ---------------------------------------------------------------------------
// Inline rendering
// ---------------------------------------------------------------------------

const ESCAPES: Record<string, string> = {
  "&": "&amp;",
  "<": "&lt;",
  ">": "&gt;",
  '"': "&quot;",
  "'": "&#39;",
};

function escapeHtml(text: string): string {
  return text.replace(/[&<>"']/g, (ch) => ESCAPES[ch]!);
}

const PUNCTUATION = /[\\`*_{}[\]()#+\-.!~<>|]/;

/**
 * Only schemes that cannot execute. A plan file arrives from wherever the human
 * got it, so `javascript:` and `data:` never become an `href` — the link text is
 * rendered as plain text instead, which is visible rather than silently dropped.
 */
function safeUrl(raw: string): string | null {
  const url = raw.trim().replace(/^<(.*)>$/, "$1");
  if (/^[a-z][a-z0-9+.-]*:/i.test(url) && !/^(?:https?|mailto|tel|ftp):/i.test(url)) return null;
  return url;
}

interface Match {
  html: string;
  end: number;
}

function matchCodeSpan(src: string, start: number): Match | null {
  const open = /^`+/.exec(src.slice(start))![0];
  const closeAt = src.indexOf(open, start + open.length);
  if (closeAt === -1) return null;
  if (src[closeAt + open.length] === "`") return null; // longer run: not our closer
  let code = src.slice(start + open.length, closeAt);
  if (code.length > 2 && code.startsWith(" ") && code.endsWith(" ") && code.trim() !== "") {
    code = code.slice(1, -1);
  }
  return { html: `<code>${escapeHtml(code)}</code>`, end: closeAt + open.length };
}

/** `[text](dest "title")` — returns the label span and the destination. */
function matchLinkParts(src: string, start: number): { label: string; dest: string; end: number } | null {
  if (src[start] !== "[") return null;
  let depth = 0;
  let close = -1;
  for (let i = start; i < src.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (src[i] === "[") depth += 1;
    else if (src[i] === "]") {
      depth -= 1;
      if (depth === 0) {
        close = i;
        break;
      }
    }
  }
  if (close === -1 || src[close + 1] !== "(") return null;

  let parens = 0;
  let end = -1;
  for (let i = close + 1; i < src.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (src[i] === "(") parens += 1;
    else if (src[i] === ")") {
      parens -= 1;
      if (parens === 0) {
        end = i;
        break;
      }
    }
  }
  if (end === -1) return null;

  const inner = src.slice(close + 2, end).trim();
  const titled = /^(\S+)\s+["'(].*["')]$/.exec(inner);
  return { label: src.slice(start + 1, close), dest: titled ? titled[1]! : inner, end: end + 1 };
}

function findCloser(src: string, from: number, delimiter: string): number {
  for (let i = from; i <= src.length - delimiter.length; i += 1) {
    if (src[i] === "\\") {
      i += 1;
      continue;
    }
    if (!src.startsWith(delimiter, i)) continue;
    if (/\s/.test(src[i - 1] ?? " ")) continue; // ` *` never closes emphasis
    // `_` is not intraword, so snake_case survives a render intact.
    if (delimiter.startsWith("_") && /[\w]/.test(src[i + delimiter.length] ?? "")) continue;
    return i;
  }
  return -1;
}

/**
 * Escapes everything it does not recognise, so raw HTML in the source shows up
 * as text. Never called on code spans or fenced blocks — those are escaped and
 * emitted verbatim by their callers, which is why a `**` inside a fence stays a
 * `**`.
 */
export function renderInline(src: string): string {
  let out = "";
  let plain = "";
  let i = 0;
  const flush = () => {
    out += escapeHtml(plain);
    plain = "";
  };

  while (i < src.length) {
    const ch = src[i]!;

    if (ch === "\\" && PUNCTUATION.test(src[i + 1] ?? "")) {
      plain += src[i + 1];
      i += 2;
      continue;
    }

    if (ch === "`") {
      const span = matchCodeSpan(src, i);
      if (span) {
        flush();
        out += span.html;
        i = span.end;
        continue;
      }
    }

    if (ch === "!" && src[i + 1] === "[") {
      const link = matchLinkParts(src, i + 1);
      if (link) {
        const dest = safeUrl(link.dest);
        flush();
        out += dest
          ? `<img src="${escapeHtml(dest)}" alt="${escapeHtml(link.label)}">`
          : escapeHtml(link.label);
        i = link.end;
        continue;
      }
    }

    if (ch === "[") {
      const link = matchLinkParts(src, i);
      if (link) {
        const dest = safeUrl(link.dest);
        flush();
        out += dest
          ? `<a href="${escapeHtml(dest)}">${renderInline(link.label)}</a>`
          : renderInline(link.label);
        i = link.end;
        continue;
      }
    }

    if (ch === "<") {
      const auto = /^<((?:https?|mailto|ftp):[^>\s]+|[^\s@<>]+@[^\s@<>]+\.[^\s@<>]+)>/.exec(src.slice(i));
      if (auto) {
        const target = auto[1]!;
        const href = target.includes("@") && !target.includes(":") ? `mailto:${target}` : target;
        flush();
        out += `<a href="${escapeHtml(href)}">${escapeHtml(target)}</a>`;
        i += auto[0].length;
        continue;
      }
    }

    if ((ch === "h" || ch === "w") && /[\s(]|^$/.test(src[i - 1] ?? "")) {
      const bare = /^(https?:\/\/[^\s<>()]+[^\s<>().,;:!?])/.exec(src.slice(i));
      if (bare) {
        flush();
        out += `<a href="${escapeHtml(bare[1]!)}">${escapeHtml(bare[1]!)}</a>`;
        i += bare[1]!.length;
        continue;
      }
    }

    if (ch === "~" && src[i + 1] === "~") {
      const close = findCloser(src, i + 2, "~~");
      if (close > i + 2) {
        flush();
        out += `<del>${renderInline(src.slice(i + 2, close))}</del>`;
        i = close + 2;
        continue;
      }
    }

    if (ch === "*" || ch === "_") {
      const intraword = ch === "_" && /[\w]/.test(src[i - 1] ?? "");
      const doubled = src[i + 1] === ch;
      const delimiter = doubled ? ch + ch : ch;
      if (!intraword && !/\s/.test(src[i + delimiter.length] ?? " ")) {
        const close = findCloser(src, i + delimiter.length, delimiter);
        if (close > i + delimiter.length) {
          const tag = doubled ? "strong" : "em";
          flush();
          out += `<${tag}>${renderInline(src.slice(i + delimiter.length, close))}</${tag}>`;
          i = close + delimiter.length;
          continue;
        }
      }
    }

    plain += ch;
    i += 1;
  }

  flush();
  return out;
}

/**
 * A plain-text label for `RenderedBlock.text`. It strips markers rather than
 * converting: this is what the agent is shown to identify a block, never
 * anything written back to the file.
 */
function stripInline(src: string): string {
  return src
    .replace(/!\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/\[([^\]]*)\]\([^)]*\)/g, "$1")
    .replace(/`+/g, "")
    .replace(/\*\*|__|~~/g, "")
    .replace(/(^|[^\w])[*_]([^*_]+)[*_]/g, "$1$2")
    .replace(/\s+/g, " ")
    .trim();
}

// ---------------------------------------------------------------------------
// Ids, sections, and the source map
// ---------------------------------------------------------------------------

function slugify(text: string): string {
  return stripInline(text)
    .toLowerCase()
    .replace(/[^\p{Letter}\p{Number}]+/gu, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 60);
}

function buildSections(blocks: Block[]): Node[] {
  const root: Node[] = [];
  const stack: { level: number; node: SectionNode }[] = [];

  for (const block of blocks) {
    if (block.kind === "heading") {
      // A section runs until the next heading of equal or higher level, because
      // attribution credits a change to the section reported around it — a flat
      // list of headings would credit every edit to the first one.
      while (stack.length > 0 && stack[stack.length - 1]!.level >= block.level) stack.pop();
      const node: SectionNode = { kind: "section", heading: block, children: [] };
      (stack[stack.length - 1]?.node.children ?? root).push(node);
      stack.push({ level: block.level, node });
      continue;
    }
    (stack[stack.length - 1]?.node.children ?? root).push(block);
  }

  return root;
}

function lastLineOf(node: Node): number {
  if (node.kind !== "section") return node.endLine;
  return node.children.reduce((max, child) => Math.max(max, lastLineOf(child)), node.heading.endLine);
}

function blockText(block: Block): string {
  switch (block.kind) {
    case "heading":
    case "paragraph":
      return stripInline(block.text);
    case "code":
      return block.code.trim();
    case "hr":
      return "";
    case "quote":
      return block.children.map(blockText).join(" ").trim();
    case "list":
      return block.items
        .map((item) => item.children.map(blockText).join(" ").trim())
        .join(" · ")
        .trim();
    case "table":
      return [block.head, ...block.rows].map((row) => row.map(stripInline).join(" | ")).join(" ; ");
  }
}

interface Scope {
  /** Slug of the nearest enclosing heading; ids under it are `<prefix>-b<n>`. */
  prefix: string;
  counter: { n: number };
}

class Renderer {
  readonly blocks: RenderedBlock[] = [];
  // `doc` is claimed up front so it can never collide with a heading slug: the
  // preamble before the first heading hangs off it.
  private readonly used = new Set<string>(["doc"]);

  /**
   * Never returns an id twice. `diffDocuments` keys on id and silently keeps
   * only the first element with a given one, so a duplicate would make a whole
   * section invisible to the diff and to every edit anchored in it.
   */
  claim(base: string): string {
    const root = base || "block";
    if (!this.used.has(root)) {
      this.used.add(root);
      return root;
    }
    for (let suffix = 2; ; suffix += 1) {
      const candidate = `${root}-${suffix}`;
      if (!this.used.has(candidate)) {
        this.used.add(candidate);
        return candidate;
      }
    }
  }

  record(entry: RenderedBlock): RenderedBlock {
    this.blocks.push(entry);
    return entry;
  }

  nodes(nodes: Node[], scope: Scope): string {
    return nodes.map((node) => this.node(node, scope)).join("\n");
  }

  private node(node: Node, scope: Scope): string {
    if (node.kind !== "section") return this.block(node, scope);

    const heading = node.heading;
    const id = this.claim(slugify(heading.text) || `${scope.prefix}-section`);
    const entry = this.record({
      id,
      line: heading.line,
      endLine: heading.endLine,
      kind: "section",
      text: stripInline(heading.text),
    });
    const headingId = this.claim(`${id}-h`);
    this.record({
      id: headingId,
      line: heading.line,
      endLine: heading.endLine,
      kind: `h${heading.level}`,
      text: stripInline(heading.text),
    });

    // Children are numbered from this section's own slug, so adding a paragraph
    // to one section never renumbers — and never orphans the anchors of — any
    // other section.
    const inner = this.nodes(node.children, { prefix: id, counter: { n: 0 } });
    entry.endLine = lastLineOf(node);

    const tag = `h${heading.level}`;
    const body = inner ? `\n${inner}` : "";
    return `<section id="${id}">\n<${tag} id="${headingId}">${renderInline(heading.text)}</${tag}>${body}\n</section>`;
  }

  private block(block: Block, scope: Scope): string {
    scope.counter.n += 1;
    const id = this.claim(`${scope.prefix}-b${scope.counter.n}`);
    const record = (kind: string) =>
      this.record({ id, line: block.line, endLine: block.endLine, kind, text: blockText(block) });

    switch (block.kind) {
      case "heading": {
        // Only reachable for a heading inside a list item or quote, where the
        // section tree does not apply.
        record(`h${block.level}`);
        return `<h${block.level} id="${id}">${renderInline(block.text)}</h${block.level}>`;
      }
      case "paragraph": {
        record("p");
        return `<p id="${id}">${renderInline(block.text)}</p>`;
      }
      case "code": {
        record("pre");
        const cls = block.lang ? ` class="language-${escapeHtml(block.lang)}"` : "";
        return `<pre id="${id}"><code${cls}>${escapeHtml(block.code)}</code></pre>`;
      }
      case "hr": {
        record("hr");
        return `<hr id="${id}">`;
      }
      case "quote": {
        record("blockquote");
        const inner = this.nodes(block.children, scope);
        return `<blockquote id="${id}">\n${inner}\n</blockquote>`;
      }
      case "list": {
        const tag = block.ordered ? "ol" : "ul";
        record(tag);
        const start = block.ordered && block.start !== 1 ? ` start="${block.start}"` : "";
        const items = block.items.map((item) => this.listItem(item, block.tight, scope)).join("\n");
        return `<${tag} id="${id}"${start}>\n${items}\n</${tag}>`;
      }
      case "table": {
        record("table");
        const cell = (tag: string, value: string, index: number) => {
          const align = block.align[index];
          return `<${tag}${align ? ` style="text-align:${align}"` : ""}>${renderInline(value)}</${tag}>`;
        };
        const head = block.head.map((value, index) => cell("th", value, index)).join("");
        const rows = block.rows
          .map((row) => `<tr>${row.map((value, index) => cell("td", value, index)).join("")}</tr>`)
          .join("\n");
        const body = rows ? `\n<tbody>\n${rows}\n</tbody>` : "";
        return `<table id="${id}">\n<thead>\n<tr>${head}</tr>\n</thead>${body}\n</table>`;
      }
    }
  }

  private listItem(item: ListItem, tight: boolean, scope: Scope): string {
    scope.counter.n += 1;
    const id = this.claim(`${scope.prefix}-b${scope.counter.n}`);
    this.record({
      id,
      line: item.line,
      endLine: item.endLine,
      kind: "li",
      text: item.children.map(blockText).join(" ").trim(),
    });

    const children = [...item.children];
    // A tight item's leading paragraph is unwrapped, per the usual markdown
    // rule; the nested blocks after it still render normally.
    let lead = "";
    const first = children[0];
    if (tight && first && first.kind === "paragraph") {
      lead = renderInline(first.text);
      children.shift();
    }
    const rest = this.nodes(children, scope);
    if (!rest) return `<li id="${id}">${lead}</li>`;
    return `<li id="${id}">${lead ? `${lead}\n` : "\n"}${rest}\n</li>`;
  }
}

// ---------------------------------------------------------------------------
// Document shell
// ---------------------------------------------------------------------------

// Three theme states, not two: system (no attribute), forced light, forced dark.
// plan-editor's toolbar sets `data-theme` on the artifact's root, and an artifact
// that only carries the media query keeps following the OS instead — which reads
// as a broken page sitting next to a chrome that just switched. Both selectors
// are required; neither alone can express "force light on a dark OS".
const STYLESHEET = `
:root {
  --bg: #ffffff;
  --fg: #18181b;
  --muted: #71717a;
  --line: #e4e4e7;
  --accent: #4f46e5;
  --panel: #f6f6f7;
  color-scheme: light;
}
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) {
    --bg: #0b0b0e;
    --fg: #f4f4f5;
    --muted: #a1a1aa;
    --line: #27272a;
    --accent: #a5b4fc;
    --panel: #16161a;
    color-scheme: dark;
  }
}
:root[data-theme="dark"] {
  --bg: #0b0b0e;
  --fg: #f4f4f5;
  --muted: #a1a1aa;
  --line: #27272a;
  --accent: #a5b4fc;
  --panel: #16161a;
  color-scheme: dark;
}
:root[data-theme="light"] {
  --bg: #ffffff;
  --fg: #18181b;
  --muted: #71717a;
  --line: #e4e4e7;
  --accent: #4f46e5;
  --panel: #f6f6f7;
  color-scheme: light;
}
* { box-sizing: border-box; }
body {
  margin: 0;
  background: var(--bg);
  color: var(--fg);
  font: 16px/1.65 ui-sans-serif, -apple-system, "Segoe UI", Roboto, sans-serif;
}
main {
  max-width: 46rem;
  margin: 0 auto;
  padding: 3rem 1.5rem 6rem;
}
h1, h2, h3, h4, h5, h6 { line-height: 1.25; margin: 2.2rem 0 0.8rem; font-weight: 650; }
h1 { font-size: 2rem; margin-top: 0; }
h2 { font-size: 1.5rem; }
h3 { font-size: 1.2rem; }
h4, h5, h6 { font-size: 1rem; }
section > :first-child { margin-top: 0; }
p, ul, ol, blockquote, pre, table { margin: 0 0 1rem; }
ul, ol { padding-left: 1.5rem; }
li { margin: 0.25rem 0; }
li > ul, li > ol { margin: 0.25rem 0; }
a { color: var(--accent); }
strong { font-weight: 650; }
del { color: var(--muted); }
code {
  font: 0.875em/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 4px;
  padding: 0.1em 0.3em;
}
pre {
  background: var(--panel);
  border: 1px solid var(--line);
  border-radius: 8px;
  padding: 0.9rem 1rem;
  overflow-x: auto;
}
pre code { background: none; border: 0; padding: 0; }
blockquote {
  border-left: 3px solid var(--line);
  margin-left: 0;
  padding: 0.1rem 0 0.1rem 1rem;
  color: var(--muted);
}
hr { border: 0; border-top: 1px solid var(--line); margin: 2rem 0; }
table { border-collapse: collapse; width: 100%; display: block; overflow-x: auto; }
th, td { border: 1px solid var(--line); padding: 0.45rem 0.7rem; text-align: left; }
th { background: var(--panel); font-weight: 650; }
img { max-width: 100%; }
`.trim();

/**
 * Renders markdown to a complete standalone document plus a map from every
 * emitted id to its source line range. The line range is the point: an agent
 * editing a `.md` file can act on "PLAN.md:42-47" and cannot do anything useful
 * with a CSS selector.
 */
export function renderMarkdown(source: string, options?: { title?: string }): RenderedMarkdown {
  const blocks = parseBlocks(toLines(source));
  const tree = buildSections(blocks);
  const renderer = new Renderer();
  const body = renderer.nodes(tree, { prefix: "doc", counter: { n: 0 } });

  const firstHeading = blocks.find((block) => block.kind === "heading");
  const title = options?.title ?? (firstHeading ? stripInline(firstHeading.text) : "") ?? "";

  const html = [
    "<!doctype html>",
    '<html lang="en">',
    "<head>",
    '<meta charset="utf-8">',
    '<meta name="viewport" content="width=device-width, initial-scale=1">',
    `<title>${escapeHtml(title || "Document")}</title>`,
    `<style>\n${STYLESHEET}\n</style>`,
    "</head>",
    "<body>",
    '<main id="doc">',
    body,
    "</main>",
    "</body>",
    "</html>",
    "",
  ].join("\n");

  return { html, blocks: renderer.blocks };
}
