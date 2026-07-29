// Slicing id'd elements out of an HTML string, without a DOM.
//
// The browser is where this tool does its DOM work — `diffDocuments` and
// `morphDocument` both run there precisely because a real document already
// exists. But the server needs the same shape for churn (how often has each
// section been rewritten across 40 snapshots?), and spinning up a parser per
// snapshot to answer a question about counting is not worth it. jsdom is a dev
// dependency and must stay one; it is not installed for users.
//
// So: a tag-balancing scan. It is deliberately conservative — anything it
// cannot bracket confidently is simply not reported, because a *wrong* slice
// would silently attribute one section's rewrites to another, and an absent
// entry is honest where a wrong one is not.

/** Elements that never have a closing tag, so must never push onto the stack. */
const VOID = new Set([
  "area",
  "base",
  "br",
  "col",
  "embed",
  "hr",
  "img",
  "input",
  "link",
  "meta",
  "param",
  "source",
  "track",
  "wbr",
]);

/** Elements whose content is text, not markup, and must not be tokenized. */
const RAW_TEXT = new Set(["script", "style", "textarea", "title"]);

const TAG = /<!--[\s\S]*?-->|<!\[CDATA\[[\s\S]*?\]\]>|<!?\/?([a-zA-Z][a-zA-Z0-9-]*)((?:"[^"]*"|'[^']*'|[^>"'])*)>/g;

function idOf(attributes: string): string | null {
  const match = /\bid\s*=\s*("([^"]*)"|'([^']*)'|([^\s"'=<>`]+))/i.exec(attributes);
  const value = match?.[2] ?? match?.[3] ?? match?.[4] ?? null;
  return value?.trim() ? value.trim() : null;
}

/**
 * Maps every id'd element to its markup. First occurrence wins, matching
 * `diffDocuments`'s own rule — a document with duplicate ids is already broken
 * for this tool and `doctor` reports it as an error rather than either of us
 * guessing which one was meant.
 */
export function sectionsOf(html: string): Map<string, string> {
  const found = new Map<string, string>();
  const stack: Array<{ name: string; id: string | null; start: number }> = [];

  TAG.lastIndex = 0;
  let match: RegExpExecArray | null;
  while ((match = TAG.exec(html)) !== null) {
    const name = match[1]?.toLowerCase();
    if (!name) continue; // comment or CDATA
    const raw = match[0];
    if (raw.startsWith("</")) {
      // Unwind to the nearest matching open tag. Anything skipped was left
      // unclosed by the author; dropping it beats mis-bracketing what follows.
      for (let depth = stack.length - 1; depth >= 0; depth -= 1) {
        if (stack[depth]!.name !== name) continue;
        const opened = stack[depth]!;
        if (opened.id && !found.has(opened.id)) {
          found.set(opened.id, html.slice(opened.start, match.index + raw.length));
        }
        stack.length = depth;
        break;
      }
      continue;
    }
    if (raw.startsWith("<!")) continue;
    if (VOID.has(name) || raw.endsWith("/>")) continue;
    if (RAW_TEXT.has(name)) {
      const close = html.toLowerCase().indexOf(`</${name}`, TAG.lastIndex);
      if (close !== -1) TAG.lastIndex = close;
      continue;
    }
    stack.push({ name, id: idOf(match[2] ?? ""), start: match.index });
  }
  return found;
}

/**
 * Replaces one id'd element's markup in `html`. Returns null when the id is not
 * bracketable, so the caller can refuse rather than write a mangled document —
 * a half-applied revert is worse than a refused one.
 */
export function replaceSection(html: string, id: string, markup: string): string | null {
  const sections = sectionsOf(html);
  const existing = sections.get(id);
  if (existing === undefined) return null;
  const at = html.indexOf(existing);
  if (at === -1) return null;
  return html.slice(0, at) + markup + html.slice(at + existing.length);
}
