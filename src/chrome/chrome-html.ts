import type { Session } from "../protocol.ts";

function escapeJson(value: unknown): string {
  // `</script` inside a JSON island would close the tag early.
  return JSON.stringify(value).replace(/</g, "\\u003c");
}

/**
 * `'` is in the set even though nothing here uses single-quoted attributes.
 * Omitting it was a real hole rather than a style point: this function also
 * escapes values that end up inside `title="…"` and inside the panel's own
 * markup, and the one character that survived was the one an apostrophe in a
 * filename or a note would supply for free.
 */
function escapeHtml(value: string): string {
  return value.replace(
    /[&<>"']/g,
    (char) => `&${{ "&": "amp", "<": "lt", ">": "gt", '"': "quot", "'": "#39" }[char]};`,
  );
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
<script>
  // Inline and before the stylesheet: applying this from the module would let
  // the wrong theme paint first.
  try {
    var t = localStorage.getItem("pe-theme");
    if (t === "light" || t === "dark") document.documentElement.dataset.theme = t;
  } catch (e) {}
</script>
</head>
<body>
<div class="status-bar" id="statusBar" hidden role="status"><span id="statusText"></span><button class="link" id="statusAction" hidden></button></div>
<div class="layout" id="layout">
  <main class="stage">
    <header class="bar">
      <button class="file" id="switcher" type="button" title="${escapeHtml(session.file)}">
        <span>${escapeHtml(name)}</span><span class="caret">▾</span>
      </button>

      <!-- Three ways to say what you want, in order of how precise they are:
           prose, the exact words, the structural operation. They are mutually
           exclusive gestures, so they sit together and only one can be lit. -->
      <div class="gestures">
        <label class="toggle" for="modeToggle" title="Click an element to attach an edit (⌘I)">
          <input type="checkbox" id="modeToggle">
          <span class="track"><span class="thumb"></span></span>
          <span class="toggle-text">Annotate</span>
          <kbd>⌘I</kbd>
        </label>
        <button class="gesture" id="suggest" type="button" aria-pressed="false" title="Type the exact replacement text into the document (⌘E)">Suggest</button>
        <select class="gesture-select" id="structural" title="Point at what to move, split, merge or delete">
          <option value="">Structure…</option>
          <option value="delete">Delete this</option>
          <option value="move-before">Move before…</option>
          <option value="move-after">Move after…</option>
          <option value="split">Split here</option>
          <option value="merge">Merge with…</option>
        </select>
      </div>

      <!-- Length is what most review notes are actually about — "cut this by a
           third" is the commonest overall note there is — and the tool held
           every number needed to answer it while showing none of them. -->
      <span class="metrics" id="metrics" hidden></span>

      <span class="presence" id="presence" data-state="waiting">no agent</span>

      <div class="tools">
        <button id="commands" class="icon" type="button" title="Everything you can do here (⌘K)">⌘K</button>
        <button id="undo" class="icon" type="button" title="Undo the last change (⌘Z)" disabled>Undo</button>
        <button id="redo" class="icon" type="button" title="Redo (⇧⌘Z)" hidden>Redo</button>
        <button id="history" class="icon" type="button" title="Version history and diff (⌘H)">History</button>
        <button id="record" class="icon" type="button" title="Transcript, packets, git, notifications">⋯</button>
        <button id="theme" class="icon" type="button" title="Theme: following your system">◐</button>
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
    <!-- 340px was a guess, and the panel is where the reading happens: a note
         about a paragraph is easier to write next to the paragraph than under a
         column of clipped text. Out of flow, so the two-column grid is untouched. -->
    <div class="panel-grip" id="panelGrip" role="separator" aria-orientation="vertical"
         tabindex="0" aria-label="Resize the panel — arrow keys, or double-click to reset"
         title="Drag to resize · double-click to reset"></div>
    <div class="panel-head">
      <h2 id="phaseTitle">Your review</h2>
      <p class="phase-hint" id="phaseHint">Mark up the whole document, then send it as one review.</p>
      <!-- The one lint finding that breaks anchoring rather than merely
           degrading it. Reported here because the human is the one who can ask
           for it to be fixed, and the symptom otherwise surfaces hours later as
           a note that mysteriously lost its place. -->
      <div class="advice" id="advice" hidden></div>
      <div class="progress" id="progress" hidden></div>
      <div class="filters" id="filters" hidden></div>
      <input id="search" class="search" type="search" placeholder="Filter notes…  ⌘F" autocomplete="off">
    </div>

    <!-- The document's own structure. Past ~15 notes the list stops being
         scannable and the only shape the human still has in their head is the
         document's. -->
    <details class="drawer" id="navigator">
      <summary>Document <b id="outlineCount">0</b></summary>
      <div class="finder">
        <input id="find" class="search" type="search" placeholder="Find in the document…  /" autocomplete="off">
        <span class="find-count" id="findCount"></span>
      </div>
      <div class="outline" id="outline"></div>
    </details>

    <!-- Deliberately not a review item: these outlive every review. -->
    <details class="drawer standing" id="standingPanel">
      <summary>Standing contract <b id="contractCount">0</b></summary>
      <p class="drawer-hint">Rules sent ahead of every review, until you retire them.</p>
      <div class="rules" id="contractList"></div>
      <div class="rule-add">
        <textarea id="ruleInput" rows="2" placeholder="e.g. never pad a section to make it look longer"></textarea>
        <button id="addRule" class="add" type="button">Add rule</button>
      </div>
    </details>

    <details class="drawer locks" id="locksPanel" hidden>
      <summary>Locked regions <b id="lockCount">0</b></summary>
      <p class="drawer-hint">The agent is told to leave these alone.</p>
      <div class="locklist" id="lockList"></div>
    </details>

    <div class="list" id="list"></div>

    <details class="conversation" id="conversation">
      <summary>Conversation <b id="chatCount">0</b></summary>
      <div class="chat" id="chatLog"></div>
      <div class="chat-composer">
        <textarea id="chatInput" rows="1" placeholder="Say something to your agent…" data-keep="chat"></textarea>
        <button id="sendChat" class="add" type="button">Send</button>
      </div>
    </details>

    <!-- A real handle for the whole entry area. The textarea's native corner
         grip resizes only itself, is a few pixels wide, and is forgotten on
         reload — writing a long note meant dragging an invisible target every
         time. This is a separator, so it is focusable and takes arrow keys. -->
    <div class="composer-grip" id="composerGrip" role="separator" aria-orientation="horizontal"
         tabindex="0" aria-label="Resize the note area — arrow keys, or double-click to reset"
         title="Drag to resize · double-click to reset"></div>
    <div class="composer" id="composer">
      <div class="target-hint" id="targetHint"></div>
      <div class="target-actions" id="targetActions" hidden>
        <button class="link" id="lockTarget" type="button">Lock this</button>
        <!-- Escape does this too, but a selection you cannot see how to undo is
             the same as one you cannot undo. -->
        <button class="link" id="clearTarget" type="button">Clear selection</button>
      </div>
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

<div class="toasts" id="toasts" role="status" aria-live="polite"></div>
<div class="overlay" id="overlay" hidden role="dialog" aria-modal="true"></div>
<script type="module" src="/chrome.js"></script>
</body>
</html>`;
}
