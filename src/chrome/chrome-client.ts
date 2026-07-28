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

const frame = document.getElementById("artifact") as HTMLIFrameElement;
const list = document.getElementById("list")!;
const input = document.getElementById("input") as HTMLTextAreaElement;
const submitButton = document.getElementById("submit") as HTMLButtonElement;
const endButton = document.getElementById("end") as HTMLButtonElement;
const modeToggle = document.getElementById("modeToggle") as HTMLInputElement;
const presence = document.getElementById("presence")!;
const undoButton = document.getElementById("undo") as HTMLButtonElement;
const historyButton = document.getElementById("history") as HTMLButtonElement;
const exportButton = document.getElementById("export") as HTMLButtonElement;
const overlay = document.getElementById("overlay")!;

interface Draft {
  clientId: string;
  /** One entry per element this edit covers; several when chunk-selected. */
  anchors: Array<{ selector: string; text: string }>;
  kind: "element" | "text";
  body: string;
}

let annotations: Annotation[] = [];
let chat: ChatMessage[] = [];
let versions: VersionMeta[] = [];
let presenceState: AgentPresence = "waiting";
let agentView: AgentIdentityView = { session: null, lastContact: null, viaHooks: false };
/** Staged edits, not yet sent. Several can be queued before one submit. */
let drafts: Draft[] = [];
/** The draft currently being typed into, if any. */
let armed: Draft | null = null;
/** Annotation awaiting a new anchor from the next artifact click. */
let repointing: string | null = null;
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

function render(): void {
  const open = annotations.filter((entry) => entry.status === "submitted").length;
  const banner =
    open > 0 && presenceState === "waiting"
      ? `<div class="alert"><strong>${open} edit${open === 1 ? "" : "s"} waiting to be picked up.</strong>
           <span>${
             agentView.session
               ? "An agent is bound to this artifact but has not checked in. Send it any message, or install hooks so edits arrive automatically."
               : "No agent is bound. Install hooks, then edits reach the Claude session you're already in."
           }</span>
           <code>plan-editor setup hooks</code></div>`
      : "";

  const repointBanner = repointing
    ? `<div class="alert repoint"><strong>Pick a new anchor.</strong><span>Click the element this edit should point at.</span>
         <button class="link" data-cancel-repoint>Cancel</button></div>`
    : "";

  const cards = [...annotations.map(renderCard), ...drafts.map(renderDraft)];
  const body = cards.length
    ? cards.join("")
    : `<p class="empty">Turn on Annotate, then click an element — or select some text — and describe the change. It gets applied in place, no reload.</p>`;

  list.innerHTML = banner + repointBanner + body;
  undoButton.disabled = versions.length < 2;
  submitButton.disabled = drafts.length === 0 && !input.value.trim();
  submitButton.textContent = drafts.length > 1 ? `Submit ${drafts.length} edits` : "Submit";
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
    .map((message) => `<div class="msg ${message.role}"><b>${message.role === "human" ? "You" : "Agent"}</b> ${escapeHtml(message.text)}</div>`)
    .join("");

  const actions: string[] = [];
  if (annotation.status === "addressed") {
    actions.push(`<button class="link accept" data-accept="${annotation.id}">Accept</button>`);
    actions.push(`<button class="link reject" data-reject="${annotation.id}">Reject…</button>`);
  }
  if (annotation.status === "orphaned") {
    actions.push(`<button class="link" data-repoint="${annotation.id}">Re-point…</button>`);
  }
  if (annotation.tag !== "message") {
    actions.push(`<button class="link" data-jump="${annotation.id}">Show</button>`);
  }
  actions.push(`<button class="link" data-reply="${annotation.id}">Reply…</button>`);

  return `<article class="card" data-status="${annotation.status}" data-id="${escapeHtml(annotation.id)}">
    <div class="anchor">${anchorLabel(annotation.anchors ?? [{ selector: annotation.selector, text: annotation.text }], annotation.tag)}</div>
    <div class="body">${escapeHtml(annotation.body)}</div>
    ${thread ? `<div class="thread">${thread}</div>` : ""}
    <div class="meta"><span class="status">${STATUS_LABEL[annotation.status]}</span>${actions.join("")}</div>
  </article>`;
}

// --- annotation flow --------------------------------------------------------

function setMode(next: boolean): void {
  modeToggle.checked = next;
  toFrame({ type: "pe:setMode", value: next });
}

modeToggle.addEventListener("change", () => setMode(modeToggle.checked));

document.addEventListener(
  "keydown",
  (event) => {
    if ((event.metaKey || event.ctrlKey) && event.key.toLowerCase() === "i") {
      event.preventDefault();
      setMode(!modeToggle.checked);
    }
    if ((event.metaKey || event.ctrlKey) && event.key === "Enter") {
      event.preventDefault();
      void submit();
    }
    if (event.key === "Escape") closeOverlay();
    if (!overlay.hidden && (event.key === "ArrowLeft" || event.key === "ArrowRight")) {
      event.preventDefault();
      void stepVersion(event.key === "ArrowRight" ? 1 : -1);
    }
  },
  true,
);

input.addEventListener("input", () => {
  if (armed) armed.body = input.value;
  render();
});

submitButton.addEventListener("click", () => void submit());

/** Moves the in-progress draft into the queue so another element can be picked. */
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
  try {
    const response = await api("/annotations", { method: "POST", body: JSON.stringify({ annotations: payload }) });
    if (!response.ok) throw new Error(`submit failed: ${response.status}`);
    const result = (await response.json()) as { annotations: Annotation[] };
    // Hand each server-assigned id to the SDK so morph reports use the same
    // identity the store knows about.
    drafts.forEach((draft, index) => {
      const created = result.annotations[index];
      if (created) toFrame({ type: "pe:bind", clientId: draft.clientId, id: created.id });
    });
    drafts = [];
    input.value = "";
  } catch (error) {
    console.error(error);
  } finally {
    render();
  }
}

// --- card actions -----------------------------------------------------------

list.addEventListener("click", (event) => {
  const target = event.target as HTMLElement;
  const action = <K extends string>(name: K) => target.closest(`[data-${name}]`)?.getAttribute(`data-${name}`);

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
  if (accept) return void api(`/annotations/${accept}/accept`, { method: "POST", body: "{}" });

  const reject = action("reject");
  if (reject) {
    const reason = prompt("What's wrong with the change?");
    if (reason?.trim()) {
      void api(`/annotations/${reject}/reject`, { method: "POST", body: JSON.stringify({ text: reason.trim() }) });
    }
    return;
  }

  const reply = action("reply");
  if (reply) {
    const text = prompt("Reply to the agent about this edit:");
    if (text?.trim()) {
      void api(`/annotations/${reply}/reply`, { method: "POST", body: JSON.stringify({ text: text.trim() }) });
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

// --- versions, undo, diff ---------------------------------------------------

undoButton.addEventListener("click", async () => {
  undoButton.disabled = true;
  await api("/restore", { method: "POST", body: "{}" }).catch((error) => console.error(error));
});

exportButton.addEventListener("click", () => {
  window.open(`/api/${key}/export?t=${encodeURIComponent(token)}`, "_blank");
});

historyButton.addEventListener("click", () => void openHistory());

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

async function openHistory(): Promise<void> {
  const rows = [...versions].reverse();
  overlay.hidden = false;
  overlay.innerHTML = `<div class="sheet">
    <header><h2>History</h2><button class="link" data-close>Close</button></header>
    <p class="scrub-hint">Click a version to see it in place. <kbd>←</kbd> <kbd>→</kbd> to scrub.</p>
    <div class="versions">${rows
      .map(
        (version, index) => `<button class="version" data-seq="${version.seq}">
          <span class="seq">v${version.seq}</span>
          <span class="when">${new Date(version.at).toLocaleTimeString()}</span>
          <span class="origin">${version.origin === "open" ? "initial" : version.origin}</span>
          ${index === 0 ? '<span class="current">current</span>' : ""}
        </button>`,
      )
      .join("")}</div>
    <div class="diff" id="diffPane"><p class="empty">Pick a version to see what changed since it.</p></div>
  </div>`;

  overlay.querySelector("[data-close]")?.addEventListener("click", closeOverlay);
  for (const button of overlay.querySelectorAll<HTMLButtonElement>(".version")) {
    button.addEventListener("click", () => {
      const seq = Number(button.dataset.seq);
      selectVersion(seq);
      void previewVersion(seq);
      void showDiff(seq);
    });
  }
  // Warm the two most likely reads so the first click is instant.
  const latest = versions[versions.length - 1];
  if (latest) void fetchVersion(latest.seq);
  const previous = versions[versions.length - 2];
  if (previous) void fetchVersion(previous.seq);
}

/**
 * Snapshots are immutable, so one fetch per version is enough. Re-fetching both
 * documents on every click — including the current one, every time — is what
 * made scrubbing feel like loading rather than moving.
 */
const versionCache = new Map<number, string>();

async function fetchVersion(seq: number): Promise<string> {
  const cached = versionCache.get(seq);
  if (cached !== undefined) return cached;
  const response = await fetch(`/api/${key}/versions/${seq}?t=${encodeURIComponent(token)}`);
  const html = response.ok ? await response.text() : "";
  if (html) versionCache.set(seq, html);
  return html;
}

/** Which version the artifact frame is currently showing, if previewing. */
let previewing: number | null = null;

function selectVersion(seq: number): void {
  for (const button of overlay.querySelectorAll<HTMLButtonElement>(".version")) {
    button.classList.toggle("active", Number(button.dataset.seq) === seq);
  }
}

/** Morphs the artifact frame to a snapshot so scrubbing shows the document. */
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

async function showDiff(seq: number): Promise<void> {
  const pane = document.getElementById("diffPane");
  if (!pane) return;
  const current = versions[versions.length - 1];
  if (!current) return;
  pane.innerHTML = `<p class="empty">Comparing…</p>`;

  const [oldHtml, newHtml] = await Promise.all([fetchVersion(seq), fetchVersion(current.seq)]);
  const diff = diffDocuments(oldHtml, newHtml);

  const restore =
    seq === current.seq
      ? ""
      : `<button class="restore" data-restore="${seq}">Restore v${seq}</button>`;

  if (diff.sections.length === 0) {
    pane.innerHTML = `${restore}<p class="empty">${
      diff.unattributed ? "Content changed, but not inside any element with an id." : "No differences from the current version."
    }</p>`;
  } else {
    pane.innerHTML = restore + diff.sections.map(renderSectionDiff).join("");
  }

  pane.querySelector("[data-restore]")?.addEventListener("click", async () => {
    await api("/restore", { method: "POST", body: JSON.stringify({ seq }) });
    closeOverlay();
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

/**
 * Ending is a clean exit, not a state to sit in. It marks the session closed so
 * the hooks stop surfacing it, then gets out of the way — the human goes back to
 * their terminal and the conversation carries on as if nothing happened.
 */
endButton.addEventListener("click", async () => {
  endButton.disabled = true;
  endButton.textContent = "Ending…";
  try {
    await api("/end", { method: "POST", body: "{}" });
  } catch (error) {
    console.error("failed to end session", error);
  }
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
        // A plain click on a different element stages the previous draft rather
        // than discarding it, so several related edits can be sent as one batch.
        stageArmed();
        armed = { clientId, anchors, kind: data.kind === "text" ? "text" : "element", body: "" };
      }
      input.focus();
      render();
      break;
    }

    case "pe:repointed": {
      const id = String(data.id);
      repointing = null;
      void api(`/annotations/${id}/repoint`, {
        method: "POST",
        body: JSON.stringify({ selector: String(data.selector), text: String(data.text) }),
      });
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
      // Morphing arbitrary agent-written HTML is a heuristic. When it fails we
      // still have to show the truth, so fall back to what always works.
      console.warn("morph failed, reloading frame:", data.message);
      frame.src = `/artifact/${key}/index.html?t=${encodeURIComponent(token)}&r=${Date.now()}`;
      break;
  }
});

// --- server stream ----------------------------------------------------------

const stream = new EventSource(`/events/${key}?t=${encodeURIComponent(token)}`);

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
        ? `Bound to Claude session ${agentView.session}…` +
          (agentView.lastContact ? `\nLast seen ${new Date(agentView.lastContact).toLocaleTimeString()}` : "\nNot seen yet — install hooks or run a poll")
        : "No agent session is bound to this artifact";
      render();
      break;
    }
    case "agent-reply":
      chat.push({ role: "agent", text: payload.text, at: new Date().toISOString() });
      render();
      break;
  }
});

/** Fetches the new artifact HTML and hands it to the SDK to morph in place. */
async function applyPatch(): Promise<void> {
  const response = await fetch(`/artifact/${key}/raw?t=${encodeURIComponent(token)}`);
  if (!response.ok) return;
  toFrame({ type: "pe:morph", html: await response.text() });
}

render();
