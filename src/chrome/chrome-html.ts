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
<div class="layout">
  <main class="stage">
    <header class="bar">
      <span class="file" title="${escapeHtml(session.file)}">${escapeHtml(name)}</span>
      <label class="toggle" for="modeToggle" title="Click an element to attach an edit">
        <input type="checkbox" id="modeToggle">
        <span class="track"><span class="thumb"></span></span>
        <span class="toggle-text">Annotate</span>
        <kbd>⌘I</kbd>
      </label>
      <span class="presence" id="presence" data-state="waiting">agent idle</span>
    </header>
    <div class="frame">
      <iframe id="artifact" sandbox="allow-scripts allow-forms allow-popups allow-downloads"></iframe>
    </div>
  </main>
  <aside class="panel">
    <h2>Edits</h2>
    <div class="list" id="list"></div>
    <div class="composer">
      <textarea id="input" rows="3" placeholder="Click an element, then say what to change…"></textarea>
      <div class="actions">
        <button id="end" class="ghost" type="button">End session</button>
        <button id="submit" type="button">Submit</button>
      </div>
    </div>
  </aside>
</div>
<script type="module" src="/chrome.js"></script>
</body>
</html>`;
}
