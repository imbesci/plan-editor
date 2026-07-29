// The chrome owns all server access. The artifact iframe is sandboxed without
// `allow-same-origin`, so it has an opaque origin and cannot usefully call the
// API — which is also why the session token never leaves this file.

import { diffDocuments, diffWords, type SectionChange } from "../sdk/diff.ts";
import type {
  AgentIdentityView,
  AgentPresence,
  ChatMessage,
  Review,
  ReviewItem,
  ServerEvent,
  VersionMeta,
} from "../protocol.ts";

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
const overall = $<HTMLTextAreaElement>("overall");
const addNote = $<HTMLButtonElement>("addNote");
const sendButton = $<HTMLButtonElement>("send");
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

/** The element(s) the next note will be pinned to. */
interface Armed {
  clientId: string;
  anchors: Array<{ selector: string; text: string }>;
  kind: "element" | "text";
}

let reviews: Review[] = [];
let chat: ChatMessage[] = [];
let versions: VersionMeta[] = [];
let presenceState: AgentPresence = "waiting";
let agentView: AgentIdentityView = { session: null, lastContact: null, viaHooks: false };
let armed: Armed | null = null;
let repointing: string | null = null;
let query = "";
let noteSaveTimer: number | undefined;
const trackedIds = new Set<string>();

const draftReview = () => reviews.find((review) => review.status === "drafting");
const sentReview = () => reviews.find((review) => review.status === "sent");
/** The most recent review the agent has answered and the human has not closed. */
const answeredReview = () => [...reviews].reverse().find((review) => review.status === "answered");

/**
 * Which of the two phases the panel is in. The whole point of the batch model is
 * that these never blur: you are either marking up, or reading the agent's work.
 */
function phase(): "drafting" | "sent" | "reviewing" {
  if (sentReview()) return "sent";
  if (answeredReview()) return "reviewing";
  return "drafting";
}

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
  for (const review of reviews) {
    for (const item of review.items) {
      if (item.status !== "sent" || item.tag === "page") continue;
      if (trackedIds.has(item.id)) continue;
      trackedIds.add(item.id);
      toFrame({ type: "pe:track", id: item.id, selector: item.selector, text: item.text, anchors: item.anchors });
    }
  }
}

// --- rendering --------------------------------------------------------------

const OUTCOME_LABEL: Record<string, string> = {
  applied: "applied",
  caveat: "applied with a caveat",
  "needs-call": "needs your call",
  skipped: "not done",
};

const ITEM_LABEL: Record<ReviewItem["status"], string> = {
  draft: "in your review",
  sent: "with the agent",
  answered: "review it",
  accepted: "accepted",
  rejected: "rejected",
  orphaned: "target changed",
};

function matches(item: ReviewItem): boolean {
  if (!query) return true;
  return `${item.body} ${item.text} ${item.selector}`.toLowerCase().includes(query);
}

function render(): void {
  const current = phase();
  const draft = draftReview();
  const sent = sentReview();
  const answered = answeredReview();

  $("chatCount").textContent = String(chat.length);
  document.body.dataset.phase = current;

  if (current === "drafting") {
    const count = draft?.items.length ?? 0;
    $("phaseTitle").textContent = "Your review";
    $("phaseHint").textContent =
      count === 0
        ? "Mark up the whole document, then send it as one review."
        : `${count} note${count === 1 ? "" : "s"} so far. Nothing reaches the agent until you send.`;
    const items = (draft?.items ?? []).filter(matches);
    list.innerHTML = items.length
      ? items.map(renderItem).join("")
      : `<p class="empty">Turn on Annotate, click an element — or select text — and describe the change. Add as many notes as you like; the document stays still while you work.</p>`;
    sendButton.textContent = count > 0 ? `Send review (${count})` : "Send review";
    sendButton.disabled = count === 0 && !overall.value.trim();
  }

  if (current === "sent") {
    const count = sent?.items.length ?? 0;
    $("phaseTitle").textContent = "With the agent";
    $("phaseHint").textContent = `${count} note${count === 1 ? "" : "s"} sent. The agent is working through them as a set.`;
    list.innerHTML =
      (sent?.note ? `<div class="overall-note"><b>Overall</b>${escapeHtml(sent.note)}</div>` : "") +
      (sent?.items ?? []).filter(matches).map(renderItem).join("");
    sendButton.textContent = "Waiting…";
    sendButton.disabled = true;
  }

  if (current === "reviewing") {
    const open = (answered?.items ?? []).filter((item) => item.status === "answered").length;
    $("phaseTitle").textContent = "The agent's work";
    $("phaseHint").textContent = open
      ? `${open} change${open === 1 ? "" : "s"} to accept or reject.`
      : "All settled. Start marking up again whenever you like.";
    list.innerHTML =
      (answered?.summary ? `<div class="summary"><b>Agent</b>${escapeHtml(answered.summary)}</div>` : "") +
      (answered?.items ?? []).filter(matches).map(renderItem).join("");
    sendButton.textContent = "Send review";
    sendButton.disabled = (draftReview()?.items.length ?? 0) === 0;
  }

  renderChat();
  undoButton.disabled = versions.length < 2;
  addNote.disabled = !input.value.trim();
  targetHint.textContent = armed
    ? armed.anchors.length > 1
      ? `${armed.anchors.length} elements selected — ⇧-click to add or remove`
      : `Pinned to “${(armed.anchors[0]?.text ?? "").slice(0, 60)}”`
    : "Nothing selected — this note will apply to the page as a whole.";
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

function anchorLabel(item: ReviewItem): string {
  const anchors = item.anchors ?? [{ selector: item.selector, text: item.text }];
  if (item.tag === "page") return `<span class="chunk">whole page</span>`;
  if (anchors.length > 1) {
    return `<span class="chunk">${anchors.length} elements</span> ${escapeHtml(
      anchors.map((anchor) => anchor.text.slice(0, 24)).join(" · ").slice(0, 90),
    )}`;
  }
  const first = anchors[0];
  return `${item.tag === "text" ? "❝ " : ""}${escapeHtml(first?.text.slice(0, 90) || first?.selector || "whole page")}`;
}

function renderItem(item: ReviewItem): string {
  const thread = (item.thread ?? [])
    .map(
      (message) =>
        `<div class="msg ${message.role}"><b>${message.role === "human" ? "You" : "Agent"}</b><span>${escapeHtml(message.text)}</span></div>`,
    )
    .join("");

  const actions: string[] = [];
  if (item.status === "draft") actions.push(`<button class="link" data-drop="${item.id}">remove</button>`);
  if (item.status === "answered") {
    actions.push(`<button class="link accept" data-accept="${item.id}">Accept</button>`);
    actions.push(`<button class="link reject" data-reject="${item.id}">Reject…</button>`);
  }
  if (item.status === "orphaned") actions.push(`<button class="link" data-repoint="${item.id}">Re-point…</button>`);
  if (item.tag !== "page") actions.push(`<button class="link" data-jump="${item.id}">Show</button>`);

  const outcome =
    item.outcome && item.status === "answered"
      ? `<span class="outcome ${item.outcome}">${OUTCOME_LABEL[item.outcome]}</span>`
      : "";

  return `<article class="card" data-status="${item.status}" data-outcome="${item.outcome ?? ""}" data-id="${escapeHtml(item.id)}">
    <div class="anchor">${anchorLabel(item)}</div>
    <div class="body">${escapeHtml(item.body)}</div>
    ${item.agentNote ? `<div class="note">${escapeHtml(item.agentNote)}</div>` : ""}
    ${thread ? `<div class="thread">${thread}</div>` : ""}
    <div class="meta">${outcome}<span class="status">${ITEM_LABEL[item.status]}</span><time>${ago(item.answeredAt ?? item.createdAt)}</time>${actions.join("")}</div>
  </article>`;
}

// --- markup phase -----------------------------------------------------------

function setMode(next: boolean): void {
  modeToggle.checked = next;
  toFrame({ type: "pe:setMode", value: next });
}

modeToggle.addEventListener("change", () => setMode(modeToggle.checked));
input.addEventListener("input", () => render());
search.addEventListener("input", () => {
  query = search.value.trim().toLowerCase();
  render();
});

// The overall note is saved as you type, not on send: losing it to a stray
// reload would cost more than the round trip does.
overall.addEventListener("input", () => {
  clearTimeout(noteSaveTimer);
  noteSaveTimer = setTimeout(() => {
    void api("/review/note", { method: "POST", body: JSON.stringify({ note: overall.value }) });
  }, 400) as unknown as number;
  render();
});

addNote.addEventListener("click", () => void commitNote());
sendButton.addEventListener("click", () => void sendReview());

/** Adds the typed note to the draft review. Still nothing leaves the browser. */
async function commitNote(): Promise<void> {
  const body = input.value.trim();
  if (!body) return;
  const item = armed
    ? { body, selector: armed.anchors[0]?.selector ?? "", text: armed.anchors[0]?.text ?? "", anchors: armed.anchors, tag: armed.kind }
    : { body, selector: "", text: "", tag: "page" as const };

  const result = await guard("Adding the note", async () => {
    const response = await api("/items", { method: "POST", body: JSON.stringify({ items: [item] }) });
    if (!response.ok) throw new Error(`server said ${response.status}`);
    return (await response.json()) as { items: ReviewItem[] };
  });

  if (result?.items[0] && armed) {
    toFrame({ type: "pe:bind", clientId: armed.clientId, id: result.items[0].id });
  }
  armed = null;
  input.value = "";
  render();
}

async function sendReview(): Promise<void> {
  await commitNote();
  sendButton.disabled = true;
  const done = await guard("Sending the review", async () => {
    const response = await api("/review/send", { method: "POST", body: "{}" });
    if (!response.ok) throw new Error((await response.json().catch(() => ({}))).error ?? `server said ${response.status}`);
    return true;
  });
  if (done) {
    overall.value = "";
    toast("Review sent — the agent has the whole set");
  }
  render();
}

// --- card actions -----------------------------------------------------------

list.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = (name: string) => target.closest(`[data-${name}]`)?.getAttribute(`data-${name}`);

  const drop = action("drop");
  if (drop) {
    void guard("Removing the note", () => api(`/items/${drop}`, { method: "DELETE" }));
    return;
  }
  if (target.closest("[data-cancel-repoint]")) {
    repointing = null;
    toFrame({ type: "pe:repoint", id: null });
    return render();
  }

  const jump = action("jump");
  if (jump) {
    const item = reviews.flatMap((review) => review.items).find((entry) => entry.id === jump);
    if (item) toFrame({ type: "pe:scrollTo", id: jump, selector: item.selector, text: item.text });
    return;
  }

  const accept = action("accept");
  if (accept) {
    void guard("Accepting", () => api(`/items/${accept}/accept`, { method: "POST", body: "{}" }));
    return;
  }

  const reject = action("reject");
  if (reject) {
    const reason = prompt("What's wrong with it? This goes back to the agent in your next review.");
    if (reason?.trim()) {
      void guard("Rejecting", async () => {
        await api(`/items/${reject}/reject`, { method: "POST", body: JSON.stringify({ text: reason.trim() }) });
        toast("Added back to your next review");
      });
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
      return void (event.shiftKey ? sendReview() : commitNote());
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
        // A modifier-click extended the selection rather than starting a new
        // note — keep whatever has been typed so far.
        armed.anchors = anchors;
      } else {
        // Clicking a different element while a note is half-written commits it,
        // so nothing is lost by moving on.
        void commitNote().then(() => {
          armed = { clientId, anchors, kind: data.kind === "text" ? "text" : "element" };
          render();
        });
        input.focus();
        break;
      }
      input.focus();
      render();
      break;
    }

    case "pe:repointed": {
      repointing = null;
      void guard("Re-pointing", () =>
        api(`/items/${String(data.id)}/repoint`, {
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
    case "sync": {
      reviews = payload.reviews;
      chat = payload.chat;
      // The server owns the draft note; only adopt it when the field is idle so
      // it never overwrites what is being typed.
      const note = draftReview()?.note ?? "";
      if (document.activeElement !== overall && overall.value !== note) overall.value = note;
      syncTracking();
      render();
      break;
    }
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
