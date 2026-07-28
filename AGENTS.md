# AGENTS.md

Guidance for coding agents working in this repository.

## Commands

```sh
bun run check      # build + typecheck + test — run before pushing
bun test           # node:test files, executed by Bun's runner
bun run build      # browser bundles only
bun run typecheck  # tsc --noEmit
```

Run one file: `bun test test/morph.test.ts`.

## Runtime

Bun, not Node. Bun executes the TypeScript in `src/` directly, so **there is no
server-side build step** — `bun run build` produces only the two browser bundles
(`dist/sdk.js`, `dist/chrome.js`) plus the stylesheet. `bin/plan-editor.js` imports
`src/cli.ts` straight through.

The detached server is spawned with `process.execPath` (the Bun binary) pointing at
`src/cli.ts`, so the background process always runs on the same runtime that
launched it.

**The server identity folds in a code signature** (`codeSignature()` — the newest
mtime across `src/` and `dist/`), not just the package version. Keying the restart
check on `package.json` alone means a long-running detached server silently keeps
executing stale code after every edit, and the symptom is your new feature
appearing not to work at all. This cost real debugging time once already.

Tests are written against `node:test` + `node:assert`, which Bun's runner executes
natively. Do not convert them to `bun:test` — the current form runs under both.

## Architecture

Three processes: the CLI, one detached HTTP server, and a browser holding a chrome
page whose sandboxed iframe renders the artifact.

**Identity.** A session is keyed by `sha256(realpath(file))`. The canonical path *is*
the identity, so no opaque ids are needed. That key is guessable, which is why it is
never sufficient for access — see the token rule below.

**The chrome owns all network access.** The artifact iframe is sandboxed
`allow-scripts` *without* `allow-same-origin`, so it has an opaque origin and cannot
usefully call the API. New HTML for morphing is fetched by the chrome and handed to
the SDK over `postMessage`. Consequence: **the session token never enters the
iframe.** Keep it that way.

**Annotations are records, not messages.** `takeFeedback` does not delete on
delivery. An annotation stays `submitted` until the browser reports that the agent's
edit actually touched its anchored element, at which point it becomes `addressed`.
This is the whole reason the tool can show which feedback landed.

## Invariants

- **Never `await read` … `await write` without the queue.** `src/store/atomic.ts`
  exists because Node/Bun serialize synchronous blocks, not `await`-spanning critical
  sections. Two concurrent handlers reading the same snapshot means the second write
  silently discards the first. Measured on the pattern this replaced: 25 concurrent
  submits, an average of 1 survivor, and a 15% chance of leaving the file unparseable.
  Every mutation goes through `SessionStore.mutate` or an explicit `queued(key, …)`.
- **Writes are `writeFileAtomically` (tmp + rename), never `writeFile`.** A plain
  write truncates in place, so a crash mid-write leaves JSON that never parses again
  and there is no repair path.
- **One file per session.** Never reintroduce a single global state document: it
  makes unrelated projects clobber each other and turns every asset request into a
  full parse of everything.
- **`ignoreActive` must stay off in the morph config.** It skips the active element
  *and its whole subtree*, and with nothing focused the active element is `<body>` —
  so the entire page silently refuses to morph. Use `ignoreActiveValue`, which
  protects a focused field's value without skipping anything. There is a regression
  test for this.
- **Morph `<head>` and `<body>` separately; never morph `documentElement`.**
  `morphStyle: "outerHTML"` on the root passes jsdom and throws in a real browser
  (`newContent is not iterable`). Because idiomorph mutates as it walks, a
  mid-walk throw leaves the document half-destroyed — the symptom is a blank
  page, not a caught error. Verified with a real-browser harness; jsdom alone
  will not catch a regression here.
- **`html`/`head`/`body` are never recorded as changed** (`isStructuralRoot`).
  Idiomorph passes the callback a normalized *clone* of the element it is morphing
  into, not the live node — so identity comparison cannot exclude them and they
  always compare as different, even for an identical document. Recording one
  flashes the whole page and marks every open edit addressed.
- **Submitting an edit must not set `workingSessions`.** The human pressing Submit
  says nothing about the agent; doing so pinned presence to "agent working…" from
  the moment of submit. Only the PostToolUse hook sets it.
- **The session token gates every session-scoped route.** The key alone must never
  grant access. `POST /api/sessions` also validates extension and `stat` server-side —
  a CLI-only check is what let the tool this replaces register any path and read it
  back.
- **Asset serving confines by `realpath`, not just by lexical `..` rejection.** A
  symlink inside the artifact directory otherwise escapes it.

## Testing notes

- `test/morph.test.ts` installs a jsdom window onto `globalThis` because idiomorph
  reads DOM constructors (`Document`, `Node`, `HTMLInputElement`, …) as bare globals.
  Install **only `document` plus constructor-shaped globals** — copying the whole
  window aliases jsdom's `performance`, which delegates back to the global one and
  recurses until the stack blows.
- Host-header guard tests must use `node:http`, not `fetch`. `fetch` treats `Host` as
  a forbidden header and silently strips it, so a fetch-based version of that test
  passes without ever exercising the guard.
- Symlink-confinement tests need the target to be genuinely outside the *artifact's
  own directory*. A sibling of the artifact is legitimately in scope.

## Presence must account for hook-connected agents

`presenceOf` originally measured only `activePolls`. Once hooks became the primary
delivery path that was wrong in the most confusing possible way: an agent could be
bound and receiving every edit while the browser said "no agent". Hooks now ping
`POST /api/:key/agent-contact` (via `plan-editor notify-contact`, installed as a
second UserPromptSubmit entry so it fires even on turns with nothing to inject),
and contact inside `CONTACT_WINDOW_MS` counts as connected.

`setup hooks` resolves an **absolute** command — bare `plan-editor` only works if
the package is globally linked, and a hook whose command is not found fails
silently, which is exactly the failure this tool exists to eliminate.

## Routing edits back to the authoring agent

An inline edit is only worth much to the agent that *produced* the plan — that
agent holds the conversation the plan came out of. `plan-editor <file>` therefore
records `authoredBy` (from `CLAUDE_CODE_SESSION_ID`, which Claude Code exposes to
Bash) and `authoredIn` (cwd). Hooks receive `session_id` and `cwd`, and
`ownershipOf` matches them:

- **authoring** — same session id, or same project with no competing claim. Full
  injection.
- **same-project** — a different session in the same directory tree. Injected
  *with a warning* that the agent may lack the context, because the human may
  have started a fresh session and silently dropping their edit is worse.
- **foreign** — neither. Never injected, never blocked.

Two things this got wrong once and must not again:

- **Directory comparison goes through `canonicalDir` (realpath) on both sides.**
  `process.cwd()` resolves symlinks and a hook's reported `cwd` does not, so on
  macOS `/tmp` vs `/private/tmp` made the same directory look like two projects
  and routing silently dropped the edit.
- **Delivery is tracked per agent session (`deliveredTo: string[]`), not one
  global stamp.** With a single stamp, whichever session's hook fired first
  consumed the full text and everyone else — including the authoring agent — got
  a bare count.

The Stop hook only ever blocks the **authoring** session. Holding an unrelated
session hostage because another project has open edits is intolerable.

## Latency: the agent must be *waiting*, not waiting to be poked

Measured on this machine: a submitted edit reaches an already-waiting agent in
**~40ms**, and an agent's file write reaches the browser in **~144ms**. The
pipeline is not slow.

What is slow is hook delivery, because it is *pull-on-prompt*: `UserPromptSubmit`
only fires when the human types, so an edit sits in the store until they happen
to message the agent. From the human's side that reads as "I pressed Submit and
nothing happened" — the wait is unbounded and has nothing to do with the tool.

So: **after applying edits, end the turn with `plan-editor watch <file>`.** It
parks until the next edit arrives and returns it in milliseconds. The cost is a
parked turn, which is the right trade while the human is working in the browser
and interruptible (Esc) the moment it is not. Hooks remain the safety net for
everything `watch` cannot cover — an interrupted watch, a compaction, a turn that
ended for another reason.

Do not "fix" latency by shortening timers or polling more often. Nothing in the
pipeline is polling.

**Browser confirmation cannot be the only completion signal.** An edit leaves
`submitted` when the browser reports that the agent's change touched its anchor —
which never happens if the tab is closed, stale, or was blanked by an earlier
bug. The edit then sticks forever and a watching agent is handed its own
just-applied work on every cycle, which is exactly the loop it looks like.
`plan-editor applied <file> --id <id>` is the escape hatch: if the same edit
returns after you applied it, declare it and move on.

Opening a session spawns a browser tab. Re-running `plan-editor <file>` during
development spawns *another* — several stale tabs then compete, all morphing and
reporting. Use `--no-open` when restarting the server mid-session.

## Getting edits into the agent's context

Three mechanisms, in order of how well they work:

1. **UserPromptSubmit hook** — the primary path. Injects open edits into the
   session the human is already in. Requires no agent cooperation at all.
   `deliveredAt` stamps each edit so its full text is injected once and then
   compacted to a count; without that it re-injects every prompt and reads as
   nagging while burning context.
2. **Stop hook** — the backstop, for when the agent tries to finish with edits
   outstanding.
3. **`plan-editor poll`** — the fallback. It does reach whatever session runs it,
   but it needs the agent to volunteer a blocking call.

Context injection contracts differ per event and failing them is silent:
`UserPromptSubmit` and `SessionStart` accept plain stdout *or*
`{"hookSpecificOutput":{"hookEventName":…,"additionalContext":…}}`; `PostToolUse`
and `Stop` accept **only** the JSON form. Stop blocks with
`{"decision":"block","reason":…}`. JSON is only parsed on exit code 0. We always
emit the JSON form so the same code path works everywhere.

## Versions, diff, and the edit lifecycle

**What version history is, concretely:** not a linked list and not a delta chain.
`<state>/versions/<key>/index.json` holds a flat, append-only array of
`{seq, at, bytes, origin}` — no next/prev pointers — beside one whole-file
snapshot per version, `<seq>.html`. Ordering is the array; `seq` is monotonic.
Roughly 20KB per version, so a capped 40-entry history costs under a megabyte.

Snapshots are **immutable**, which is what makes the browser cache in
`chrome-client.ts` correct. Scrubbing originally refetched both documents on
every click — including the current one, every single time — and then only
rendered a text diff, so moving between versions felt like loading rather than
moving. Clicking a version now morphs the artifact to it (`pe:preview`), the
cache means each snapshot is fetched once, and closing the overlay restores the
live document. Never leave a preview on screen: it shows a version the file no
longer contains.

`VersionStore` snapshots the whole artifact per observed change (capped at
`MAX_VERSIONS`, oldest dropped). Whole files rather than deltas: artifacts are
small, and it makes restore a single write. **Undo is implemented by writing an
old snapshot back to the artifact** — the existing watcher turns that into a
patch, so undo morphs in place exactly like an agent edit, and is itself undoable
because the restore snapshots too. Identical consecutive content is not recorded,
or undo becomes a no-op the user has to press twice.

`diffDocuments` (src/sdk/diff.ts) diffs by element `id` and reports only the
*innermost* changed element. A line diff over HTML is useless — one reflowed
paragraph rewrites a 400-character line — and reporting ancestors too would flag
`body` for every edit. Changes with no id to attribute them to are counted, never
guessed at. It runs in the browser because a real DOM is already there.

**Highlight only the words that changed.** `morphDocument` captures before/after
text during the walk (the old text is gone by the time it returns) and returns
`textChanges`. The SDK diffs those word-wise and highlights the added words via
the CSS Custom Highlight API — no DOM mutation, because wrapping words in spans
would corrupt the content the next morph has to diff and would leak into exports.
Flashing the whole element is the fallback, used only where the API is missing or
where an element changed without its text moving.

Lifecycle invariants:

- **Reject and human replies clear `deliveredTo` and reopen the edit.** A
  rejection the agent never hears about is the worst possible outcome.
- **A chunk edit is addressed when ANY covered element changed, and orphaned only
  when ALL are gone.** `TrackedAnchor.elements` is a list for this reason.
- **`anchors[0]` mirrors `selector`/`text`** so single-anchor consumers need no
  branching.

## Chrome UI invariants

- **Any element rendered with `hidden` needs an explicit `[hidden] { display: none }`
  rule.** The `hidden` attribute only sets `display: none` in the UA stylesheet, so
  any author `display:` rule silently beats it. `.frame-overlay` had `display: grid`
  with an opaque background and sat permanently over the artifact — the entire page
  looked broken. `.status-bar` had the same shape as `position: fixed` and covered
  the toolbar. Audit `grep -o 'id=\"[a-zA-Z]*\" hidden' src/chrome/chrome-html.ts`
  against the guards in `chrome.css` when adding one.
- **Verify the chrome page visually, not just structurally.** Both of those bugs
  passed typecheck, passed 106 tests, and served correct HTML. Headless Chrome
  cannot screenshot the chrome page directly (the SSE stream keeps it from going
  idle) — proxy to the live server, inline the CSS/JS, and stub `/events/`.

- **Nothing fails silently.** Every failure path goes through `toast()` or
  `setStatus()`. `console.error` alone is how a broken morph and a dead server
  came to look identical to "nothing is happening".
- **EventSource reconnects silently** — it retries on its own with no UI signal,
  so the disconnection bar and the `open`-after-`error` re-patch are what stop a
  dead server from reading as an idle one.
- **`hasViewer` gates browser launch.** Re-running `plan-editor <file>` used to
  spawn a tab every time; the tabs pile up, each with its own stream, all
  morphing and reporting independently. `--force-open` overrides.
- **`chat` must be rendered.** Agent replies were stored, synced, and never
  displayed for several revisions — the data being present is not the feature.

## Things that are deliberately absent

No multiplayer, no CRDT, no identity model. The artifact is agent-owned and humans
propose changes to it; that design call is what keeps the annotation layer a simple
append-only record instead of a merge problem. No version history yet — it is the
natural next feature, and the morph diff already computes most of what it needs.
