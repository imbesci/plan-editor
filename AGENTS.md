# AGENTS.md

Guidance for coding agents working in this repository.

## Commands

```sh
bun run check      # build + typecheck + test — run before pushing
bun run test       # node:test files, one process per file (never bare `bun test`)
bun run test:e2e   # Playwright against a real browser and a real server
bun run build      # browser bundles only
bun run typecheck  # tsc --noEmit
```

`check` deliberately does **not** run `test:e2e`: it needs a Chromium download
(`bunx playwright install chromium`) and takes minutes rather than seconds. Run
it before shipping anything that touches the chrome, the SDK, or the boundary
between them — which is where every bug listed under "Bugs only a real browser
found" lived.

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

**Run them with `bun run test` (scripts/test.ts), never bare `bun test`.** Bare
`bun test` runs files concurrently, and its `node:test` compatibility layer keeps
"am I inside a test" in global state, so a top-level `describe()` in one file can
land mid-test in another and fail with "describe() inside another test()". The
same command reported 107 pass, then 3 fail, then 107 pass on identical code. The
runner spawns one process per file; that has never flaked.

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

## Markdown artifacts are rendered, never round-tripped

`.md` files are first-class artifacts, and the rule that makes that safe is that
**the conversion is one-way**. The markdown on disk is the source of truth; the
agent edits it exactly as it edits HTML; the browser only ever renders it
(`renderMarkdown`, `src/markdown.ts`). There is no HTML→Markdown path and there
must never be one — it is the only operation in this tool capable of silently
rewriting the user's prose, and it would run on every patch.

Consequences that are easy to get wrong:

- **Version snapshots hold the source, not the render.** Storing the render
  would make restore write HTML over someone's `.md`. Every *read* path renders
  (`renderArtifact`); every *write* path does not.
- **`POST /api/:key/write` refuses markdown with a 409.** The browser holds the
  rendered document, so writing it back is the round trip by another name.
- **The agent is given source line ranges, not selectors.** A CSS selector is an
  artefact of the render and useless to an agent about to open the file;
  `sourceLinesFor` maps ids to `plan.md:42-47` at poll time. Computed at poll
  time deliberately — the file moves under the review, so a line recorded when
  the note was written points at the wrong line by the time it is read.
- The renderer assigns every block a stable id derived from the nearest heading
  slug, because that is what the whole anchoring model rests on.

## The document is addressable, so a read does not have to be a whole file

Every anchor, churn count and markdown source range keys on the same section
ids, and for a long time nothing let an agent use that. The tool's own advice —
"apply them by editing the file directly" — therefore had an unpriced cost: to
change forty words of a 50KB plan, an agent opened 50KB, on every round of every
review.

`src/outline.ts` answers the two questions that make a targeted read possible:
what sections exist (`outlineOf`) and what is in this one (`sectionSource`).
Three rules:

- **`sectionSource` returns markdown source for a `.md`, never the render.**
  Handing an agent the HTML of a markdown block invites it to write HTML back,
  which is the one operation this codebase refuses everywhere.
- **An unknown id is refused, and the caller lists what does exist.** An
  approximate slice is a targeted read that quietly returned the wrong target;
  the id was usually copied from an item whose anchor has since moved, and "no
  such id" alone leaves nowhere to go but a full read.
- **No DOM**, for the reason `html-slice.ts` has none: this runs in the CLI,
  jsdom is a devDependency, and a malformed artifact is exactly when you want an
  answer rather than a thrown parser.

`diffSections` lives here too. `diffDocuments` does the same job better and only
ever runs in the browser, so until now an agent had no way to check its own work
— it applied a review, wrote a summary from memory, and found out whether it had
changed more than it meant to when a human noticed.

It inherits `diffDocuments`'s hardest rule: **report only the innermost changed
section.** Without it, every ancestor of an edit is reported too, so a markdown
artifact answers a one-paragraph change with four entries — the paragraph, its
section, the document — and the outermost is present for *every* edit, which is
exactly the "flag `body` on everything" failure that rule exists to prevent.
Containment is a substring test, which is sound because `sectionsOf` guarantees a
child's markup is a literal substring of its parent's.

## What a review costs the agent, in characters

Measured on a twelve-item review: 17,995 characters, of which 14,400 was
untruncated anchor text. That is paid on every `watch` cycle, and `watch` is
documented as the thing you run at the end of every turn.

The snippet runs to 1200 characters because **re-anchoring scores against it**
(`src/sdk/anchor.ts`) and a truncated needle cannot match an untruncated
haystack. None of that applies to the agent, which is about to open the file and
needs only enough text to find the passage. Excerpted head-and-tail it is 6,847
characters; 5,945 on a repeat delivery.

Two rules keep the saving from costing correctness:

- **A verbatim item's `replace_this` and `with_exactly` are never truncated, and
  it carries no `anchor_text` at all.** The agent is told to apply that text
  literally, so clipping either side turns a precise instruction back into the
  ambiguity the gesture was invented to remove — and the same passage was being
  billed twice.
- **Only prose is compacted on a repeat, never an item.** This is the exact
  inverse of the hook rule, and deliberately: a hook injection is unsolicited and
  fires on every prompt, so compacting its items is right; a `watch`/`poll` is the
  agent *asking*, and it may be asking precisely because a compaction took the
  items away. Standing rules are likewise always repeated — only the paragraph
  explaining what a standing rule *is* drops out.

Repeat delivery is tracked **per agent session** (`?agent=` on `/api/poll`, from
`CLAUDE_CODE_SESSION_ID`), for the same reason `deliveredTo` is a list: with one
global stamp, whichever agent polled first would consume the full text and every
other session — including the one that wrote the plan — would be handed the
compacted form of a review it had never seen. A caller with no id to send is
always treated as a first delivery: costlier, never wrong.

## The standing contract outlives the review

`Session.contract` is the fourth primitive, after pointing, batching, and
attribution. Reviews were stateless: nothing accumulated, so the same correction
came back in round four that was made in round one.

- **Rules are repeated on every injection; items are compacted after the first.**
  This is the exact inverse of the `deliveredAt` rule for items, and it is
  deliberate. A rule stated once and never again is a rule the agent breaks three
  turns later, and unlike an item it is not visible in the file it is looking at.
- **Retire, never delete.** A retired rule still explains past reviews, so it
  stays in `contract` and drops out of `activeContract`.
- **Promotion takes the rejection's *reason*, not the item body.** The body is
  about one paragraph; the reason is about the document, and only the reason
  generalises. Rejection reasons were the highest-signal data in the system and
  the only thing done with them was requeueing.

## Locks constrain the agent, not the human

A locked region is delivered to the agent as `do_not_touch` and rendered with a
badge in the artifact. Clicking one in annotate mode still creates a note — the
human is always allowed to ask. The badge lives in a body-level `[data-pe-ui]`
layer positioned in page coordinates, **never inside the locked element**: a
child node there is not stripped by `markupWithoutOurClasses`, so the element
would compare as changed on every single patch.

## Asking must park on the item, not the review

`plan-editor ask` and the MCP `ask_human` wait on
`GET /api/:key/items/:id/await-answer`, not on `/api/poll`.

The obvious implementation is wrong and quietly so: an item can only be asked
about while its review is still `sent`, so `takeFeedback` returns that same
review immediately and the agent unparks a millisecond after asking with
`answer: null` — and then guesses, which is the precise failure that asking
exists to prevent. This shipped once and looked like it worked. There are three
regression tests for it in `test/standing.test.ts`.

Answering a question moves the review back to `sent` and clears `deliveredTo`,
so a plain `watch` picks it up too; the agent should never need a special
command to hear a reply it asked for.

## Anchors are scored, not matched

`resolveAnchor` used to require **exact** equality of collapsed `textContent`
against a snippet truncated to 300 characters. That meant it could only re-find
elements the agent had *not* edited — the complement of the set that matters —
and no paragraph over 300 characters could ever re-anchor at all.

`src/sdk/anchor.ts` is a pure, DOM-free module: `hash` and `shingles` are
computed over the **full** text while the stored `text` is clipped, and
candidates are scored (`CONFIDENT = 0.72`). Two rules are load-bearing:

- **Ties break toward the earlier candidate.** The old code took the first
  document-order match with no arbitration, so repeated boilerplate silently
  re-anchored to the wrong node.
- **Prefer an empty candidate list to false precision.** A fully reworded
  paragraph is lexically indistinguishable from noise; `pe:trackResult` reports
  it as `weak` with ranked candidates so the human can re-point in one click,
  rather than the tool confidently attaching a note to the wrong element.

## Packets, and why they do not break the refusal set

There is still no multiplayer, no CRDT, and no identity model. A packet is
*sequential handoff*: a review exported to a file, opened against someone else's
copy, sent back. Two rules keep it that way:

- **An imported packet lands in the draft, never as a sent review.** The owner
  of the artifact decides what crosses to their agent — the same rule the local
  markup phase follows.
- **Drift is always reported.** `summarizePacket` compares the artifact hash,
  because a packet written against a different revision is exactly the case
  where anchors resolve cleanly to the *wrong* element.

`parseReviewPacket` is the one place untrusted *file* content enters the store,
so it is parsed field by field rather than spread.

## The MCP server owns stdout

`src/mcp.ts` speaks newline-delimited JSON-RPC on stdio. **A stray `console.log`
corrupts the stream**, and the failure looks like the client hanging rather than
like a log line. Everything diagnostic goes to stderr.

Two protocol details that fail silently if broken: a notification (no `id`) must
draw no response at all, and a failing tool returns `isError` content rather than
a JSON-RPC error, so the agent can read the message and recover instead of having
the call fail underneath it.

Requests are handled sequentially, not concurrently — `await_review` and
`ask_human` park for minutes, and a client pipelining behind them expects
queueing, not racing.

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
- **Version payloads are written atomically too, not just the index.** The
  payload used to be a plain `writeFile` while only `index.json` was atomic, so a
  crash mid-write left a truncated snapshot the index still advertised as valid —
  and undo restoring a half-written file is worse than having no undo.
- **A new `seq` never reuses a filename already on disk.** `readIndex` turns any
  unreadable index into an empty history, so without the `highestSeqOnDisk`
  check a corrupt index restarts numbering at 1 and silently overwrites `1.html`.
- **Pinned versions are exempt from the `MAX_VERSIONS` cap.** Pinning is the
  human saying "this one is the record"; ageing out the version someone named is
  the one drop that is never acceptable.
- **Companion paths are resolved and `stat`ed server-side**, exactly like
  `POST /api/sessions`. A client-supplied path must never become a path the
  server trusts.
- **`sectionsOf` refuses rather than guesses.** The server has no DOM, so
  `src/html-slice.ts` balances tags by hand; anything it cannot bracket
  confidently is simply not reported. A wrong slice would attribute one
  section's rewrites to another, and an absent entry is honest where a wrong one
  is not.
- **Undoing a verdict does not hunt down the requeued copy.** A rejection that
  already requeued leaves its copy in the draft; that copy is the human's to
  delete, because by then they may have edited it.
- **The watcher must not be able to go deaf.** Two failures shared one symptom:
  the file changes, the browser never patches, and there is no error anywhere.
  First, `chokidar.watch` returns before it is actually watching, so an edit in
  the first moments after a session opens could land while nothing was listening
  — `watch()` now awaits `ready` (raced against a timeout, so a platform that
  never emits it costs a bounded pause rather than hanging the open). Second, a
  native filesystem event can simply be dropped. That is not theoretical: it is
  what this suite had been calling a flake for as long as it has existed, about
  one full-suite run in three and never once in isolation. The event stays the
  delivery path and a `stat` every two seconds is the safety net. Do not replace
  it with chokidar's `usePolling`, which would put the whole pipeline on a 200ms
  floor to fix something rare — and do not shorten `RECONCILE_MS` to chase
  latency, which is what `## Latency` is about.
- **The detached server must exit, not merely stop listening.** `serve()` returns
  a `closed` promise and `serverCommand` awaits it before `process.exit(0)`. It
  used to park on `new Promise<never>(() => {})`, so `shutdown()` closed the
  listener and the process lived on. Combined with the code signature being part
  of the server's identity — which restarts it on *every* edit to `src/` — that
  leaked one ~9MB process per edit. Forty-eight were found running, only two of
  them listening. Nothing surfaced it, because a leaked process is invisible to
  every command the tool offers.

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

## Long-polls must be sliced

`watch` and `poll` issue a sequence of short requests (`POLL_SLICE_MS`) rather
than one long one. A single 15-minute request looks correct and is not: Bun's
fetch applies its own timeout well before that, which surfaced as an unhandled
`TimeoutError` that killed the command mid-wait — in front of the user, with a
DOMException stack. Short slices mean no client, proxy, or runtime default has an
opinion, and a dropped connection costs one slice instead of the whole wait.

Server-side waiting is unchanged: each slice still parks on the EventEmitter, so
an edit submitted mid-slice wakes it immediately rather than waiting out the
slice. There is a regression test for exactly that.

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

## The review is the unit, not the note

`Session.reviews` is an append-only list; at most one is ever `drafting`.

- **Markup is private.** Notes accumulate in the draft and `takeFeedback` only
  ever returns a review whose status is `sent`. Nothing reaches the agent until
  the human sends, and that is the entire point — the live model sent each note
  the moment it was written, so the agent acted on each one blind to what came
  next. Three notes about one paragraph landed as three rewrites that cancelled
  out.
- **The draft lives on the server**, not in the browser, so markup survives a
  reload. `Review.note` is saved as you type.
- **`Review.note` leads every injection and every poll payload.** "Cut this by a
  third" changes what every item under it means, so it is never dropped, not even
  on a repeat injection where the items are compacted away.
- **Agents respond, they do not just edit.** `plan-editor respond --summary` is
  what moves a review to `answered` and puts it in front of the human.
  `respondToReview` answers any item the agent did not speak to — silence would
  leave items stuck with no way for the human to act on them.
- **A rejected item keeps its `rejected` status and gains `requeued`.** Marking
  it accepted to stop it being carried forward twice showed the human the
  opposite of the verdict they gave.

## Attribution: what the agent actually did

`Review.baseVersion` is the artifact version at the moment the review was sent.
That one field carries three capabilities, which is why it is set on the server
(where the version store lives) rather than in the session store:

- **Per-item diff** — `attributeChanges` diffs base-vs-current and credits each
  changed section to the note whose anchor overlaps it, in *either* direction: a
  note on a section owns edits inside it, and a note on a paragraph is owned by
  the section reported around it.
- **Unrequested changes** — anything no note claims. This is the trust question
  for applying a whole review at once, so it renders above the items rather than
  under them. A *removed* section can never be claimed by containment (it has no
  element in the new document), so it always surfaces here.
- **Revert the whole review** — the natural undo unit now that a review is the
  unit of exchange. Writing the base snapshot back goes through the same watcher
  as any edit, so it morphs in place and is itself recorded.

**Anchors resolve through the old document as well as the new one.** The anchor
text was captured before the agent touched it, so matching it only against the
rewritten document fails on exactly the items that did change. Resolve in
`after`, else in `before`, then map across by nearest id.

## Highlighting

- **Only changed words are highlighted, and there is no whole-element fallback.**
  Flashing the enclosing block when no words changed is how a one-word edit came
  to paint a whole section green.
- **`pe-` prefixed classes are stripped before comparing markup.** The SDK marks
  tracked anchors with `pe-pending`, so the live DOM permanently differs from the
  file in ways the agent had nothing to do with; counting those meant the tool
  highlighted its own bookkeeping on every patch.

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

## Diagrams: the source is authoritative, the render is presentation

Mermaid diagrams render in the browser. Three rules keep that from fighting
everything else this tool does, and all three were learned from the predecessor
tool (see below).

- **The source element stays in the document and keeps its id.** It is hidden,
  not replaced. It is what exists in the file, so it stays the unit of diffing,
  anchoring, and word-level highlighting — and it is what the agent edits.
- **The rendered SVG is a `[data-pe-ui]` sibling, inserted `afterend`.** Not a
  child, and never in place of the source. Two reasons: `morphDocument` skips
  `[data-pe-ui]`, and the SVG is generated client-side so it is *not in the
  file* — without the marker every single patch would delete it. Putting it
  beside the source rather than inside also means a re-render churns within a
  hidden element and cannot destroy anything the human is looking at.
- **Rendering is deterministic or it is useless.** `deterministicIds: true` plus
  a render id derived from the host element's id makes `mermaid.render` return
  byte-identical SVG for identical source, with all inner ids namespaced under
  that render id. Mermaid's default random ids would make every diagram look
  rewritten on every patch: highlight flashing, a bogus entry in "changes nobody
  asked for", and any note anchored nearby orphaned. Verified in a real browser
  before any of this was built.

**Identity is the host element's `id`, never ordinal position.** The predecessor
keyed diagrams by their index among `.mermaid` elements, computed independently
in the browser and on the server. Inserting one diagram above another silently
reassigned every saved diagram to the wrong one. We diff by id everywhere else;
`doctor` warns (`diagram-without-id`) when a diagram has no id to key on.

**A note on a diagram node anchors to the node's identity and label, never to
coordinates.** `Anchor.node = {id, label}` rides along with an anchor that still
points at the *source* element. A diagram is re-rendered from source on every
patch and every theme change, so any x/y would be stale the moment the agent
touched it — whereas the node id comes from the source text and survives. A
click also snaps up to the whole `<g>`, so you annotate the node rather than the
`<rect>` under the cursor.

**Mermaid is lazy-loaded and vendored.** `dist/mermaid.js` is ~2.6MB against the
SDK's 30kb, so it is a separate bundle fetched only once a diagram is actually
found, as a classic `<script>` tag — a module `import()` would need CORS the
server does not grant to an opaque-origin frame. Vendored rather than a CDN
because artifacts must render offline, which is the same reason `doctor` flags
remote references.

**Deliberately not adopted from the predecessor:** an embedded Excalidraw
whiteboard. It is a genuinely good feature there, but it costs React plus
Excalidraw plus a mermaid-to-scene converter plus vendored fonts, pins mermaid
to an exact version because the converter reaches into its internals, and brings
a font-metrics repair pass and a two-iframe teardown protocol with it. Its own
design also makes whiteboarded diagrams un-annotatable, because the source
container is hidden and there is nothing left to click. Per-node annotation is
the cheaper half of that idea and the half that fits a tool whose whole thesis
is anchoring notes to elements.

## Keyboard shortcuts must be relayed out of the iframe

The chrome and the artifact are separate documents with no `allow-same-origin`
between them, so **they cannot see each other's key events**. A shortcut bound
only on `document` in `chrome-client.ts` is dead the moment focus enters the
frame — which is immediately, because clicking the document is the primary
interaction.

Only `⌘I` was ever relayed. Everything else — `j`/`k`, `a`/`r`/`u`, `/`, `?`,
`⌘H`, `⌘Z`, `⌘F`, `⌘\`, arrows — silently did nothing in exactly the situation
you would reach for it, which reads as "the keybinds don't work".

The SDK now posts `pe:key {key, meta, shift}` and the chrome runs it through the
same `handleKey` as a real event. Two rules:

- **The SDK must `preventDefault()`**, because the chrome cannot cancel an event
  in another document — otherwise `⌘F` opens the browser's find bar and `/`
  triggers quick-find.
- **Bare letters must be suppressed while typing in the artifact**
  (`typingInArtifact`). An artifact can contain inputs, and `j` typed into one
  must not scroll the review list.

Adding a chrome shortcut means adding it to `META_KEYS` or `PLAIN_KEYS` in
`sdk.ts` too. There is no way for the chrome alone to notice it is missing.
`⌘K`, `n` and `.` are in those sets for exactly that reason, and `⌘K` is
additionally the one binding allowed to fire while the human is typing — the
palette is the way out of not knowing what to do, so it must not be gated on
already knowing where to stand.

## Discoverability is a feature, not documentation

There are twenty-odd shortcuts, four drawers, two document gestures and a version
scrubber in the panel, and for a long time the only inventory of any of it was a
help sheet that lists keys and does nothing. `⌘K` is both the index and the entry
point: everything reachable is typeable, including jumping to a section, which is
otherwise a scroll through the outline.

- **It reuses `openSheet`.** That inherits the focus trap, Escape, and the scrim
  rather than re-deriving three things each of which was a bug once.
- **A command closes the palette before it runs.** Several of them open a sheet of
  their own, and two dialogs fighting over the same `#overlay` node is not a state
  worth having.
- **Matching is a subsequence**, so a half-remembered name still finds the thing.

The same principle covers the rest of the panel's affordances. Each one existed as
a capability the tool already had and never offered:

- **Redo (`⇧⌘Z`)** was free the whole time. Undo is implemented by *writing an old
  snapshot back*, which snapshots too — so the version undone from is still in
  history and redo is a restore of it. Without it, one stray `⌘Z` on an hour's work
  had no route back that did not involve opening history and guessing.
- **The panel width is a variable, not 340px.** Held in `--panel-w` on `.layout`
  and set by an absolutely-positioned grip on the panel's left edge — out of flow
  deliberately, because the two-column template is load-bearing for the collapse
  state and every breakpoint below it. The stacked layout hides the grip and
  ignores the stored width.
- **The composer draft is the one thing a reload ate.** Everything else the human
  types exists somewhere already: the overall note is debounced to the server,
  replies and answers survive a re-render. An uncommitted note exists nowhere, so
  it goes to `localStorage` — not to the server, because a half-formed thought is
  not part of the review. It is cleared only once the server has the note, and the
  restore says so out loud: text reappearing in a box with no explanation reads as
  the tool having sent something.
- **Lint findings belong in front of the human.** `doctor` has existed as a command
  since anchoring did, which means the only person never shown "this document has
  no ids" was the one who could ask for it to be fixed. Only findings that break
  anchoring are surfaced (`no-ids-at-all`, `duplicate-ids`, `missing-section-ids`);
  style findings would train the human to dismiss the banner.
- **`End` asks when notes are unsent.** The notes are not destroyed — the draft is
  on the server — but the agent is told to stop, so work the human believes they
  are about to send goes nowhere, and the tab they would have sent it from is gone.
- **Word count and its delta are shown because that is what most reviews are
  about.** "Cut this by a third" is the commonest overall note there is, and both
  numbers were already in hand: the current document is parsed on every patch and
  the review's base snapshot is fetched for attribution.

## A selection must be releasable

Clicking an element arms a note. Until this was fixed there was **no way to take
that back**: `pe:cancel` existed in the SDK and the chrome only ever sent it on
a failed submit, so a mis-click left a pulsing outline whose only exit was to
write a note you did not want and then delete it from the panel.

Three paths now release it, and all three go through `clearArmed()` in the SDK
and `unarm()` in the chrome: clicking the armed element again, `Escape`, and a
visible **Clear selection** button (Escape alone is not discoverable).

`clearArmed()` only ever drops the *armed* group. Everything else in `pending`
is a real note that exists on the server, and clearing those marks would tell
the human their feedback had vanished.

**Leaving annotate mode clears the selection too**, and `.pe-pending` is styled
only inside `.pe-annotate` — the marks are an annotating affordance, so the mode
that produced them going away has to take them with it. Otherwise the document
still looks marked up while none of the tools that made the marks are on screen.

## Bugs only a real browser found

Every one of these passed the whole `node:test` suite. They were caught by
driving Chromium against a live server (`e2e/`, Playwright), and each is now
covered there.

- **A note typed straight after a click was filed against the whole page.** The
  click and the first keystroke are separated by a `postMessage` hop across the
  sandbox, so `armed` was still null when the text arrived; the chrome
  auto-committed it as a `page` note, cleared the box, and *then* displayed
  "Pinned to …" for the element. The auto-commit is only correct when a previous
  target existed — with nothing pinned, the text belongs to the element just
  clicked. Silent mis-filing is the worst failure this tool can have.
- **Settling the last item made the review vanish.** Giving every item a verdict
  closes the review, and `phase()` fell straight back to `drafting`, so the work
  disappeared mid-keystroke and `u` — the documented undo for a misfired verdict
  — became unreachable, because it acts on the focused card and there was no
  longer a card. A closed review now stays visible until the human starts marking
  up again. Note the render path reads `answeredReview() ?? closedReview()`, not
  `visibleReview()`; changing one without the other renders an empty list.
- **The navigator's outline had no click handler at all.** It rendered buttons
  that highlighted on hover and did nothing, which is worse than not shipping it.
- **Every morph nested a second `<head>` and `<body>`.** `innerHTML` morphing
  takes the *children* of the new content, so it must be handed
  `parsed.head.innerHTML`, not `parsed.head`. Invisible to jsdom, invisible to
  the user, and it does not compound — it just quietly mangles the document.
- **`markupWithoutOurClasses` stripped our classes but not our nodes.** A
  rendered diagram or a lock badge is a `[data-pe-ui]` child that exists only in
  the live DOM, so any element containing one compared as changed on *every*
  patch — marking every note on that section addressed by an edit nobody made.

The lesson worth keeping: this codebase's hardest bugs live at the boundary
between the two documents, and jsdom cannot see across it.

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
append-only record instead of a merge problem. Packets give sequential handoff
without touching any of that — see above.

No AI in the tool itself. plan-editor never calls a model. It moves reviews to
your agent and changes back to your browser; the intelligence is entirely in the
conversation you were already having. Grouping rejections for the
"promote to a rule" hint is string comparison, deliberately, and should stay
that way.
