# plan-editor

Mark up a document the way you'd mark up a draft — freely, at your own pace — then
send the whole review to your agent at once.

It applies the set, the page patches itself in place, and you accept or reject its
work item by item. No reload, no losing your scroll position, and the review goes
back to the agent you were already talking to, not a fresh one that has never seen
the document.

Works on `.html` and `.md`.

There is also a full reference as a browsable page: **[`README.html`](README.html)**.
It is itself a compliant artifact, so `plan-editor README.html` opens the docs for
review — which is the shortest way to see what the tool does.

```sh
bun install
bun run build
bun run bin/plan-editor.js plan.md
bun run bin/plan-editor.js setup hooks     # once, then restart Claude Code
```

---

## Contents

- [The idea](#the-idea)
- [Quick start](#quick-start)
- [The two phases](#the-two-phases)
- [Why batched, not live](#why-batched-not-live)
- [The overall note](#the-overall-note)
- [Saying it precisely](#saying-it-precisely)
- [Standing rules](#standing-rules)
- [Locked regions](#locked-regions)
- [When the agent is unsure](#when-the-agent-is-unsure)
- [The lifecycle](#the-lifecycle)
- [Versions, undo, and diff](#versions-undo-and-diff)
- [Diagrams](#diagrams)
- [Markdown artifacts](#markdown-artifacts)
- [Reviewing with someone else](#reviewing-with-someone-else)
- [The record](#the-record)
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

Each item shows **what actually changed** — a word-level diff of the section it
touched, next to the note that asked for it. A summary tells you what the agent
says it did; this shows you what it did.

Anything it changed that **no note asked for** is called out above the list. That
is the trust question for handing over a whole review at once, so it is not buried.

Then you **Accept** or **Reject** each one. A rejection carries your reason into
your next review automatically, so the agent always hears why. **Revert this whole
review** puts the document back to exactly how it looked before you sent it.

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

## Saying it precisely

Prose is the worst way to express the two cheapest kinds of change. Both have
their own gesture.

**Suggest an exact replacement.** For a typo, a wrong number, a bad sentence,
writing *"change 'leverage' to 'use'"* is a round trip and an ambiguity. Turn on
suggest mode and type the replacement directly. It goes to the agent as
`replace this → with exactly this`, and the agent is told to apply it literally
or skip it and say why — never to paraphrase it.

The document is agent-owned, so your edit is restored in the browser the instant
you commit it. You are proposing, not editing; the file changes when the agent
changes it.

**Ask for a structural change by doing it.** Delete, move above, move below,
split, merge. *"Move Risks above Milestones but leave the intro where it is"* is
an id-set operation dressed up as a sentence — these send it as the operation.

| Item kind | What the agent receives |
| --- | --- |
| note | your prose, plus the anchored text |
| verbatim | the original text and the exact replacement |
| structural | the operation, the subject, and the target |

---

## Standing rules

The overall note dies with its review. A standing rule does not.

*"Never use the word 'leverage'."* *"Keep sections under 200 words."* *"Every
claim needs a number."* Rules are injected ahead of **every** review of this
document, forever, until you retire them.

This is the one feature aimed squarely at the thing that makes iterating with an
agent feel slower than writing it yourself: making the same correction in round
four that you made in round one.

The inverse of the item rule applies deliberately. Items are listed in full once
and then compacted to a count, because they are visible in the file the agent is
looking at. **Rules are repeated every single time**, because they are not.

**Promote a rejection into a rule.** When you reject an item you give a reason,
and the reason is the part that generalises — the item was about one paragraph,
the reason is about the document. One click turns it into a standing rule.

```sh
plan-editor contract plan.md --add "Never use the word 'leverage'."
plan-editor contract plan.md                    # list them
plan-editor promote plan.md --id <item-id>      # from a rejection
```

Retiring a rule keeps it on the record — it still explains the reviews it shaped.

---

## Locked regions

Mark a section, a table, or a number **do not touch**.

The agent is told about locks before it is told about the review, and it is told
to raise the conflict rather than resolve it — even when an item seems to ask for
a change inside one.

A lock constrains the agent, not you: you can still pin a note to locked content.
Asking is always allowed; changing it unasked is not.

```sh
plan-editor lock plan.md --selector "#budget" --label "Budget table"
```

This is the natural completion of the *changes nobody asked for* report, which
already tells you when the agent went outside the brief. A lock turns that from
a report into a rule.

---

## When the agent is unsure

Guessing is how a review comes back with three items right and one confidently
wrong. There are two ways out, and both put the decision back in the browser.

**It asks.** `plan-editor ask <file> --id <item> --question "..."` parks the
agent. The question appears on the item, pinned to the top of your panel because
something is waiting on it. You answer, and the agent unparks in milliseconds.

**It shows you two versions.** For a choice better seen than described, the agent
offers alternatives. Hovering one previews it in the document in place; clicking
picks it.

Either way the item's thread records the exchange, so the transcript shows not
just what changed but what was uncertain and how it was settled.

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

**Rejecting can also undo the change.** Recording a verdict used to leave the
agent's unwanted text sitting in the document until the next round — you said no
and the words stayed. Reject now offers *"…and undo that change"*, which puts
just that section back to how it was before the review, leaving every other item
the agent got right in place.

**A verdict is undoable.** Accept and Reject are one keystroke each (`a` and
`r`); `u` puts an item back if you misfire.

**Accept all** settles the whole review in one click. When some items were
flagged for you rather than simply applied, it names them first and offers to
take only the straightforward ones — those are precisely the items the agent
refused to guess at, and sweeping them up silently is the failure the review
phase exists to prevent.

**Re-point** rescues an item whose anchor moved. It rarely needs you now: anchors
carry a content hash and word shingles, so an item survives the agent rewriting
the very paragraph it points at. When a match is genuinely uncertain the item is
flagged and offered ranked candidates to re-point to in one click, rather than
the tool guessing and attaching your note to the wrong element.

`⌘F` filters notes by text or anchor. `/` searches inside the document itself,
and the outline — the **Document** button in the toolbar — lists every section
with a count of the notes open on it. It sits beside the file name rather than in
the panel: it is the one part of the panel that was never about the review, and
the notes are what the panel is for.

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

**Name the ones that matter.** A row of anonymous `v7`s is not history. Label a
version — *"sent to leadership"* — and pin it, and pinned versions are exempt
from the cap, because ageing out the one you deliberately named is the only drop
that is never acceptable.

**Compare any two versions**, not just the current one against an older one.

**Churn** answers a question the tool always had the data for and never asked:
which sections keep getting rewritten? A section rewritten six times is one you
and the agent still disagree about, and it is usually not the one you would have
guessed.

```sh
plan-editor version plan.md --seq 12 --label "sent to leadership" --pin
plan-editor churn plan.md
```

---

## Diagrams

Mermaid diagrams render in the browser, in both `.html` and `.md` artifacts.

```html
<pre class="mermaid" id="retry-flow">
flowchart LR
  IN[Job arrives] --> TRY[Attempt]
</pre>
```

In markdown, a ```` ```mermaid ```` fence is enough — the renderer gives it a
stable id for you.

**Click a node to pin a note to it.** The note anchors to the node's identity and
its label, never to a position on screen, and the anchor itself still points at
the diagram's *source* — so the agent is told "the node labelled Classify" and
edits the text that produced it.

**The source is authoritative.** The diagram text stays in the document and keeps
its id; the rendered SVG sits beside it as generated presentation. Nothing you do
in the browser rewrites the file, and an export contains the same diagram source
the agent wrote.

Three properties make this safe rather than a constant source of noise:

- Rendering is **deterministic** — identical source produces byte-identical SVG,
  so an untouched diagram produces no diff. Mermaid's default random ids would
  have made every diagram look rewritten on every single patch.
- The SVG is **excluded from the diff**, because it is generated in the browser
  and is not in the file.
- Diagram identity is the **container's `id`**, not its position in the document,
  so inserting a diagram above another does not re-point notes on it. `doctor`
  warns when a diagram has no id.

Mermaid is ~2.6MB, so it is vendored and fetched **only when a diagram is
actually present** — artifacts without one pay nothing, and artifacts with one
still work offline.

---

## Markdown artifacts

Agents write `PLAN.md` far more often than they write `plan.html`, so `.md` is a
first-class artifact.

**The markdown stays markdown.** It is the source of truth on disk; the agent
edits it exactly as it edits HTML; the browser only ever renders it. There is no
HTML-back-to-Markdown path and there never will be — a lossy round trip is the
one operation in this tool capable of quietly rewriting your prose, and it would
run on every patch.

Two things follow, both of which you get for free:

- **Every block gets a stable id**, derived from the nearest heading. Section ids
  are the highest-value property an artifact can have, and here you do not have
  to write them.
- **The agent is given source line ranges, not selectors.** An item arrives as
  `plan.md:42-47`. A CSS selector is an artefact of the render and useless to an
  agent about to open the file.

Version history stores the markdown, so undo and revert write markdown back.

---

## Reviewing with someone else

There is still no multiplayer, no CRDT, and no identity model — that refusal is
what keeps anchoring, threading, and undo tractable. But *"let my colleague
review this"* is a real need, so it is handled by sequential handoff instead.

```sh
plan-editor packet export plan.md --review <id> --out review.packet.json
# they open it against their own copy
plan-editor packet import plan.md --in review.packet.json --from "Sam"
```

An imported packet lands in **your draft**, never as a sent review: you still
decide what crosses to your agent, exactly as with your own markup. And a packet
carries the hash of the document it was written against, so if your copy has
moved on you are told — that is precisely the case where anchors resolve cleanly
to the wrong element.

---

## The record

`export` writes the artifact. The more useful artifact of a review cycle is the
**record**: what was asked, what the agent said it did, what you accepted, and
why you rejected the rest.

```sh
plan-editor transcript plan.md --out review-record.md
```

That is the handoff document, the audit trail, and the thing that goes in a PR
description.

Artifacts also live in repos, so version history no longer has to be a parallel
universe: `plan-editor commit plan.md --message "..."` stages and commits just
that file, and the panel shows the artifact's git status and its diff against
`HEAD`.

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
"..."` flags a single ambiguous item rather than guessing — and
`plan-editor ask` goes further, parking the agent until you actually answer.

### 4. Agents that are not Claude Code

`plan-editor mcp` is an MCP server over stdio, so any MCP client gets typed tools
— `open_artifact`, `await_review`, `respond_to_review`, `ask_human`,
`offer_alternatives`, `list_standing_rules` and the rest — instead of shelling
out and parsing prose. `plan-editor setup mcp` prints the config to paste.

For Claude Code the hooks remain strictly better: they deliver a review into the
session you are already in, with no tool call required at all.

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
| `⌘K` | Everything you can do here, by name — the fastest way to find anything |
| `⌘I` | Toggle annotate mode |
| `⌘E` | Suggest mode — type the exact replacement |
| Click | Anchor a note to an element |
| Select text, then click | Anchor to the selection instead |
| `⇧`-click | Add another element to the same note (again to remove) |
| Click it again | Un-select an element you did not mean to pick |
| `⌘Enter` | Add the note you are typing |
| `⇧⌘Enter` | Send the review |
| `⌘F` | Filter notes |
| `/` | Find in the document — opens the Document popover in the toolbar |
| `⌘Z` | Undo the last change |
| `⇧⌘Z` | Put it back |
| `⌘H` | Version history |
| `← →` | Scrub versions (while history is open) |
| `⌘\` | Hide or show the panel (focus mode) |
| `j` / `k` | Move through your notes — the document scrolls to follow |
| `.` | Jump to the next note that is waiting on you |
| `n` | Start writing a note |
| `Enter` | Jump the document to the focused note |
| `a` / `r` | Accept or reject the focused note |
| `u` | Undo a verdict on the focused note |
| Hover a note | The document scrolls to what it points at |
| Drag the grip above the note box | Resize the entry area — it remembers, double-click resets |
| Drag the panel's left edge | Resize the panel — it remembers, double-click resets |
| Theme button | Cycle system → light → dark |
| `Esc` | Close an overlay, disarm a gesture, cancel re-pointing, or clear the selection |
| `?` | Shortcut list |

---

## CLI reference

**Reviewing** — `.html`, `.htm`, `.md`

| Command | Description |
| --- | --- |
| `plan-editor <file>` | Open for review. Reuses an existing tab if one is watching. |
| `plan-editor watch <file>` | Park until a review arrives. `--max-ms` bounds the wait. |
| `plan-editor poll <file>` | Long-poll for a review. `--timeout-ms`. |
| `plan-editor respond <file> --summary "..."` | Close the review with what you changed and why. |
| `plan-editor answer <file> --id <id>` | Flag one item: `--outcome caveat\|needs-call\|skipped --note "..."`. |
| `plan-editor applied <file> --id <id>` | Declare one item done, when the browser never confirmed it. |
| `plan-editor ask <file> --id <id> --question "..."` | Ask about one item and **park until answered**. |
| `plan-editor alternatives <file> --id <id> --json alts.json` | Offer two or more versions to pick from. |
| `plan-editor end <file>` | End a session. |

**Standing context** — outlives any one review

| Command | Description |
| --- | --- |
| `plan-editor contract <file>` | List the rules injected into every review. |
| `plan-editor contract <file> --add "rule"` | Add one. `--retire <id>` retires it. |
| `plan-editor promote <file> --id <id>` | Turn a rejection's reason into a standing rule. |
| `plan-editor lock <file> --selector "#budget"` | Mark a region do-not-touch. `--label`, `--remove <id>`. |
| `plan-editor companions <file> --with a.md b.html` | Review several artifacts as one set. |

**Reading an artifact without reading all of it** — an agent should not open 50KB to change forty words

| Command | Description |
| --- | --- |
| `plan-editor outline <file>` | Sections, their anchor ids, word counts and source line ranges. |
| `plan-editor section <file> --id <id>` | One section's source, exactly as it is on disk. |
| `plan-editor diff <file>` | What changed, by section. `--since <seq>`. |

**History and the record**

| Command | Description |
| --- | --- |
| `plan-editor undo <file>` | Restore the previous version. |
| `plan-editor version <file> --seq n --label "..." [--pin]` | Name or pin a version. |
| `plan-editor churn <file>` | Which sections keep being rewritten. |
| `plan-editor transcript <file>` | The review record as Markdown. `--out <path>`. |
| `plan-editor export <file>` | Write a standalone copy. `--out <path>`. |
| `plan-editor commit <file> --message "..."` | Stage and commit just this artifact. |
| `plan-editor packet export <file> --review <id>` | Hand a review to another reviewer. `--out`. |
| `plan-editor packet import <file> --in <path>` | Take one back. `--from <name>`. |

**Authoring and setup**

| Command | Description |
| --- | --- |
| `plan-editor new <file>` | Write a compliant starter artifact. `--template plan\|spec\|report`, `--title`. |
| `plan-editor doctor <file>` | Lint an artifact for anchoring problems. `--fix` adds the missing ids. |
| `plan-editor prune [--days 7]` | Drop ended sessions and their version history. |
| `plan-editor setup hooks` | Install the Claude Code hooks. |
| `plan-editor setup mcp` | Print the MCP client config. `--out <path>`. |
| `plan-editor mcp` | Run the MCP server on stdio. |
| `plan-editor status` | Server state, sessions, bound agents, review counts. |
| `plan-editor stop` | Shut the background server down. |
| `plan-editor server [--verbose]` | Run the server in the foreground. |

Flags worth knowing: `--no-open` (never launch a browser), `--force-open` (launch
even when a tab is already watching).

---

## Writing artifacts that work well

**Start from a template, or check what you have.**

```sh
plan-editor new plan.html --template plan --title "Ingest retry budget"
plan-editor doctor plan.html
```

`doctor` checks the properties this tool actually depends on — duplicate ids
(which make a section invisible to the diff), sections with no id at all, missing
theme support, an SDK tag committed into the file, slabs of text too large to
diff usefully, and references that will not resolve in an export. It is the check
that used to not exist, which is why every anchoring failure surfaced a long way
from its cause.

On a `.md` file it lints the render, so it has nothing to complain about: the
ids are generated for you.


**Support the theme toggle.** plan-editor can force light or dark regardless of
the OS setting, and it tells the artifact by setting `data-theme` on its root. An
artifact that only uses the media query will quietly keep following the OS, which
looks broken next to a chrome that just went dark. Write both:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #131211; /* … */ }
}
:root[data-theme="dark"] { --bg: #131211; /* … */ }
```

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

A session record holds the reviews, the standing contract, the locks, and the
companion set. Markdown artifacts are rendered on every read path
(`src/markdown.ts`) and never on a write path, which is what keeps the source of
truth in the format you chose.

Anchors are scored rather than matched (`src/sdk/anchor.ts`): each carries a
content hash and word shingles over the full text, so an item still resolves
after the agent rewrites the paragraph it points at. Below the confidence
threshold the tool reports candidates instead of guessing.

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
anchoring, threading, and undo are all tractable. [Packets](#reviewing-with-someone-else)
give you a second reviewer without touching any of it.

**No AI in the tool itself.** plan-editor never calls a model. It moves reviews to
your agent and changes back to your browser; the intelligence is entirely in the
conversation you were already having. Even the "these rejections look alike"
hint is string comparison, and should stay that way.

**No HTML-to-Markdown conversion.** Markdown artifacts render one way only. The
round trip is the single operation here capable of quietly rewriting your prose,
and it would run on every patch.

---

## Development

```sh
bun run check      # build + typecheck + test
bun run test       # 334 unit tests — not bare `bun test`, see AGENTS.md
bun run test:e2e   # 82 end-to-end tests in a real browser
bun run build      # browser bundles only
```

The end-to-end suite (`e2e/`) drives Chromium against a real detached server: it
clicks into the sandboxed artifact frame, types, drags selections, fires every
keyboard shortcut from inside the iframe, and runs the CLI as an agent would. It
needs a one-off `bunx playwright install chromium` and is kept out of `check`
because it takes minutes. It exists because this codebase's hardest bugs live at
the boundary between the two documents, and jsdom cannot see across it.

Tests cover store concurrency, the two-phase review lifecycle, morph semantics
(including multi-anchor rules and the guarantee that the tool never highlights its
own marker classes), anchor scoring, the diff engine, version history, the
markdown renderer, the artifact linter, transcripts, packets, git integration,
the MCP protocol, auth and path confinement, and hook routing. `AGENTS.md` records
the invariants and the bugs that motivated them — including several that jsdom
passed and a real browser did not, and several that looked like working features
until something waited on them.
