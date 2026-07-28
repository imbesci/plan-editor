# plan-editor

Click an element, say what you want changed, watch it change in place.

No reload. No flash. No "scroll back to where you were."

```sh
bun install
bun run build
bun run bin/plan-editor.js plan.html
```

Your agent writes an HTML artifact. You open it, turn on annotate mode (`⌘I`), click
the paragraph you want changed, and type what you want. The agent applies the edit by
editing the file normally — and the open page patches itself in place, flashes what
changed, and marks your note as applied.

## How it works

```
you click an element      ─┐
type the change            │
submit                     ▼
                     ┌───────────────┐
                     │ annotation    │  durable server-side record,
                     │ status:       │  not a fire-and-forget message
                     │  submitted    │
                     └──────┬────────┘
  plan-editor poll ◄────────┘
  (agent blocks)
        │
        ▼
  agent edits plan.html  ──►  chokidar  ──►  SSE "patch"
                                                 │
                                                 ▼
                                    chrome fetches new HTML
                                                 │
                                                 ▼
                                    SDK morphs the DOM in place
                                                 │
                                    ┌────────────┴────────────┐
                                    ▼                         ▼
                            flash what changed      annotation → addressed
```

The key move is **morph, not reload**. A reload destroys DOM node identity, which is
why comment anchors in tools like this normally orphan the moment the agent rewrites
the file. Morphing updates nodes in place, so an annotation holding an element
reference stays valid across the edit — and the morph callbacks hand back the exact
set of changed nodes, which turns "did the agent address my note?" into a set
membership check instead of a fuzzy match.

## Commands

| Command | Description |
| --- | --- |
| `plan-editor <file.html>` | Open the artifact for review. Prints a tokenised URL. |
| `plan-editor poll <file.html>` | Long-poll for submitted edits. Silent while waiting — never kill it. |
| `plan-editor poll <file> --reply "..."` | Report back to the browser, then keep waiting. |
| `plan-editor status` | List sessions with open and addressed edit counts. |
| `plan-editor end <file.html>` | End the session. |
| `plan-editor stop` | Shut down the background server. |
| `plan-editor setup hooks` | Install the Claude Code hooks (see below). |

## Claude Code hooks

**This is what makes the tool usable without a second agent.** Run
`plan-editor setup hooks` once; it merges four hooks into `~/.claude/settings.json`
without disturbing anything already there.

- **UserPromptSubmit** — pending edits are injected into the session you are
  *already talking to*. Submit an edit in the browser, say anything to your agent,
  and it is simply there. No blocking poll, no fresh terminal, no agent starting
  from zero context. Full text is injected once, then compacted to a one-line
  reminder so it does not repeat every prompt, and it goes silent entirely once the
  edit is applied.
- **SessionStart** (`compact|resume`) — re-injects after a compaction or resume,
  which is exactly where this kind of loop is otherwise silently lost.
- **PostToolUse** (`Edit|Write|MultiEdit`) — the moment the agent touches the
  artifact the browser marks the pending element as being worked on, *before* the
  write lands, so the UI reacts immediately rather than after a round trip.
- **Stop** — if you have submitted edits the agent has not applied, it is blocked
  from finishing. This turns the review loop from a prompt-engineering hope into an
  invariant.

Without hooks you fall back to `plan-editor poll <file>`, which works but requires
an agent to volunteer a blocking call — and running it in a new terminal gives you
an agent with no context.

The Stop hook is bounded three ways, because a runaway one is worse than the bug it
fixes: it never stacks on an already-active stop hook, it gives up after
`MAX_CONSECUTIVE_BLOCKS` (2) attempts per session, and `PLAN_EDITOR_NO_STOP_HOOK=1`
disables it entirely without uninstalling.

## Writing artifacts that morph well

Give top-level sections stable `id` attributes. Idiomorph matches on id first, so
ids let it update a section in place instead of tearing it down and rebuilding it —
which is the difference between an annotation being marked `addressed` and being
marked `orphaned`.

```html
<section id="risks">…</section>   <!-- good: survives a rewrite -->
<section>…</section>              <!-- matched structurally; more fragile -->
```

## Security model

The session key is `sha256(path)` — guessable, so it is an **identifier, not a
credential**. Every session-scoped route requires a random capability token minted at
open time and delivered only to the CLI that created the session.

- `POST /api/sessions` validates the extension and stat server-side, so a local
  process cannot register `/etc/passwd` and read it back through the artifact route.
- Sibling assets are confined to the artifact directory both lexically **and** by
  `realpath`, so a symlink planted next to an artifact cannot escape it.
- A Host-header allowlist rejects DNS rebinding. An origin check alone does not:
  a rebound page sends its hostile hostname in *both* `Origin` and `Host`.
- State-changing routes additionally require same-origin.

## Environment

| Variable | Default | Purpose |
| --- | --- | --- |
| `PLAN_EDITOR_PORT` | `4471` | Server port |
| `PLAN_EDITOR_HOST` | `127.0.0.1` | Bind address |
| `PLAN_EDITOR_STATE_DIR` | `~/.plan-editor` | Session storage |
| `PLAN_EDITOR_ALLOWED_HOSTS` | — | Extra allowed Host values |
| `PLAN_EDITOR_NO_STOP_HOOK` | — | `1` disables the Stop guard |
| `PLAN_EDITOR_DEBUG` | — | `1` logs server events to stderr |

## Development

```sh
bun run check      # build + typecheck + test
bun test           # 59 tests
bun run build      # browser bundles only; Bun runs the server TS directly
```
