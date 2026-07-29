// Mermaid diagrams, rendered beside their source and never over it.
//
// A diagram is the one thing in an artifact a human cannot point at. The file
// holds `graph TD; A --> B` and the reader sees a picture, so a note written
// against the picture has to reach the agent as a statement about the *text*.
// That is the shape of this whole module: render into a sibling, keep the
// authored block exactly where it is, and anchor every note to it.
//
// Three rules carry it, and each one is a defect the tool this replaces shipped:
//
//   1. IDENTITY IS THE HOST ELEMENT, NEVER ITS POSITION. Diagrams were keyed by
//      ordinal among `.mermaid` elements, so inserting one at the top of a
//      document silently handed every saved diagram below it its neighbour's
//      state. Everything else here diffs by element `id`; a diagram is no
//      different.
//   2. THE RENDERED SVG IS `data-pe-ui`. It is generated in the browser and
//      exists nowhere in the file, so without that attribute the very next
//      morph deletes it — the picture vanishes on the first unrelated edit and
//      comes back only when something happens to re-render it.
//   3. THE SOURCE BLOCK STAYS PUT, hidden but present, with its id and its text
//      intact. Rendering *into* it would make the live DOM differ from the file
//      permanently, which reports the block changed on every patch and marks
//      every note anchored to it addressed — and for this feature every note
//      about a diagram is anchored to it. Leaving it alone also means the
//      element diff, anchor resolution and the word-level highlight go on
//      operating on the text the agent actually edits.
//
// The one cost of rule 3, stated plainly because it is real: the container is a
// child of whatever element encloses the diagram, and `markupWithoutOurClasses`
// strips our *classes*, not our *nodes* — so that enclosing element compares as
// changed on every patch, exactly as a lock badge placed inside a locked element
// would. A note anchored to the diagram itself is unaffected (verified: the
// host's stripped markup is byte-identical to the file's), but a note anchored
// to the section *around* it can be reported addressed by an edit elsewhere. The
// alternative — the body-level page-coordinate layer the lock badges use — is
// not available to a picture that has to occupy space in the document and reflow
// with it. The real fix is for the morph comparison to ignore `[data-pe-ui]`
// subtrees, which would retire the lock-badge constraint at the same time.

import { hashText } from "./anchor.ts";
import { UI_ATTRIBUTE } from "./morph.ts";

/**
 * The three shapes a diagram arrives in.
 *
 * `pre.mermaid` and a bare `.mermaid` are the convention pasted artifacts use —
 * supporting both is what makes a document written elsewhere render here without
 * being rewritten first. The `<pre><code class="language-mermaid">` shape is
 * what `src/markdown.ts` emits for a ```mermaid fence, which is how every
 * markdown artifact expresses one.
 */
const HOST_SELECTOR = "pre.mermaid, .mermaid, pre > code.language-mermaid";

/** Served by the server only as `/mermaid.js`, and fetched as a classic script:
 *  the artifact frame has an opaque origin, so a module `import()` would need
 *  CORS the server deliberately does not grant. */
const MERMAID_URL = "/mermaid.js";

const CONTAINER_CLASS = "pe-diagram";
const SOURCE_CLASS = "pe-diagram-source";
const ERROR_CLASS = "pe-diagram-error";
const ID_PREFIX = "pe-d";

/** Long enough to name a node, short enough to read in a review row. The
 *  protocol caps `anchor.node.label` at 200, so this can never be the thing that
 *  gets an item rejected at the edge. */
const LABEL_LIMIT = 120;

// --- reading the source -----------------------------------------------------

/** The diagram text a host element holds. */
export function mermaidSource(host: Element): string {
  const code = host.querySelector("code");
  return dedent(readSource(code ?? host)).trim();
}

/**
 * Read from markup, the way mermaid's own scanner reads — not from `textContent`.
 *
 * `C["Deploy<br/>to prod"]` written into an HTML artifact is parsed by the
 * browser into a real `<br>` element, and a `<br>` contributes no character at
 * all to `textContent`. The naive read therefore hands mermaid `Deployto prod`
 * and the line break the author wrote is gone from the picture with nothing to
 * show it ever existed. Mermaid's own `run()` reads `innerHTML` for exactly this
 * reason.
 *
 * Which forces the entities to be decoded here, because `innerHTML` hands them
 * back escaped: `src/markdown.ts` emits a fence through `escapeHtml`, so every
 * arrow in a markdown artifact arrives as `--&gt;` and fails to parse.
 *
 * The order is the whole trick. Breaks are turned into escaped *text* before the
 * remaining tags are dropped, so the one element mermaid cares about survives
 * while a syntax highlighter's `<span>`s do not. Any `<` still in the markup by
 * then is a tag by definition — a literal one in the file would have arrived
 * escaped.
 */
function readSource(element: Element): string {
  const markup = element.innerHTML.replace(/<br\s*\/?>/gi, "&lt;br/&gt;").replace(/<[^>]*>/g, "");
  const decoder = element.ownerDocument.createElement("div");
  decoder.innerHTML = markup;
  return (decoder.textContent ?? "").replace(/\r\n?/g, "\n");
}

/**
 * Strips the *common* leading indentation, and only that.
 *
 * An author indents a `<pre class="mermaid">` block to match the HTML around it,
 * and that indentation belongs to the file's formatting, not to the diagram —
 * left in, it also makes two identical diagrams hash differently depending on
 * how deeply they happen to be nested. Only the shared prefix goes, because
 * `mindmap` gives relative indentation meaning and a naive per-line trim would
 * flatten it into a single level.
 */
function dedent(text: string): string {
  const lines = text.split("\n");
  let indent = Infinity;
  for (const line of lines) {
    if (!line.trim()) continue;
    indent = Math.min(indent, line.length - line.trimStart().length);
  }
  if (indent === Infinity || indent === 0) return text;
  return lines.map((line) => line.slice(indent)).join("\n");
}

/**
 * Identity of the diagram *source*, used to skip re-rendering diagrams that did
 * not change.
 *
 * This is not an optimisation to have on principle: `refreshDiagrams` runs after
 * every morph, and a morph is one keystroke-sized edit anywhere in the document.
 * Re-laying-out a two-hundred-node graph because a heading three sections away
 * gained a comma is tens of milliseconds of visible redraw for nothing.
 *
 * `hashText` from anchor.ts rather than a second hash function — it collapses
 * whitespace, which is exactly the insensitivity wanted here. It also lowercases,
 * because for prose "Risks" becoming "risks" is a formatting change; for a
 * diagram it is a visible relabel, so each uppercase letter is marked before
 * hashing and survives the fold.
 */
export function sourceHash(source: string): string {
  return hashText(source.replace(/[A-Z]/g, (letter) => `^${letter}`));
}

/**
 * The identity of a diagram, and the namespace every id inside its rendered SVG
 * is generated under.
 *
 * The host's own `id` when it has one — the same key idiomorph matches on, the
 * element diff attributes by, and `doctor` nags about. Failing that, a hash of
 * the source: stable when a diagram is inserted above this one, stable when the
 * agent edits a *different* diagram, neither of which position ever was.
 *
 * The derived id is deliberately NOT written back onto the element. An `id`
 * attribute is neither `data-pe-ui` nor `pe-`-prefixed, so `markupWithoutOurClasses`
 * cannot strip it and the live block would differ from the file forever — which
 * reports it changed on every patch and marks every note on it addressed. That
 * is the exact failure rule 3 in the header exists to avoid, and it would be
 * self-inflicted. `doctor` still wants a real id on the block and still says so;
 * this is a fallback, not a substitute for one.
 *
 * Two diagrams with identical source share an id and so render byte-identical
 * SVGs under identical internal ids. Disambiguating them by ordinal is precisely
 * the bug above, and the two pictures are the same picture, so the collision is
 * left alone.
 */
export function diagramId(host: Element): string {
  return host.id || ID_PREFIX + sourceHash(mermaidSource(host));
}

/**
 * Every diagram in `root`, in document order.
 *
 * Our own rendered output is skipped by `closest([data-pe-ui])` rather than by
 * class name: the container has children, and re-rendering a diagram from the
 * SVG we just generated would replace the picture with a picture of itself.
 */
export function diagramHosts(root: ParentNode = document): Element[] {
  const hosts: Element[] = [];
  for (const match of root.querySelectorAll(HOST_SELECTOR)) {
    // `code.language-mermaid` names the inner element, but the diagram *is* the
    // <pre> around it: that is the block markdown gave an id to, the block the
    // agent edits, and the block a note has to anchor to.
    const host = match.tagName === "CODE" ? match.parentElement : match;
    if (!host) continue;
    if (host.closest(`[${UI_ATTRIBUTE}]`)) continue;
    // `pre.mermaid` matches two of the three selectors above.
    if (hosts.includes(host)) continue;
    hosts.push(host);
  }
  return hosts;
}

// --- the lazily-loaded library ----------------------------------------------

type Mermaid = NonNullable<Window["__peMermaid"]>;

/** One shared promise, so the concurrent callers a burst of morphs produces do
 *  not each append a script tag and fetch 2.6MB. */
let loading: Promise<Mermaid | null> | null = null;

function loadMermaid(): Promise<Mermaid | null> {
  if (loading) return loading;
  loading = new Promise<Mermaid | null>((resolve) => {
    if (window.__peMermaid) {
      resolve(window.__peMermaid);
      return;
    }
    const script = document.createElement("script");
    // Ours, and not in the file: without the attribute the next morph removes
    // the tag, and the scan after that fetches the whole bundle again.
    script.setAttribute(UI_ATTRIBUTE, "");
    script.src = MERMAID_URL;
    script.addEventListener("load", () => resolve(window.__peMermaid ?? null));
    // Resolves null rather than rejecting. Every caller has the same answer to a
    // failed load — leave the source visible — and a rejection from a frame with
    // no console anyone is watching would surface as nothing at all.
    script.addEventListener("error", () => resolve(null));
    document.head.appendChild(script);
  });
  return loading;
}

/**
 * `null` until mermaid has been configured, then the theme it was configured
 * for. `initialize` is global and re-entrant, so this is a guard against calling
 * it once per diagram per patch rather than against calling it twice.
 */
let configuredTheme: "default" | "dark" | null = null;

function configure(mermaid: Mermaid): void {
  if (configuredTheme === theme) return;
  mermaid.initialize({
    // We own the scan. `startOnLoad` would race it, and mermaid's own scan
    // renders *into* the element it finds — the one thing this module must not
    // do to the file's own markup.
    startOnLoad: false,
    securityLevel: "strict",
    // Ids inside the SVG are minted from a counter unless this is on, so the
    // same diagram re-rendered after an unrelated patch would name its nodes
    // differently every time. A note records the node id it was written
    // against; with a counter, that id names nothing five minutes later.
    deterministicIds: true,
    deterministicIDSeed: ID_PREFIX,
    // Mermaid's own error graphic is drawn into <body> — a node that is not in
    // the file and not ours, which the next morph tears out mid-render. We show
    // the failure ourselves, in a container morph already knows to leave alone.
    suppressErrorRendering: true,
    theme,
  });
  configuredTheme = theme;
}

// --- rendering --------------------------------------------------------------

interface Rendered {
  /** Render namespace, so the SVG's internal ids are stable across re-renders. */
  id: string;
  /** Source hash at the time of the last attempt — including a failed one, so a
   *  diagram that cannot parse is not retried on every patch until it is edited. */
  hash: string;
  container: HTMLElement;
}

/** Keyed by the live host element, which idiomorph mutates in place and so
 *  preserves across morphs. Weak because a diagram the agent deletes should take
 *  its state with it; there is no cleanup pass and there does not need to be. */
const rendered = new WeakMap<Element, Rendered>();
/** The reverse lookup `diagramNodeAt` needs. Not `previousElementSibling`: a
 *  morph can insert a new element between the source and its container, and a
 *  click would then anchor to whatever landed in between. */
const hostOfContainer = new WeakMap<Element, Element>();

/**
 * Renders every diagram whose source changed.
 *
 * Serialized through one promise chain. Morphs arrive faster than mermaid
 * renders, so two overlapping passes would each find a host with no container
 * yet and insert one — leaving the document with two copies of the same picture
 * and only one of them being updated afterwards.
 */
let queue: Promise<void> = Promise.resolve();

export function refreshDiagrams(options: { force?: boolean } = {}): Promise<void> {
  queue = queue.then(() => scan(Boolean(options.force))).catch(() => {});
  return queue;
}

async function scan(force: boolean): Promise<void> {
  const hosts = diagramHosts();
  // An artifact with no diagram pays nothing: no stylesheet, no listener, and
  // above all no 2.6MB fetch.
  if (hosts.length === 0) return;

  prepare();
  const mermaid = await loadMermaid();
  if (!mermaid) {
    // The source was never hidden (see `renderHost`), so there is nothing to
    // restore — but a diagram that silently stays a code block is a feature that
    // looks absent rather than broken, so say which it is.
    for (const host of hosts) showError(host, "Diagram rendering could not be loaded — showing the source.");
    return;
  }

  configure(mermaid);
  // One at a time. Mermaid measures text by appending a scratch element to
  // <body> during a render; overlapping renders make that window longer for no
  // gain, since the work is layout-bound and single-threaded anyway.
  for (const host of hosts) await renderHost(mermaid, host, force);
}

async function renderHost(mermaid: Mermaid, host: Element, force: boolean): Promise<void> {
  const source = mermaidSource(host);
  const previous = rendered.get(host);
  const hash = sourceHash(source);
  if (!force && previous && previous.hash === hash && previous.container.isConnected) return;

  // An empty block is not a broken diagram — it is a fence the agent is halfway
  // through writing. Leave the source showing and say nothing.
  if (!source) {
    revealSource(host);
    previous?.container.remove();
    rendered.delete(host);
    return;
  }

  // The id a diagram was first rendered under wins over a freshly derived one.
  // For a host with a real `id` they are the same value; for a derived one they
  // are not, because the derivation is a hash of the source and the source is
  // what just changed. Recomputing would renumber every node inside the SVG on
  // the very edit a note about one of those nodes is waiting on.
  const id = previous?.id ?? diagramId(host);
  const container = containerFor(host, previous);
  const renderId = renderIdFor(id);

  try {
    const { svg } = await mermaid.render(renderId, source);
    container.innerHTML = svg;
    // Hidden only now that there is something to look at.
    //
    // Hiding it up front is the obvious order and it is wrong: a diagram that
    // fails to parse, or that is still waiting on a 2.6MB fetch, then leaves a
    // blank gap in the middle of the document — which reads as the document
    // being broken rather than as a picture being on its way.
    host.classList.add(SOURCE_CLASS);
  } catch (error) {
    // `suppressErrorRendering` makes mermaid clean up after itself on the paths
    // that expect to fail, but not on all of them. A stray scratch <div> in the
    // artifact's body is a node that is not in the file and not ours, so the
    // next morph would remove it — possibly while a later render is reading it.
    document.getElementById(`d${renderId}`)?.remove();
    showError(host, `Diagram did not render — ${messageOf(error)}`);
  }

  // Recorded even on failure, so a diagram that cannot parse is retried when the
  // agent edits it and not once per patch until then.
  rendered.set(host, { id, hash, container });
}

/**
 * The sibling the picture goes in.
 *
 * `afterend` rather than replacing the host, and `data-pe-ui` on the container
 * itself rather than on the SVG, so `morphDocument` skips the whole subtree in
 * one check and never has to reason about generated markup.
 */
function containerFor(host: Element, previous: Rendered | undefined): HTMLElement {
  const existing = previous?.container;
  if (existing?.isConnected && existing.previousElementSibling === host) return existing;
  existing?.remove();

  const container = document.createElement("div");
  container.setAttribute(UI_ATTRIBUTE, "");
  container.className = CONTAINER_CLASS;
  host.insertAdjacentElement("afterend", container);
  hostOfContainer.set(container, host);
  return container;
}

/**
 * Mermaid builds a CSS selector out of the render id (`#` + id), so an artifact
 * id containing a dot or a colon would silently select nothing and the render
 * would fail on markup that is perfectly valid HTML.
 */
function renderIdFor(id: string): string {
  return `${ID_PREFIX}-${id.replace(/[^A-Za-z0-9_-]/g, "-")}`;
}

function messageOf(error: unknown): string {
  const text = error instanceof Error ? error.message : String(error);
  return text.replace(/\s+/g, " ").trim().slice(0, 200) || "unknown error";
}

/** Puts the source back on screen. Never leave the reader with a blank space
 *  where a diagram was: the text is what the agent edits anyway, so showing it
 *  is a degraded view rather than a missing one. */
function revealSource(host: Element): void {
  host.classList.remove(SOURCE_CLASS);
}

function showError(host: Element, text: string): void {
  revealSource(host);
  const container = containerFor(host, rendered.get(host));
  container.textContent = "";
  const line = document.createElement("div");
  // Ours as well, so nothing about this element can outlive a morph by accident.
  line.setAttribute(UI_ATTRIBUTE, "");
  line.className = ERROR_CLASS;
  line.textContent = text;
  container.appendChild(line);
}

// --- theme ------------------------------------------------------------------

/** What the chrome last asked for: "light", "dark" or "system". Kept verbatim so
 *  a system-level flip can be re-resolved without another message. */
let requested = "system";
let theme: "default" | "dark" = "default";

export function setDiagramTheme(value: string): void {
  requested = value;
  applyTheme();
}

function resolveTheme(): "default" | "dark" {
  if (requested === "dark") return "dark";
  if (requested === "light") return "default";
  return window.matchMedia?.("(prefers-color-scheme: dark)").matches ? "dark" : "default";
}

/**
 * Re-render, not re-style.
 *
 * Mermaid bakes its palette into the SVG it generates — fills, strokes and a
 * `<style>` block, all computed at render time — so a diagram is the one thing on
 * the page that does not follow the document's colour scheme for free. Left
 * alone it keeps the old theme, which in practice means a white slab glowing in
 * the middle of a dark document.
 */
function applyTheme(): void {
  const next = resolveTheme();
  if (next === theme) return;
  theme = next;
  void refreshDiagrams({ force: true });
}

// --- node targeting ---------------------------------------------------------

export interface DiagramNode {
  /** The source block a note anchors to — the thing that exists in the file. */
  host: Element;
  /** The group under the cursor, for hover feedback. */
  element: Element;
  /** Empty for a click on the diagram's background, which is about the whole
   *  diagram and not about one node. */
  nodeId: string;
  label: string;
}

/**
 * The diagram node under `target`, or null if the click was not in a diagram.
 *
 * The walk upward is the point. A click lands on the `<rect>` behind a box or on
 * the `<text>` inside it, and neither is a thing the human means; the enclosing
 * `<g>` is the node, and it is the only element carrying an id the agent can be
 * told about.
 */
export function diagramNodeAt(target: Element): DiagramNode | null {
  const container = target.closest(`.${CONTAINER_CLASS}`);
  if (!container) return null;
  const host = hostOfContainer.get(container);
  // A container whose host is gone is about to be cleaned up by the next scan.
  // Reporting a node on it would anchor a note to a detached element.
  if (!host?.isConnected) return null;

  for (let node: Element | null = target; node && node !== container; node = node.parentElement) {
    if (!identifiesNode(node)) continue;
    return { host, element: node, nodeId: node.id, label: nodeLabel(node) };
  }

  // Background click. Still an annotation about this diagram — a dead click on
  // the whitespace between two boxes would just look broken — but with nothing
  // to say about which node was meant.
  return { host, element: container, nodeId: "", label: "" };
}

function identifiesNode(element: Element): boolean {
  if (!element.id) return false;
  const name = element.tagName.toLowerCase();
  // The <svg> carries the render id, and "the whole diagram" is not a node —
  // falling through to it would report every background click as a node click.
  if (name === "svg") return false;
  // Mermaid wraps nodes, clusters and edge labels in `<g id="flowchart-A-0">`;
  // an edge itself is a bare `<path id="L_A_B_0">` with no group around it.
  return name === "g" || /^L[_-]/.test(element.id);
}

/**
 * The text of a node, as a human would read it aloud.
 *
 * Two mermaid shapes make the naive `textContent` unusable, and both produce a
 * label that appears nowhere in the source the agent is about to search:
 * `<br>` contributes no character at all, so "Deploy<br/>to prod" reads back as
 * "Deployto prod"; and with HTML labels off, each line is its own `<tspan>`,
 * which concatenate just as tightly.
 */
export function nodeLabel(element: Element): string {
  const clone = element.cloneNode(true) as Element;
  const document_ = element.ownerDocument;
  for (const boundary of clone.querySelectorAll("br, tspan + tspan")) {
    boundary.parentNode?.insertBefore(document_.createTextNode(" "), boundary);
  }
  return (clone.textContent ?? "").replace(/\s+/g, " ").trim().slice(0, LABEL_LIMIT);
}

// --- styles -----------------------------------------------------------------

let prepared = false;

/** Injected on the first scan that finds a diagram, not at import: an artifact
 *  without one should carry no trace of this module at all. */
function prepare(): void {
  if (prepared) return;
  prepared = true;

  const style = document.createElement("style");
  style.setAttribute(UI_ATTRIBUTE, "");
  style.textContent = STYLE;
  document.head.appendChild(style);

  // A system-level theme flip is the one theme change the chrome never sends a
  // message for, because every other element follows `color-scheme` on its own.
  // A diagram cannot: its colours are in generated markup. Without this listener
  // the picture alone stays in yesterday's theme until something else edits it.
  window.matchMedia?.("(prefers-color-scheme: dark)").addEventListener("change", () => {
    if (requested === "system") applyTheme();
  });
}

const STYLE = `
.${CONTAINER_CLASS} { margin: 0 0 1rem; overflow-x: auto; }
.${CONTAINER_CLASS} svg { max-width: 100%; height: auto; }
/* The authored block, kept in the document and out of the way. A pe- class
   rather than an inline style or an attribute: markupWithoutOurClasses strips
   these before comparing, so hiding the source cannot make it look edited. */
.${SOURCE_CLASS} { display: none !important; }
.${ERROR_CLASS} {
  font: 500 12px/1.5 ui-monospace, SFMono-Regular, Menlo, monospace;
  color: #b45309; background: rgba(245,158,11,.12);
  border-left: 3px solid #f59e0b; border-radius: 4px; padding: 6px 10px;
}
/* sdk.ts paints hover with an outline and a background tint. An SVG group has
   neither, so a hovered node would look identical to an unhovered one — the
   glow is the part that is guaranteed to render on generated SVG. The selector
   is deliberately more specific than the sdk rule so it does not depend on
   which stylesheet was appended last. */
.${CONTAINER_CLASS} svg .pe-hover {
  outline-offset: 4px;
  filter: drop-shadow(0 0 2px #6366f1) drop-shadow(0 0 7px rgba(99,102,241,.55));
}
/* The source block wears .pe-pending like any other anchor, and it is hidden, so
   arming a note on a diagram would give the human no feedback in the document at
   all — the one failure mode that reads as a dead click. The container is always
   the source's next sibling, so it can wear the mark on its behalf. */
.pe-annotate .pe-pending + .${CONTAINER_CLASS} {
  outline: 2px dashed #f59e0b; outline-offset: 4px; border-radius: 4px;
}
`;
