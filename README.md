# plan-editor

Mark up a document the way you'd mark up a draft — freely, at your own pace — then
send the whole review to your agent at once.

It applies the set, the page patches itself in place, and you accept or reject its
work item by item. No reload, no losing your scroll position, and the review goes
back to the agent you were already talking to, not a fresh one that has never seen
the document.

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
- [The two phases](#the-two-phases)
- [Why batched, not live](#why-batched-not-live)
- [The overall note](#the-overall-note)
- [The lifecycle](#the-lifecycle)
- [Versions, undo, and diff](#versions-undo-and-diff)
- [How a review reaches your agent](#how-a-review-reaches-your-agent)
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

Three properties make it more than a comment box:

**You review in one pass, not a trickle.** Mark up the whole document while it
holds still, then send it as one review. The agent sees how your notes relate
before it changes anything.

**It morphs, it does not reload.** A reload destroys DOM node identity, which is
why comment anchors in tools like this normally orphan the instant the agent
rewrites the file. Morphing updates nodes in place, so an annotation holding an
element reference stays valid across the edit — and the morph tells you exactly
which nodes changed, turning "did the agent address my note?" into a set
membership check rather than a fuzzy match.

**Reviews route to the authoring agent.** The session records which Claude Code
session opened it. Your review lands in that conversation, with all the context
behind why the plan reads the way it does.

---

## Quick start

```sh
plan-editor plan.html          # opens the artifact in your browser
plan-editor setup hooks        # once — restart Claude Code afterwards
```

Then, in the browser:

1. Turn on **Annotate** (`⌘I`) and work through the document, clicking things and
   describing the changes you want. Nothing leaves your browser yet.
2. Add an **overall note** if the review has a theme — *"cut this by a third"*.
3. Hit **Send review**.

Your agent applies the set, the page patches itself in place, and each item comes
back for you to **Accept** or **Reject**.

If you want the agent waiting rather than picking it up on your next message, have
it end its turn with `plan-editor watch plan.html`.

---

## The two phases

The whole design rests on these never blurring.

### 1. Marking up

The document stays still. Nothing you write reaches the agent. Add as many notes
as you like, over as long as you like — the draft lives on the server, so a reload
does not lose it.

| Gesture | Result |
| --- | --- |
| **Click** an element | Pins the note to it |
| **Select text**, then click | Pins to the selection rather than the whole element |
| **⇧-click** more elements | One note covering several — ⇧-click again to drop one |
| Type with nothing selected | A note about the page as a whole |
| **Overall note** | Frames the entire review — see below |

Native controls — buttons, inputs, links, `<summary>` — stay interactive in
annotate mode, so an artifact with working UI keeps working while you review it.

**Send review** is the one moment anything crosses to the agent.

### 2. Reading the agent's work

The agent applies the review as a set and responds with a summary of what it did
and why. Each item comes back marked:

| Outcome | Meaning |
| --- | --- |
| **applied** | Done as asked |
| **applied with a caveat** | Done, but read the agent's note |
| **needs your call** | Ambiguous — the agent wants a decision rather than guessing |
| **not done** | Deliberately skipped, with a reason |

Then you **Accept** or **Reject** each one. A rejection carries your reason into
your next review automatically, so the agent always hears why.

## Why batched, not live

An earlier version sent every note the instant you wrote it. In this project's own
history, three notes about one paragraph — *reword*, *too wordy*, *elaborate* —
arrived separately and produced three rewrites that cancelled out. The agent was
never wrong; it just never saw the shape of the intent.

Batching also means the document holds still while you read it, which is the only
way to review anything properly. And it removes a whole class of problem: nothing
is waiting on anything, so latency stops mattering.

## The overall note

A review carries one note that frames all of it — *"cut this by a third"*, *"the
tone is too hedged throughout"*. This is not another pinned comment. It leads every
payload the agent receives and survives the compaction that drops repeated items,
because it is the context that makes the individual notes interpretable.

---

## The lifecycle

```
  ┌── you mark up ──┐                        the agent applies the set
  │                 │                                    │
  │   draft ────────┼──── you send ────▶ sent ───────────┼──▶ answered
  │  (private)      │                                    │
  └─────────────────┘                                    ▼
                                            ┌── you accept ──▶ accepted
                                            │
                                            └── you reject ──▶ carried into
                                                               your next review
```

**Nothing is consumed on delivery.** Polling twice returns the same review; it
leaves the agent's queue only when the agent responds.

**A rejection is never lost.** It keeps its `rejected` status and reappears in
your next draft with your reason attached.

**Re-point** rescues an item whose anchor vanished: click **Re-point…**, then
click the element it should refer to.

`⌘F` filters notes by text or anchor.

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

## How a review reaches your agent

Three mechanisms, layered. You want all three.

### 1. Hooks — no polling, no fresh agent

`plan-editor setup hooks` merges four hooks into `~/.claude/settings.json`,
preserving anything already there:

| Hook | What it does |
| --- | --- |
| **UserPromptSubmit** | Injects the pending review into the session you're already talking to |
| **SessionStart** (`compact\|resume`) | Re-injects after a compaction, where this loop otherwise dies quietly |
| **PostToolUse** | The browser shows "agent working" the moment it touches the file |
| **Stop** | Blocks the agent from finishing with your review unanswered |

The overall note is injected every time; the individual items are injected once
and then compacted to a count, because the note is what makes them interpretable
and the items are already in the file the agent is looking at.

The Stop hook is bounded three ways, because a runaway one is worse than the bug
it fixes: it never stacks on an already-active stop hook, it gives up after two
attempts per session, and `PLAN_EDITOR_NO_STOP_HOOK=1` disables it without
uninstalling.

### 2. `watch` — for when you are actively reviewing

Hook delivery is *pull-on-prompt*: it only fires when you type. `plan-editor watch`
parks the agent so a sent review reaches it immediately. It matters much less than
it used to — with batching, nobody is waiting on a trickle.

### 3. Responding

`plan-editor respond <file> --summary "..."` closes the review and puts the work
in front of you. `plan-editor answer <file> --id <id> --outcome needs-call --note
"..."` flags a single ambiguous item rather than guessing.

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
| `⌘Enter` | Add the note you are typing |
| `⇧⌘Enter` | Send the review |
| `⌘F` | Filter notes |
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
| `plan-editor watch <file>` | Park until a review arrives. `--max-ms` bounds the wait. |
| `plan-editor poll <file>` | Long-poll for a review. `--timeout-ms`. |
| `plan-editor respond <file> --summary "..."` | Close the review with what you changed and why. |
| `plan-editor answer <file> --id <id>` | Flag one item: `--outcome caveat\|needs-call\|skipped --note "..."`. |
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

**"No agent is bound" / a review sits unsent to anyone.** Nothing is listening. Run
`plan-editor setup hooks` and restart Claude Code, or have the agent run
`plan-editor watch <file>`.

**A review is picked up only when I message the agent.** That is hook delivery
working as designed — it is pull-on-prompt. Use `watch` for instant pickup.

**The agent applied things but nothing shows as reviewable.** It edited without
responding. `plan-editor respond` is what moves a review to the review phase.

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
bun test           # 107 tests
bun run build      # browser bundles only
```

Tests cover store concurrency, the two-phase review lifecycle, morph semantics
(including multi-anchor rules and the guarantee that the tool never highlights its
own marker classes), the diff engine, version history, auth and path confinement,
and hook routing. `AGENTS.md` records the invariants and the bugs
that motivated them — including several that jsdom passed and a real browser did
not.
