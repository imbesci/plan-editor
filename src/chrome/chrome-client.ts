// The chrome owns all server access. The artifact iframe is sandboxed without
// `allow-same-origin`, so it has an opaque origin and cannot usefully call the
// API — which is also why the session token never leaves this file.

import type { Annotation, ChatMessage, ServerEvent } from "../protocol.ts";

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

let annotations: Annotation[] = [];
let chat: ChatMessage[] = [];
/** The element the user just clicked, awaiting a body. */
let armed: { clientId: string; selector: string; text: string } | null = null;

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

// --- rendering --------------------------------------------------------------

const STATUS_LABEL: Record<Annotation["status"], string> = {
  draft: "draft",
  submitted: "waiting for agent",
  addressed: "applied",
  resolved: "resolved",
  orphaned: "target changed",
};

function render(): void {
  const draft = armed
    ? [{ id: armed.clientId, body: input.value || "…", selector: armed.selector, text: armed.text, tag: "element", status: "draft", createdAt: "" } as Annotation]
    : [];
  const rows = [...annotations, ...draft];
  if (rows.length === 0) {
    list.innerHTML = `<p class="empty">Turn on Annotate, click an element, and describe the change. It gets applied in place — no reload.</p>`;
    return;
  }
  list.innerHTML = rows
    .map((entry) => {
      const anchor = entry.text ? escapeHtml(entry.text.slice(0, 90)) : escapeHtml(entry.selector || "whole page");
      return `<article class="card" data-status="${entry.status}" data-id="${escapeHtml(entry.id)}">
        <div class="anchor">${anchor}</div>
        <div class="body">${escapeHtml(entry.body)}</div>
        <div class="meta"><span class="status">${STATUS_LABEL[entry.status]}</span>${
          entry.agentNote ? `<span>${escapeHtml(entry.agentNote)}</span>` : ""
        }</div>
      </article>`;
    })
    .join("");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[char]};`);
}

// --- annotation flow --------------------------------------------------------

function setMode(next: boolean): void {
  modeToggle.checked = next;
  toFrame({ type: "pe:setMode", value: next });
  if (!next) disarm();
}

function disarm(): void {
  if (armed) toFrame({ type: "pe:cancel", clientId: armed.clientId });
  armed = null;
  render();
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
  },
  true,
);

input.addEventListener("input", () => {
  if (armed) render();
});

submitButton.addEventListener("click", () => void submit());

async function submit(): Promise<void> {
  const body = input.value.trim();
  if (!body) return;
  submitButton.disabled = true;
  try {
    const payload = armed
      ? [{ body, selector: armed.selector, text: armed.text, tag: "element" }]
      : [{ body, selector: "", text: "", tag: "message" }];
    const response = await api("/annotations", { method: "POST", body: JSON.stringify({ annotations: payload }) });
    if (!response.ok) throw new Error(`submit failed: ${response.status}`);
    const result = (await response.json()) as { annotations: Annotation[] };
    // Hand the server-assigned id to the SDK so its morph report uses the same
    // identity the store knows about.
    if (armed && result.annotations[0]) {
      toFrame({ type: "pe:bind", clientId: armed.clientId, id: result.annotations[0].id });
    }
    armed = null;
    input.value = "";
  } catch (error) {
    console.error(error);
  } finally {
    submitButton.disabled = false;
    render();
  }
}

endButton.addEventListener("click", async () => {
  await api("/end", { method: "POST", body: "{}" });
});

// --- messages from the artifact SDK ----------------------------------------

window.addEventListener("message", (event: MessageEvent) => {
  if (event.source !== frame.contentWindow) return;
  const data = event.data as Record<string, unknown> | null;
  if (!data || typeof data.type !== "string") return;

  switch (data.type) {
    case "pe:ready":
      setMode(modeToggle.checked);
      break;

    case "pe:toggleMode":
      setMode(!modeToggle.checked);
      break;

    case "pe:annotate":
      if (armed) toFrame({ type: "pe:cancel", clientId: armed.clientId });
      armed = { clientId: String(data.clientId), selector: String(data.selector), text: String(data.text) };
      input.focus();
      render();
      break;

    case "pe:morphed":
      void reportMorph(data as unknown as { addressed: string[]; orphaned: string[] });
      break;

    case "pe:morphFailed":
      // Morphing arbitrary agent-written HTML is a heuristic. When it fails we
      // still have to show the truth, so fall back to the thing that always works.
      console.warn("morph failed, reloading frame:", data.message);
      frame.src = `/artifact/${key}/index.html?t=${encodeURIComponent(token)}&r=${Date.now()}`;
      break;
  }
});

async function reportMorph(report: { addressed: string[]; orphaned: string[] }): Promise<void> {
  await api("/morph-report", {
    method: "POST",
    body: JSON.stringify({ addressed: report.addressed ?? [], orphaned: report.orphaned ?? [] }),
  });
}

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
      render();
      break;
    case "presence":
      presence.dataset.state = payload.state;
      presence.textContent =
        payload.state === "listening" ? "agent listening" : payload.state === "working" ? "agent working…" : "agent idle";
      break;
    case "agent-activity":
      presence.dataset.state = "working";
      presence.textContent = "agent working…";
      break;
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
