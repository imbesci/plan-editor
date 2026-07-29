import type { Session } from "../protocol.ts";

function escapeJson(value: unknown): string {
  // `</script` inside a JSON island would close the tag early.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

function escapeHtml(value: string): string {
  return value.replace(/[&<>"]/g, (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot" }[char]};`);
}

export function renderChrome(session: Session): string {
  const bootstrap = {
    key: session.key,
    token: session.token,
    file: session.file,
    status: session.status,
  };
  const name = session.file.split("/").pop() ?? "artifact";
  return `<!doctype html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width, initial-scale=1">
<title>${escapeHtml(name)} — plan-editor</title>
<link rel="stylesheet" href="/chrome.css">
<script id="pe-session" type="application/json">${escapeJson(bootstrap)}</script>
</head>
<body>
<div class="status-bar" id="statusBar" hidden><span id="statusText"></span><button class="link" id="statusAction" hidden></button></div>
<div class="layout" id="layout">
  <main class="stage">
    <header class="bar">
      <button class="file" id="switcher" type="button" title="${escapeHtml(session.file)}">
        <span>${escapeHtml(name)}</span><span class="caret">▾</span>
      </button>

      <label class="toggle" for="modeToggle" title="Click an element to attach an edit (⌘I)">
        <input type="checkbox" id="modeToggle">
        <span class="track"><span class="thumb"></span></span>
        <span class="toggle-text">Annotate</span>
        <kbd>⌘I</kbd>
      </label>

      <span class="presence" id="presence" data-state="waiting">no agent</span>

      <div class="tools">
        <button id="undo" class="icon" type="button" title="Undo the last change (⌘Z)" disabled>Undo</button>
        <button id="history" class="icon" type="button" title="Version history and diff (⌘H)">History</button>
        <button id="share" class="icon" type="button" title="Copy the link to this session">Link</button>
        <button id="export" class="icon" type="button" title="Download a standalone copy">Export</button>
        <button id="help" class="icon" type="button" title="Keyboard shortcuts (?)">?</button>
        <button id="collapse" class="icon" type="button" title="Hide the panel (⌘\\)">⇥</button>
      </div>
    </header>

    <div class="frame">
      <iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads"></iframe>
      <div class="frame-overlay" id="frameOverlay" hidden></div>
    </div>
  </main>

  <aside class="panel" id="panel">
    <div class="panel-head">
      <h2 id="phaseTitle">Your review</h2>
      <p class="phase-hint" id="phaseHint">Mark up the whole document, then send it as one review.</p>
      <input id="search" class="search" type="search" placeholder="Filter notes…  ⌘F" autocomplete="off">
    </div>

    <div class="list" id="list"></div>

    <details class="conversation" id="conversation">
      <summary>Conversation <b id="chatCount">0</b></summary>
      <div class="chat" id="chatLog"></div>
    </details>

    <div class="composer" id="composer">
      <div class="target-hint" id="targetHint"></div>
      <textarea id="input" rows="2" placeholder="Click an element (⇧-click for several), then say what to change…"></textarea>
      <button id="addNote" class="add" type="button">Add note</button>

      <label class="overall">
        <span>Overall note <em>— the context that frames every item</em></span>
        <textarea id="overall" rows="2" placeholder="e.g. cut this by a third; the tone is too hedged throughout"></textarea>
      </label>

      <div class="actions">
        <button id="end" class="ghost" type="button" title="Close this session and go back to your terminal">End</button>
        <button id="send" type="button">Send review</button>
      </div>
    </div>
  </aside>
</div>

<div class="toasts" id="toasts"></div>
<div class="overlay" id="overlay" hidden></div>
<script type="module" src="/chrome.js"></script>
</body>
</html>`;
}
