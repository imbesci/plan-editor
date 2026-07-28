// The chrome owns all server access. The artifact iframe is sandboxed without
// `allow-same-origin`, so it has an opaque origin and cannot usefully call the
// API — which is also why the session token never leaves this file.

import { diffDocuments, diffWords, type SectionChange } from "../sdk/diff.ts";
import type { AgentIdentityView, AgentPresence, Annotation, ChatMessage, ServerEvent, VersionMeta } from "../protocol.ts";

interface Bootstrap {
  key: string;
  token: string;
  file: string;
  status: "open" | "ended";
}

const bootstrap = JSON.parse(document.getElementById("pe-session")!.textContent!) as Bootstrap;
const { key, token } = bootstrap;

const $ = <T extends HTMLElement>(id: string) => document.getElementById(id) as T;
const frame = $<HTMLIFrameElement>("artifact");
const list = $("list");
const input = $<HTMLTextAreaElement>("input");
const search = $<HTMLInputElement>("search");
const submitButton = $<HTMLButtonElement>("submit");
const endButton = $<HTMLButtonElement>("end");
const modeToggle = $<HTMLInputElement>("modeToggle");
const presence = $("presence");
const undoButton = $<HTMLButtonElement>("undo");
const overlay = $("overlay");
const toasts = $("toasts");
const statusBar = $("statusBar");
const statusText = $("statusText");
const statusAction = $<HTMLButtonElement>("statusAction");
const chatLog = $("chatLog");
const targetHint = $("targetHint");
const layout = $("layout");

interface Draft {
  clientId: string;
  anchors: Array<{ selector: string; text: string }>;
  kind: "element" | "text";
  body: string;
}

type Filter = "open" | "review" | "done" | "all";

let annotations: Annotation[] = [];
let chat: ChatMessage[] = [];
let versions: VersionMeta[] = [];
let presenceState: AgentPresence = "waiting";
let agentView: AgentIdentityView = { session: null, lastContact: null, viaHooks: false };
let drafts: Draft[] = [];
let armed: Draft | null = null;
let repointing: string | null = null;
let filter: Filter = "open";
let query = "";
const trackedIds = new Set<string>();

frame.src = `/artifact/${key}/index.html?t=${encodeURIComponent(token)}`;

function api(pathname: string, init: RequestInit = {}): Promise<globalThis.Response> {
  return fetch(`/api/${key}${pathname}?t=${encodeURIComponent(token)}`, {
    ...init,
    headers: { "content-type": "application/json", ...(init.headers ?? {}) },
  });
}

function toFrame(message: unknown): void {
  frame.contentWindow?.postMessage(message, "*");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[char]};`);
}

// --- user-visible failure ---------------------------------------------------

/**
 * Every failure path used to be a console.error, so a broken morph or a dead
 * server looked identical to "nothing is happening". Anything the user needs to
 * know about goes through here instead.
 */
function toast(message: string, kind: "info" | "error" = "info", ms = 4200): void {
  const el = document.createElement("div");
  el.className = `toast ${kind}`;
  el.textContent = message;
  toasts.appendChild(el);
  setTimeout(() => {
    el.classList.add("out");
    setTimeout(() => el.remove(), 300);
  }, ms);
}

function setStatus(message: string | null, action?: { label: string; run: () => void }): void {
  if (!message) {
    statusBar.hidden = true;
    return;
  }
  statusBar.hidden = false;
  statusText.textContent = message;
  if (action) {
    statusAction.hidden = false;
    statusAction.textContent = action.label;
    statusAction.onclick = action.run;
  } else {
    statusAction.hidden = true;
  }
}

async function guard<T>(what: string, run: () => Promise<T>): Promise<T | null> {
  try {
    return await run();
  } catch (error) {
    console.error(what, error);
    toast(`${what} failed — ${String((error as Error)?.message ?? error)}`, "error");
    return null;
  }
}

function ago(iso: string | undefined): string {
  if (!iso) return "";
  const seconds = Math.max(0, (Date.now() - Date.parse(iso)) / 1000);
  if (seconds < 45) return "just now";
  if (seconds < 3600) return `${Math.round(seconds / 60)}m ago`;
  if (seconds < 86400) return `${Math.round(seconds / 3600)}h ago`;
  return `${Math.round(seconds / 86400)}d ago`;
}

/**
 * Hands every still-open annotation to the SDK so it can re-anchor them. The
 * SDK's anchor map is per page load, so without this an annotation submitted
 * before a reload can never be marked addressed.
 */
function syncTracking(): void {
  for (const annotation of annotations) {
    if (annotation.status !== "submitted" || annotation.tag === "message") continue;
    if (trackedIds.has(annotation.id)) continue;
    trackedIds.add(annotation.id);
    toFrame({
      type: "pe:track",
      id: annotation.id,
      selector: annotation.selector,
      text: annotation.text,
      anchors: annotation.anchors,
    });
  }
}

// --- rendering --------------------------------------------------------------

const STATUS_LABEL: Record<Annotation["status"], string> = {
  draft: "draft",
  submitted: "waiting for agent",
  addressed: "applied — review it",
  resolved: "accepted",
  orphaned: "target changed",
};

type Bucket = "open" | "review" | "done";

const BUCKET: Record<Annotation["status"], Bucket> = {
  draft: "open",
  submitted: "open",
  orphaned: "open",
  addressed: "review",
  resolved: "done",
};

function matchesFilter(annotation: Annotation): boolean {
  if (filter !== "all" && BUCKET[annotation.status] !== filter) return false;
  if (!query) return true;
  return `${annotation.body} ${annotation.text} ${annotation.selector}`.toLowerCase().includes(query);
}

function render(): void {
  const counts: Record<Bucket, number> = { open: 0, review: 0, done: 0 };
  for (const annotation of annotations) counts[BUCKET[annotation.status]] += 1;
  $("countOpen").textContent = String(counts.open);
  $("countReview").textContent = String(counts.review);
  $("countDone").textContent = String(counts.done);
  $("chatCount").textContent = String(chat.length);

  const visible = annotations.filter(matchesFilter);
  const banner =
    counts.open > 0 && presenceState === "waiting"
      ? `<div class="alert"><strong>${counts.open} edit${counts.open === 1 ? "" : "s"} waiting to be picked up.</strong>
           <span>${
             agentView.session
               ? "An agent is bound to this artifact but has not checked in. Send it any message, or have it run watch."
               : "No agent is bound. Install hooks, then edits reach the Claude session you're already in."
           }</span>
           <code>plan-editor watch ${escapeHtml(bootstrap.file)}</code></div>`
      : "";

  const repointBanner = repointing
    ? `<div class="alert repoint"><strong>Pick a new anchor.</strong><span>Click the element this edit should point at.</span>
         <button class="link" data-cancel-repoint>Cancel</button></div>`
    : "";

  const cards = [...visible.map(renderCard), ...drafts.map(renderDraft)];
  const body = cards.length
    ? cards.join("")
    : `<p class="empty">${
        annotations.length === 0
          ? "Turn on Annotate, then click an element — or select some text — and describe the change. It is applied in place, no reload."
          : query
            ? "Nothing matches that filter."
            : "Nothing here. Try another filter."
      }</p>`;

  list.innerHTML = banner + repointBanner + body;
  renderChat();

  undoButton.disabled = versions.length < 2;
  submitButton.disabled = drafts.length === 0 && !input.value.trim();
  submitButton.textContent = drafts.length > 1 ? `Submit ${drafts.length}` : "Submit";
  targetHint.textContent = armed
    ? armed.anchors.length > 1
      ? `${armed.anchors.length} elements selected — ⇧-click to add or remove`
      : `Anchored to “${(armed.anchors[0]?.text ?? "").slice(0, 60)}”`
    : "";
}

function renderChat(): void {
  chatLog.innerHTML = chat.length
    ? chat
        .map(
          (message) =>
            `<div class="msg ${message.role}"><b>${message.role === "agent" ? "Agent" : "You"}</b>
              <span>${escapeHtml(message.text)}</span><time>${ago(message.at)}</time></div>`,
        )
        .join("")
    : `<p class="empty">Replies from your agent appear here.</p>`;
}

function anchorLabel(anchors: Array<{ selector: string; text: string }>, kind: string): string {
  if (anchors.length > 1) {
    return `<span class="chunk">${anchors.length} elements</span> ${escapeHtml(
      anchors.map((anchor) => anchor.text.slice(0, 24)).join(" · ").slice(0, 90),
    )}`;
  }
  const first = anchors[0];
  return `${kind === "text" ? "❝ " : ""}${escapeHtml(first?.text.slice(0, 90) || first?.selector || "whole page")}`;
}

function renderDraft(draft: Draft): string {
  return `<article class="card" data-status="draft">
    <div class="anchor">${anchorLabel(draft.anchors, draft.kind)}</div>
    <div class="body">${escapeHtml(draft.body || "…")}</div>
    <div class="meta"><span class="status">draft</span>
      <button class="link" data-drop-draft="${draft.clientId}">remove</button></div>
  </article>`;
}

function renderCard(annotation: Annotation): string {
  const thread = (annotation.thread ?? [])
    .map(
      (message) =>
        `<div class="msg ${message.role}"><b>${message.role === "human" ? "You" : "Agent"}</b><span>${escapeHtml(message.text)}</span></div>`,
    )
    .join("");

  const actions: string[] = [];
  if (annotation.status === "addressed") {
    actions.push(`<button class="link accept" data-accept="${annotation.id}">Accept</button>`);
    actions.push(`<button class="link reject" data-reject="${annotation.id}">Reject…</button>`);
  }
  if (annotation.status === "orphaned") actions.push(`<button class="link" data-repoint="${annotation.id}">Re-point…</button>`);
  if (annotation.tag !== "message") actions.push(`<button class="link" data-jump="${annotation.id}">Show</button>`);
  actions.push(`<button class="link" data-reply="${annotation.id}">Reply…</button>`);

  const when = annotation.addressedAt ?? annotation.submittedAt ?? annotation.createdAt;
  return `<article class="card" data-status="${annotation.status}" data-id="${escapeHtml(annotation.id)}">
    <div class="anchor">${anchorLabel(annotation.anchors ?? [{ selector: annotation.selector, text: annotation.text }], annotation.tag)}</div>
    <div class="body">${escapeHtml(annotation.body)}</div>
    ${annotation.agentNote ? `<div class="note">${escapeHtml(annotation.agentNote)}</div>` : ""}
    ${thread ? `<div class="thread">${thread}</div>` : ""}
    <div class="meta"><span class="status">${STATUS_LABEL[annotation.status]}</span><time>${ago(when)}</time>${actions.join("")}</div>
  </article>`;
}

// --- annotation flow --------------------------------------------------------

function setMode(next: boolean): void {
  modeToggle.checked = next;
  toFrame({ type: "pe:setMode", value: next });
}

modeToggle.addEventListener("change", () => setMode(modeToggle.checked));
input.addEventListener("input", () => {
  if (armed) armed.body = input.value;
  render();
});
search.addEventListener("input", () => {
  query = search.value.trim().toLowerCase();
  render();
});
$("filters").addEventListener("click", (event) => {
  const chip = (event.target as HTMLElement).closest<HTMLElement>("[data-filter]");
  if (!chip) return;
  filter = chip.dataset.filter as Filter;
  for (const other of $("filters").querySelectorAll(".chip")) other.classList.toggle("active", other === chip);
  render();
});
submitButton.addEventListener("click", () => void submit());

function stageArmed(): void {
  if (!armed) return;
  armed.body = input.value.trim();
  if (!armed.body) {
    toFrame({ type: "pe:cancel", clientId: armed.clientId });
  } else if (!drafts.includes(armed)) {
    drafts.push(armed);
  }
  armed = null;
  input.value = "";
}

async function submit(): Promise<void> {
  stageArmed();
  const freeform = input.value.trim();
  const payload: Array<Record<string, unknown>> = drafts.map((draft) => ({
    body: draft.body,
    selector: draft.anchors[0]?.selector ?? "",
    text: draft.anchors[0]?.text ?? "",
    anchors: draft.anchors,
    tag: draft.kind,
  }));
  if (freeform) payload.push({ body: freeform, selector: "", text: "", tag: "message" });
  if (payload.length === 0) return;

  submitButton.disabled = true;
  const result = await guard("Submitting", async () => {
    const response = await api("/annotations", { method: "POST", body: JSON.stringify({ annotations: payload }) });
    if (!response.ok) throw new Error(`server said ${response.status}`);
    return (await response.json()) as { annotations: Annotation[] };
  });

  if (result) {
    drafts.forEach((draft, index) => {
      const created = result.annotations[index];
      if (created) toFrame({ type: "pe:bind", clientId: draft.clientId, id: created.id });
    });
    drafts = [];
    input.value = "";
    toast(`${payload.length} edit${payload.length === 1 ? "" : "s"} sent to your agent`);
  }
  render();
}

// --- card actions -----------------------------------------------------------

list.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = (name: string) => target.closest(`[data-${name}]`)?.getAttribute(`data-${name}`);

  const drop = action("drop-draft");
  if (drop) {
    drafts = drafts.filter((draft) => draft.clientId !== drop);
    toFrame({ type: "pe:cancel", clientId: drop });
    return render();
  }
  if (target.closest("[data-cancel-repoint]")) {
    repointing = null;
    toFrame({ type: "pe:repoint", id: null });
    return render();
  }

  const jump = action("jump");
  if (jump) {
    const annotation = annotations.find((entry) => entry.id === jump);
    if (annotation) toFrame({ type: "pe:scrollTo", id: jump, selector: annotation.selector, text: annotation.text });
    return;
  }

  const accept = action("accept");
  if (accept) {
    void guard("Accepting", () => api(`/annotations/${accept}/accept`, { method: "POST", body: "{}" }));
    return;
  }

  const reject = action("reject");
  if (reject) {
    const reason = prompt("What's wrong with the change?");
    if (reason?.trim()) {
      void guard("Rejecting", () =>
        api(`/annotations/${reject}/reject`, { method: "POST", body: JSON.stringify({ text: reason.trim() }) }),
      );
    }
    return;
  }

  const reply = action("reply");
  if (reply) {
    const text = prompt("Reply to the agent about this edit:");
    if (text?.trim()) {
      void guard("Replying", () =>
        api(`/annotations/${reply}/reply`, { method: "POST", body: JSON.stringify({ text: text.trim() }) }),
      );
    }
    return;
  }

  const repoint = action("repoint");
  if (repoint) {
    repointing = repoint;
    setMode(true);
    toFrame({ type: "pe:repoint", id: repoint });
    return render();
  }
});

// --- toolbar ----------------------------------------------------------------

undoButton.addEventListener("click", async () => {
  undoButton.disabled = true;
  const done = await guard("Undo", () => api("/restore", { method: "POST", body: "{}" }));
  if (done) toast("Restored the previous version");
});

$("export").addEventListener("click", () => {
  window.open(`/api/${key}/export?t=${encodeURIComponent(token)}`, "_blank");
});

$("share").addEventListener("click", async () => {
  await navigator.clipboard.writeText(location.href).then(
    () => toast("Session link copied"),
    () => toast("Could not copy — the link is in your address bar", "error"),
  );
});

$("collapse").addEventListener("click", () => layout.classList.toggle("collapsed"));
$("history").addEventListener("click", () => void openHistory());
$("help").addEventListener("click", openHelp);
$("switcher").addEventListener("click", () => void openSwitcher());

// --- keyboard ---------------------------------------------------------------

function isTyping(event: KeyboardEvent): boolean {
  const el = event.target as HTMLElement;
  return el.tagName === "TEXTAREA" || el.tagName === "INPUT";
}

document.addEventListener(
  "keydown",
  (event) => {
    const meta = event.metaKey || event.ctrlKey;
    if (meta && event.key.toLowerCase() === "i") {
      event.preventDefault();
      return setMode(!modeToggle.checked);
    }
    if (meta && event.key === "Enter") {
      event.preventDefault();
      return void submit();
    }
    if (meta && event.key.toLowerCase() === "f") {
      event.preventDefault();
      return search.focus();
    }
    if (meta && event.key.toLowerCase() === "z") {
      event.preventDefault();
      return undoButton.click();
    }
    if (meta && event.key.toLowerCase() === "h") {
      event.preventDefault();
      return void openHistory();
    }
    if (meta && event.key === "\\") {
      event.preventDefault();
      return layout.classList.toggle("collapsed");
    }
    if (event.key === "Escape") {
      if (!overlay.hidden) return closeOverlay();
      if (repointing) {
        repointing = null;
        toFrame({ type: "pe:repoint", id: null });
        return render();
      }
      return;
    }
    if (event.key === "?" && !isTyping(event)) {
      event.preventDefault();
      return openHelp();
    }
    if (!overlay.hidden && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      void stepVersion(event.key === "ArrowRight" ? 1 : -1);
    }
  },
  true,
);

// --- overlays ---------------------------------------------------------------

function closeOverlay(): void {
  overlay.hidden = true;
  overlay.innerHTML = "";
  // Leaving a preview on screen would show a version the file no longer holds.
  if (previewing !== null) {
    previewing = null;
    void applyPatch();
  }
}

overlay.addEventListener("click", (event) => {
  if (event.target === overlay) closeOverlay();
});

function openSheet(title: string, inner: string): void {
  overlay.hidden = false;
  overlay.innerHTML = `<div class="sheet">
    <header><h2>${escapeHtml(title)}</h2><button class="link" data-close>Close</button></header>
    ${inner}
  </div>`;
  overlay.querySelector("[data-close]")?.addEventListener("click", closeOverlay);
}

function openHelp(): void {
  const rows: Array<[string, string]> = [
    ["⌘I", "Toggle annotate mode"],
    ["Click", "Anchor an edit to an element"],
    ["Select text, then click", "Anchor to the selection instead"],
    ["⇧-click", "Add another element to the same edit (again to remove)"],
    ["⌘Enter", "Submit staged edits"],
    ["⌘F", "Filter edits"],
    ["⌘Z", "Undo the last change"],
    ["⌘H", "Version history"],
    ["← →", "Scrub versions while history is open"],
    ["⌘\\", "Hide or show the panel"],
    ["Esc", "Close an overlay or cancel re-pointing"],
    ["?", "This list"],
  ];
  openSheet(
    "Shortcuts",
    `<div class="shortcuts">${rows
      .map(([keys, what]) => `<div><kbd>${escapeHtml(keys)}</kbd><span>${escapeHtml(what)}</span></div>`)
      .join("")}</div>`,
  );
}

async function openSwitcher(): Promise<void> {
  const data = await guard("Loading artifacts", async () => {
    const response = await fetch(`/api/sessions?t=${encodeURIComponent(token)}`);
    if (!response.ok) throw new Error(`server said ${response.status}`);
    return (await response.json()) as {
      sessions: Array<{ key: string; name: string; file: string; url: string; open: number; addressed: number }>;
    };
  });
  if (!data) return;

  openSheet(
    "Open artifacts",
    `<div class="sessions">${data.sessions
      .map(
        (entry) => `<a class="session ${entry.key === key ? "current" : ""}" href="${escapeHtml(entry.url)}">
          <span class="name">${escapeHtml(entry.name)}</span>
          <span class="path">${escapeHtml(entry.file)}</span>
          <span class="badges">${entry.open ? `<b class="open">${entry.open} open</b>` : ""}${
            entry.addressed ? `<b class="review">${entry.addressed} to review</b>` : ""
          }${entry.key === key ? '<b class="here">this one</b>' : ""}</span>
        </a>`,
      )
      .join("")}</div>`,
  );
}

// --- versions ---------------------------------------------------------------

/** Snapshots are immutable, so one fetch per version is enough. */
const versionCache = new Map<number, string>();
let previewing: number | null = null;

async function fetchVersion(seq: number): Promise<string> {
  const cached = versionCache.get(seq);
  if (cached !== undefined) return cached;
  const response = await fetch(`/api/${key}/versions/${seq}?t=${encodeURIComponent(token)}`);
  const html = response.ok ? await response.text() : "";
  if (html) versionCache.set(seq, html);
  return html;
}

function selectVersion(seq: number): void {
  for (const button of overlay.querySelectorAll<HTMLButtonElement>(".version")) {
    button.classList.toggle("active", Number(button.dataset.seq) === seq);
  }
}

async function previewVersion(seq: number): Promise<void> {
  const html = await fetchVersion(seq);
  if (!html) return;
  previewing = seq === (versions[versions.length - 1]?.seq ?? -1) ? null : seq;
  toFrame({ type: "pe:preview", html });
}

async function stepVersion(delta: number): Promise<void> {
  const current = previewing ?? versions[versions.length - 1]?.seq;
  const index = versions.findIndex((entry) => entry.seq === current);
  const next = versions[Math.min(versions.length - 1, Math.max(0, index + delta))];
  if (!next || next.seq === current) return;
  selectVersion(next.seq);
  await Promise.all([previewVersion(next.seq), showDiff(next.seq)]);
}

async function openHistory(): Promise<void> {
  const rows = [...versions].reverse();
  openSheet(
    "History",
    `<p class="scrub-hint">Click a version to see it in place. <kbd>←</kbd> <kbd>→</kbd> to scrub.</p>
     <div class="versions">${rows
       .map(
         (version, index) => `<button class="version${index === 0 ? " active" : ""}" data-seq="${version.seq}">
           <span class="seq">v${version.seq}</span>
           <span class="when">${ago(version.at)}</span>
           <span class="origin">${version.origin === "open" ? "initial" : version.origin}</span>
           ${index === 0 ? '<span class="current">current</span>' : ""}
         </button>`,
       )
       .join("")}</div>
     <div class="diff" id="diffPane"><p class="empty">Pick a version to see what changed since it.</p></div>`,
  );

  for (const button of overlay.querySelectorAll<HTMLButtonElement>(".version")) {
    button.addEventListener("click", () => {
      const seq = Number(button.dataset.seq);
      selectVersion(seq);
      void previewVersion(seq);
      void showDiff(seq);
    });
  }
  const latest = versions[versions.length - 1];
  if (latest) void fetchVersion(latest.seq);
  const previous = versions[versions.length - 2];
  if (previous) void fetchVersion(previous.seq);
}

async function showDiff(seq: number): Promise<void> {
  const pane = document.getElementById("diffPane");
  if (!pane) return;
  const current = versions[versions.length - 1];
  if (!current) return;
  pane.innerHTML = `<p class="empty">Comparing…</p>`;

  const [oldHtml, newHtml] = await Promise.all([fetchVersion(seq), fetchVersion(current.seq)]);
  const diff = diffDocuments(oldHtml, newHtml);
  const restore = seq === current.seq ? "" : `<button class="restore" data-restore="${seq}">Restore v${seq}</button>`;

  pane.innerHTML =
    diff.sections.length === 0
      ? `${restore}<p class="empty">${
          diff.unattributed
            ? "Content changed, but not inside any element with an id."
            : "No differences from the current version."
        }</p>`
      : restore + diff.sections.map(renderSectionDiff).join("");

  pane.querySelector("[data-restore]")?.addEventListener("click", async () => {
    await guard("Restore", () => api("/restore", { method: "POST", body: JSON.stringify({ seq }) }));
    previewing = null;
    closeOverlay();
    toast(`Restored v${seq}`);
  });
}

function renderSectionDiff(section: SectionChange): string {
  const head = `<div class="dhead"><span class="dkind ${section.kind}">${section.kind}</span> ${escapeHtml(section.label)}</div>`;
  if (section.kind !== "changed" || section.before === undefined || section.after === undefined) {
    return `<div class="dsection">${head}</div>`;
  }
  const words = diffWords(section.before, section.after)
    .map((op) =>
      op.type === "same"
        ? escapeHtml(op.text)
        : `<span class="${op.type === "add" ? "wadd" : "wdel"}">${escapeHtml(op.text)}</span>`,
    )
    .join("");
  return `<div class="dsection">${head}<div class="dbody">${words}</div></div>`;
}

// --- ending -----------------------------------------------------------------

endButton.addEventListener("click", async () => {
  endButton.disabled = true;
  endButton.textContent = "Ending…";
  await guard("Ending the session", () => api("/end", { method: "POST", body: "{}" }));
  stream.close();
  setMode(false);
  window.close();
  setTimeout(showEndedScreen, 120);
});

function showEndedScreen(): void {
  if (document.querySelector(".ended-screen")) return;
  const screen = document.createElement("div");
  screen.className = "ended-screen";
  screen.innerHTML = `<div>
    <h1>Session ended</h1>
    <p>Nothing further is being sent to your agent. You can close this tab and pick the conversation back up in your terminal.</p>
    <p class="hint">Reopen any time with <code>plan-editor ${escapeHtml(bootstrap.file)}</code></p>
  </div>`;
  document.body.appendChild(screen);
}

// --- messages from the artifact SDK ----------------------------------------

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== frame.contentWindow) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "pe:ready":
      setMode(modeToggle.checked);
      trackedIds.clear();
      syncTracking();
      break;

    case "pe:toggleMode":
      setMode(!modeToggle.checked);
      break;

    case "pe:annotate": {
      const clientId = String(data.clientId);
      const anchors = (data.anchors ?? []) as Array<{ selector: string; text: string }>;
      if (armed?.clientId === clientId) {
        // A modifier-click extended the existing selection rather than starting
        // a new edit — keep whatever has been typed so far.
        armed.anchors = anchors;
      } else {
        stageArmed();
        armed = { clientId, anchors, kind: data.kind === "text" ? "text" : "element", body: "" };
      }
      input.focus();
      render();
      break;
    }

    case "pe:repointed": {
      repointing = null;
      void guard("Re-pointing", () =>
        api(`/annotations/${String(data.id)}/repoint`, {
          method: "POST",
          body: JSON.stringify({ selector: String(data.selector), text: String(data.text) }),
        }),
      );
      render();
      break;
    }

    case "pe:morphed":
      void api("/morph-report", {
        method: "POST",
        body: JSON.stringify({ addressed: data.addressed ?? [], orphaned: data.orphaned ?? [] }),
      });
      break;

    case "pe:morphFailed":
      // Morphing arbitrary agent-written HTML is a heuristic. Say so out loud
      // rather than silently reloading — a blank frame with no explanation is
      // the worst thing this tool can do.
      toast("Could not patch in place — reloading the artifact", "error");
      frame.src = `/artifact/${key}/index.html?t=${encodeURIComponent(token)}&r=${Date.now()}`;
      break;
  }
});

// --- server stream ----------------------------------------------------------

const stream = new EventSource(`/events/${key}?t=${encodeURIComponent(token)}`);
let dropped = false;

stream.addEventListener("open", () => {
  if (!dropped) return;
  dropped = false;
  setStatus(null);
  toast("Reconnected");
  void applyPatch();
});

// EventSource retries on its own, but silently — so a dead server looked exactly
// like an idle one, which is most of why this felt unresponsive.
stream.addEventListener("error", () => {
  dropped = true;
  setStatus("Disconnected from the plan-editor server — retrying…", {
    label: "Reload",
    run: () => location.reload(),
  });
});

stream.addEventListener("message", (event) => {
  const payload = JSON.parse(event.data) as ServerEvent;
  switch (payload.type) {
    case "patch":
      void applyPatch();
      break;
    case "sync":
      annotations = payload.annotations;
      chat = payload.chat;
      syncTracking();
      render();
      break;
    case "versions":
      versions = payload.list;
      render();
      break;
    case "presence": {
      presenceState = payload.state;
      agentView = payload.agent;
      presence.dataset.state = payload.state;
      const who = agentView.session ? ` · ${agentView.session}` : "";
      presence.textContent =
        payload.state === "working"
          ? `agent working…${who}`
          : payload.state === "listening"
            ? `${agentView.viaHooks ? "agent connected" : "agent listening"}${who}`
            : agentView.session
              ? `agent idle · ${agentView.session}`
              : "no agent";
      presence.title = agentView.session
        ? `Bound to Claude session ${agentView.session}…${
            agentView.lastContact ? `\nLast seen ${new Date(agentView.lastContact).toLocaleTimeString()}` : "\nNot seen yet"
          }`
        : "No agent session is bound to this artifact";
      render();
      break;
    }
    case "agent-reply":
      chat.push({ role: "agent", text: payload.text, at: new Date().toISOString() });
      $("conversation").setAttribute("open", "");
      toast("Your agent replied");
      render();
      break;
  }
});

/** Fetches the new artifact HTML and hands it to the SDK to morph in place. */
async function applyPatch(): Promise<void> {
  const response = await fetch(`/artifact/${key}/raw?t=${encodeURIComponent(token)}`);
  if (!response.ok) {
    toast("Could not read the artifact", "error");
    return;
  }
  toFrame({ type: "pe:morph", html: await response.text() });
}

// Relative timestamps go stale on a page left open for an hour.
setInterval(render, 60_000);

render();
