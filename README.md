# plan-editor

Click an element, say what you want changed, watch it change in place.

No reload. No flash. No losing your scroll position. And the edit goes back to the
agent you were already talking to — the one that holds the conversation the plan
came out of — not a fresh one that has never seen it.

```sh
bun install
bun run build
bun run bin/plan-editor.js plan.html
bun run bin/plan-editor.js setup hooks     # once, then restart Claude Code
```

---

## Contents

- [The idea](#the-idea)
- [Quick start](#quick-start)
- [Making edits](#making-edits)
- [The edit lifecycle](#the-edit-lifecycle)
- [Versions, undo, and diff](#versions-undo-and-diff)
- [How edits reach your agent](#how-edits-reach-your-agent)
- [Keyboard shortcuts](#keyboard-shortcuts)
- [CLI reference](#cli-reference)
- [Writing artifacts that work well](#writing-artifacts-that-work-well)
- [Security model](#security-model)
- [Environment](#environment)
- [Architecture](#architecture)
- [Troubleshooting](#troubleshooting)
- [Deliberately absent](#deliberately-absent)

---

## The idea

Your agent writes an HTML artifact — a plan, a spec, a report. Reviewing it
normally means describing changes in prose ("the third paragraph under Risks is
too long"), which is slow and imprecise. plan-editor lets you point at the thing
and say what you want.

Two properties make it more than a comment box:

**It morphs, it does not reload.** A reload destroys DOM node identity, which is
why comment anchors in tools like this normally orphan the instant the agent
rewrites the file. Morphing updates nodes in place, so an annotation holding an
element reference stays valid across the edit — and the morph tells you exactly
which nodes changed, turning "did the agent address my note?" into a set
membership check rather than a fuzzy match.

**Edits route to the authoring agent.** The session records which Claude Code
session opened it. Your edit lands in that conversation, with all the context
behind why the plan reads the way it does.

---

## Quick start

```sh
plan-editor plan.html          # opens the artifact in your browser
plan-editor setup hooks        # once — restart Claude Code afterwards
```

Then, in the browser: turn on **Annotate** (`⌘I`), click something, describe the
change, hit **Submit**.

Your agent picks it up, edits the file, and the page patches itself. The card in
the sidebar flips to **applied**, and you Accept or Reject.

For the fastest loop, have your agent end its turn with:

```sh
plan-editor watch plan.html
```

That parks it until you submit — measured at ~40ms from Submit to the agent
having the edit. Without it, delivery waits until you next send the agent a
message, which is unbounded and feels broken.

---

## Making edits

| Gesture | Result |
| --- | --- |
| **Click** an element | Anchors the edit to it |
| **Select text**, then click | Anchors to the selection rather than the whole element |
| **⇧-click** more elements | One instruction covering several — ⇧-click again to drop one |
| **Click elsewhere** while typing | Stages the current edit and starts another |
| Type with nothing selected | A freeform message to the agent, not tied to an element |

Staged edits queue up and go together on Submit, so a set of related changes
arrives as one coherent batch rather than racing.

Native controls — buttons, inputs, links, `<summary>` — stay interactive in
annotate mode, so an artifact with working UI keeps working while you review it.

---

## The edit lifecycle

```
   you submit
        │
        ▼
   ┌──────────┐   agent's edit touches      ┌────────────┐  you accept  ┌──────────┐
   │ submitted│──────the anchor────────────▶│  addressed │─────────────▶│ resolved │
   └──────────┘                             └────────────┘              └──────────┘
        ▲                                          │
        │              you reject, with a reason   │
        └──────────────────────────────────────────┘
        ▲
        │  anchor vanished ──▶ orphaned ──▶ you re-point it
```

**Edits are records, not messages.** They are not deleted on delivery. An edit
stays `submitted` until the agent's change actually touches its anchor, so the
sidebar always reflects what has and has not landed.

**Reject reopens.** A rejection carries your reason into the edit's thread and
puts it back in front of the agent — an edit the agent never hears was wrong is
worse than one never applied.

**Reply** on any edit for a follow-up without creating a new one. A human reply
reopens a settled edit, so the agent sees it.

**Re-point** gives an orphaned edit a new anchor: click **Re-point…**, then click
the element it should refer to.

Filter the sidebar by **Open / Review / Done / All**, or `⌘F` to search across
edit text and anchors.

---

## Versions, undo, and diff

Every observed change to the artifact is snapshotted. **History** (`⌘H`) opens the
version list.

- **Click a version** to see it — the artifact morphs to that snapshot in place.
- **← →** scrub between versions.
- **Restore** commits one, which is itself recorded, so undo is undoable.
- **Undo** (`⌘Z`) restores the previous version directly.

The diff is by element `id`, showing only the innermost changed element, with a
word-level diff inside each section. A line diff over HTML teaches you nothing —
one reflowed paragraph rewrites a 400-character line.

Snapshots are whole files, capped at 40, oldest dropped. About 20KB each, so a
full history is well under a megabyte.

---

## How edits reach your agent

Three mechanisms, layered. You want all three.

### 1. Hooks — no polling, no fresh agent

`plan-editor setup hooks` merges four hooks into `~/.claude/settings.json`,
preserving anything already there:

| Hook | What it does |
| --- | --- |
| **UserPromptSubmit** | Injects open edits into the session you're already talking to |
| **SessionStart** (`compact\|resume`) | Re-injects after a compaction, where this loop otherwise dies quietly |
| **PostToolUse** | The browser shows "agent working" the moment it touches the file |
| **Stop** | Blocks the agent from finishing with your edits unapplied |

Full edit text is injected once, then compacted to a short reminder, and goes
silent once applied.

The Stop hook is bounded three ways, because a runaway one is worse than the bug
it fixes: it never stacks on an already-active stop hook, it gives up after two
attempts per session, and `PLAN_EDITOR_NO_STOP_HOOK=1` disables it without
uninstalling.

### 2. `watch` — the responsive path

Hook delivery is *pull-on-prompt*: it only fires when you type. `plan-editor watch`
parks the agent on a long-poll so a submitted edit reaches it immediately.

### 3. `poll` and `applied` — the fallbacks

`plan-editor poll` is the classic blocking call. `plan-editor applied --id <id>`
lets the agent declare an edit done when the browser cannot confirm — a closed or
stale tab produces no confirmation, and without this the edit sticks forever and
a watching agent is handed its own work on every cycle.

### Who gets the edit

The session records `authoredBy` (the Claude session id) and `authoredIn` (cwd):

- **authoring** — same session, or same project with no competing claim. Full delivery.
- **same-project** — different session, same directory. Delivered *with a warning*
  that it may lack context, because you may have started a fresh session and
  silently dropping your edit is worse.
- **foreign** — neither. Never delivered, never blocked.

The presence indicator shows which session is bound and when it was last seen.

---

## Keyboard shortcuts

| Key | Action |
| --- | --- |
| `⌘I` | Toggle annotate mode |
| `⌘Enter` | Submit staged edits |
| `⌘F` | Filter edits |
| `⌘Z` | Undo the last change |
| `⌘H` | Version history |
| `← →` | Scrub versions (while history is open) |
| `⌘\` | Hide or show the panel (focus mode) |
| `Esc` | Close an overlay, or cancel re-pointing |
| `?` | Shortcut list |

---

## CLI reference

| Command | Description |
| --- | --- |
| `plan-editor <file.html>` | Open for review. Reuses an existing tab if one is watching. |
| `plan-editor watch <file>` | Park until an edit arrives. `--max-ms` bounds the wait. |
| `plan-editor poll <file>` | Long-poll for edits. `--reply "..."`, `--timeout-ms`. |
| `plan-editor applied <file> --id <id>` | Declare an edit applied. `--note "..."`. |
| `plan-editor undo <file>` | Restore the previous version. |
| `plan-editor export <file>` | Write a standalone copy. `--out <path>`. |
| `plan-editor status` | Server state, sessions, bound agents, edit counts. |
| `plan-editor end <file>` | End a session. |
| `plan-editor stop` | Shut the background server down. |
| `plan-editor setup hooks` | Install the Claude Code hooks. |
| `plan-editor server [--verbose]` | Run the server in the foreground. |

Flags worth knowing: `--no-open` (never launch a browser), `--force-open` (launch
even when a tab is already watching).

---

## Writing artifacts that work well

**Give top-level sections stable `id` attributes.** This is the single highest-value
thing you can do. Idiomorph matches on id first, so ids let it update a section in
place instead of tearing it down — which is the difference between an edit being
marked `addressed` and being marked `orphaned`. It also makes the diff read by
section instead of by anonymous element.

```html
<section id="risks">…</section>   <!-- survives a rewrite -->
<section>…</section>              <!-- matched structurally; more fragile -->
```

Artifacts are otherwise ordinary HTML. Nothing is injected except a single
`<script src="/sdk.js">` before `</body>`, so the file renders identically opened
straight from disk. Local sibling assets (`./style.css`, `./logo.png`) resolve
relative to the artifact.

---

## Security model

The session key is `sha256(realpath(file))` — guessable, so it is an **identifier,
not a credential**. Every session-scoped route requires a random capability token
minted at open time and handed only to the CLI that created the session.

- `POST /api/sessions` validates extension and `stat` server-side, so a local
  process cannot register `/etc/passwd` and read it back through the artifact route.
- Sibling assets are confined to the artifact directory lexically **and** by
  `realpath`, so a symlink planted next to an artifact cannot escape it.
- A Host-header allowlist rejects DNS rebinding. An origin check alone does not:
  a rebound page sends its hostile hostname in *both* `Origin` and `Host`.
- State-changing browser routes additionally require same-origin.
- The artifact runs in an iframe sandboxed without `allow-same-origin`, so it has
  an opaque origin and **never receives the session token**.

This is a local single-user tool. It is not hardened for exposure to a network,
and `PLAN_EDITOR_HOST=0.0.0.0` in particular gives anyone who can reach the port
full access with a plain `curl`.

---

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAN_EDITOR_PORT` | `4471` | Server port |
| `PLAN_EDITOR_HOST` | `127.0.0.1` | Bind address |
| `PLAN_EDITOR_STATE_DIR` | `~/.plan-editor` | Sessions, versions, logs |
| `PLAN_EDITOR_ALLOWED_HOSTS` | — | Extra allowed `Host` values |
| `PLAN_EDITOR_NO_STOP_HOOK` | — | `1` disables the Stop guard |
| `PLAN_EDITOR_DEBUG` | — | `1` logs server events to stderr |

---

## Architecture

Three processes: the CLI, one detached HTTP server, and a browser holding a chrome
page whose sandboxed iframe renders the artifact.

```
you click an element   ──▶  SDK (in iframe)  ──postMessage──▶  chrome page
                                                                    │
                                                              POST /annotations
                                                                    ▼
                                                            session record
                                                          (~/.plan-editor)
                                                                    │
                                              hook injection │ watch │ poll
                                                                    ▼
                                                             your agent
                                                                    │
                                                          edits the file
                                                                    ▼
                                       chokidar ──▶ snapshot ──▶ SSE "patch"
                                                                    │
                                              chrome fetches new HTML
                                                                    ▼
                                          SDK morphs the DOM in place
                                                        │
                                    ┌───────────────────┴───────────────────┐
                                    ▼                                       ▼
                    highlight only the changed words          edit → addressed
```

State lives in `~/.plan-editor`: one JSON file per session (never a single global
document — that makes unrelated projects clobber each other), and per-session
version directories holding whole-file snapshots plus a flat index.

Writes go through a per-key promise chain and tmp+rename. The naive
read-modify-write this replaces loses an average of 24 of 25 concurrent submits
and corrupts the file outright about 15% of the time.

Runtime is **Bun** — it executes the TypeScript directly, so there is no
server-side build step. `bun run build` produces only the two browser bundles.

---

## Troubleshooting

**"No agent is bound" / edits sit unapplied.** Nothing is listening. Run
`plan-editor setup hooks` and restart Claude Code, or have the agent run
`plan-editor watch <file>`.

**Edits are picked up only when I message the agent.** That is hook delivery
working as designed — it is pull-on-prompt. Use `watch` for instant pickup.

**The same edit keeps coming back.** The browser cannot confirm it (tab closed,
stale, or on old code). Hard-refresh the tab; the agent can clear it with
`plan-editor applied <file> --id <id>`.

**The artifact frame is blank.** Hard-refresh (`⌘⇧R`). If it persists, the morph
failed — a toast will say so, and it falls back to a full reload.

**Nothing updates at all.** Look for the disconnection bar at the top of the
window. `plan-editor status` reports whether the server is running.

**My change did not restart the server.** It should — server identity folds in a
code signature over `src/` and `dist/`. If you edited something outside those,
`plan-editor stop` and reopen.

---

## Deliberately absent

**No multiplayer, no CRDT, no identity model.** The artifact is agent-owned and
humans propose changes to it. That single decision is what keeps the annotation
layer a simple append-only record rather than a merge problem — and it is why
anchoring, threading, and undo are all tractable.

**No AI in the tool itself.** plan-editor never calls a model. It moves edits to
your agent and changes back to your browser; the intelligence is entirely in the
conversation you were already having.

---

## Development

```sh
bun run check      # build + typecheck + test
bun test           # 106 tests
bun run build      # browser bundles only
```

Tests cover store concurrency, morph semantics (including the multi-anchor and
word-level-highlight rules), the diff engine, version history, auth and path
confinement, and hook routing. `AGENTS.md` records the invariants and the bugs
that motivated them — including several that jsdom passed and a real browser did
not.
