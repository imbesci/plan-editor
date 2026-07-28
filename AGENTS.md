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
- **Morph input is parsed to a node, not passed as a string.** Artifact files start
  with a doctype, and morphing `<html>` from a doctype-carrying string raises
  `HierarchyRequestError`.
- **The root element is never recorded as changed.** Idiomorph hands the callback a
  normalized clone for the root, so `<html>` compares as different even for an
  identical document; recording it would flash the whole page on every patch.
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

## Things that are deliberately absent

No multiplayer, no CRDT, no identity model. The artifact is agent-owned and humans
propose changes to it; that design call is what keeps the annotation layer a simple
append-only record instead of a merge problem. No version history yet — it is the
natural next feature, and the morph diff already computes most of what it needs.
