---
name: plan-editor
description: Open an HTML or Markdown artifact for the human to mark up in their browser, then apply the review they send back. Use when about to hand over a plan, spec, design, report, comparison, or anything the human will want to give precise feedback on — pointing at a paragraph beats describing it in prose. Also use when the human says a document needs changes and you want them to show you where.
argument-hint: <path to the .html or .md artifact>
metadata:
  tags: [review, artifacts, html, markdown, feedback]
  category: collaboration
---

# plan-editor

The human marks up your document by pointing at it. You get the whole review as
one batch, apply it, and answer for what you did.

```sh
plan-editor plan.md            # opens it in their browser
plan-editor watch plan.md      # park until they send a review
```

If it is not on `PATH`, run it from the repo with
`bun run bin/plan-editor.js …`.

---

## The loop

1. **Write the artifact.** `.html` or `.md`. Give every section a stable `id` —
   see [Writing artifacts](#writing-artifacts-they-can-actually-anchor-to).
2. **Open it.** `plan-editor <file>`.
3. **Wait.** End your turn with `plan-editor watch <file>`. It parks and returns
   the moment they hit Send, in about 40ms.
4. **Read the whole review before changing anything.**
5. **Apply it** by editing the file directly.
6. **Respond.** `plan-editor respond <file> --summary "what you changed and why"`.

Step 6 is not optional. Editing the file does not close the review — responding
is what puts your work in front of them to accept or reject.

---

## Five rules that matter more than the rest

**Do not touch the file while they are marking up.** The document holding still
is what lets them read and annotate it. Between `open` and the review arriving,
leave it alone.

**Read every item before you change one thing.** A review is one pass, not a
stream. Two items can pull in opposite directions and the overall note usually
says which wins. That note leads every payload; it is the context that makes the
individual items interpretable.

**Never tell the human to reload.** The page patches itself in place. If you
find yourself writing "refresh to see the changes", something is wrong.

**Ask instead of guessing.** `plan-editor ask <file> --id <id> --question "..."`
parks until they answer in the browser. A confidently wrong item costs far more
than a question. If showing beats asking, use `alternatives`.

**Honour the standing rules and the locks.** They arrive with every review as
`standing_rules` and `do_not_touch`. The rules exist because the same correction
kept coming back. A locked region is not yours to edit even if an item seems to
ask for it — say so and let them unlock it.

---

## Reading a review

`watch` and `poll` return one review:

```json
{
  "status": "review",
  "standing_rules": ["Never use the word 'leverage'."],
  "do_not_touch": [{ "selector": "#budget", "label": "Budget table" }],
  "overall_note": "Cut this by a third.",
  "items": [
    { "id": "aB3", "request": "Tighten this.", "anchor_text": "…", "selector_hint": "#risks-p" }
  ]
}
```

Items come in three kinds. Handle each on its own terms:

| Kind | What you get | What to do |
| --- | --- | --- |
| a note | `request` plus the anchored text | Apply the prose instruction |
| `verbatim` | `replace_this` and `with_exactly` | Apply it **literally**. Do not paraphrase. Skip it and say why if you disagree |
| `structural` | `operation` (`delete`, `move-before`, `move-after`, `split`, `merge`) and its target | Perform the operation |
| on a diagram | `diagram_node` | Edit the diagram **source**; the picture is generated from it |

For a Markdown artifact each item carries `source` — `plan.md:42-47` — instead of
a selector. Edit those lines. A CSS selector is an artefact of the render and is
not something you can act on.

---

## Answering for what you did

```sh
# The normal close.
plan-editor respond <file> --summary "Tightened Risks; left the budget alone as locked."

# Anything you did not simply apply, flagged before you respond.
plan-editor answer <file> --id <id> --outcome caveat|needs-call|skipped --note "why"

# Block until they answer a question about one item.
plan-editor ask <file> --id <id> --question "Shorter by how much?"

# Offer a choice rather than picking blind.
plan-editor alternatives <file> --id <id> --json alts.json
```

Silence is the one thing that does not work. An item you neither applied nor
flagged is reported as applied, which is a lie you will be held to — the browser
shows them a word-level diff of what actually changed next to the note that
asked for it, and anything you changed that no note asked for is called out
above the list.

---

## Standing context

These outlive any single review, and you can set them too:

```sh
plan-editor contract <file>                      # the rules you must honour
plan-editor contract <file> --add "Keep sections under 200 words."
plan-editor lock <file> --selector "#budget" --label "Budget table"
plan-editor companions <file> --with spec.md rfc.html
```

If the human rejects an item and their reason is really about the document
rather than that paragraph, offer to promote it:
`plan-editor promote <file> --id <id>`.

---

## Read a section, not a document

An artifact is addressable. Every anchor, every churn count and every markdown
source range keys on the same section ids — so to change forty words you do not
need to open fifty kilobytes.

```sh
plan-editor outline plan.md              # sections, ids, word counts, line ranges
plan-editor section plan.md --id risks   # just that section's source
plan-editor diff plan.md                 # what changed, by section
```

`outline` is a few hundred tokens against a whole document's several thousand,
and the ids it returns are the ones review items anchor to — so an item on
`#risks` is a two-line read. `section` hands back exactly what is in the file:
markdown for a `.md`, markup for an `.html`. Both refuse rather than guess when
an id is unknown, and list what does exist.

`diff` is how you check your own work before reporting it. Anything in it that no
review item asked for is what the human is shown as *a change nobody asked for*,
which is the trust question for accepting a whole review at once.

---

## Writing artifacts they can actually anchor to

**Give top-level sections stable `id` attributes.** This is the single
highest-value thing you can do. Annotations anchor to elements, and an id is the
difference between a note coming back `addressed` and coming back `orphaned`.

```html
<section id="risks">…</section>   <!-- survives your rewrite -->
<section>…</section>              <!-- fragile -->
```

**Support the theme toggle** — write both selectors, or the artifact keeps
following the OS while the chrome goes dark:

```css
@media (prefers-color-scheme: dark) {
  :root:not([data-theme="light"]) { --bg: #131211; }
}
:root[data-theme="dark"] { --bg: #131211; }
```

**Check it before you open it:**

```sh
plan-editor new plan.html --template plan|spec|report   # starts compliant
plan-editor doctor plan.html                            # duplicate ids, missing ids, theme, oversized blocks
plan-editor doctor plan.html --fix                      # adds the missing ids and changes nothing else
```

`--fix` inserts `id` attributes into the opening tags that need them and touches
nothing else in the document — no reformatting, no reordering. It is safe to run
on a file the human is in the middle of reviewing; the browser patches itself in
place, so do not tell them to reload.

Markdown needs none of this — the renderer derives ids for you. A ` ```mermaid `
fence renders as a diagram, and the human can pin a note to a node in it.

---

## Command reference

| Command | Purpose |
| --- | --- |
| `plan-editor <file>` | Open for review. `--no-open` to skip the browser |
| `plan-editor watch <file>` | Park until a review arrives. `--max-ms` |
| `plan-editor poll <file>` | Long-poll. `--timeout-ms` |
| `plan-editor respond <file> --summary "…"` | Close the review |
| `plan-editor answer <file> --id <id>` | Flag one item |
| `plan-editor applied <file> --id <id>` | Declare one item done when the browser never confirmed it |
| `plan-editor ask <file> --id <id> --question "…"` | Ask and park |
| `plan-editor alternatives <file> --id <id> --json f.json` | Offer options |
| `plan-editor contract <file>` | Standing rules. `--add`, `--retire` |
| `plan-editor promote <file> --id <id>` | Rejection reason → standing rule |
| `plan-editor lock <file> --selector "…"` | Mark a region do-not-touch |
| `plan-editor companions <file> --with a.md` | Review several artifacts as a set |
| `plan-editor outline <file>` | Sections, ids, word counts, line ranges |
| `plan-editor section <file> --id <id>` | One section's source |
| `plan-editor diff <file>` | What changed by section. `--since <seq>` |
| `plan-editor undo <file>` | Restore the previous version |
| `plan-editor version <file> --seq n --label "…" --pin` | Name a version |
| `plan-editor churn <file>` | Which sections keep being rewritten |
| `plan-editor transcript <file>` | The review record as Markdown |
| `plan-editor export <file>` | Standalone copy |
| `plan-editor commit <file> --message "…"` | Commit just the artifact |
| `plan-editor doctor <file> [--fix]` | Lint / add the missing ids |
| `plan-editor new <file>` | Scaffold a compliant artifact |
| `plan-editor prune [--days 7]` | Drop ended sessions and their snapshots |
| `plan-editor status` | Sessions, bound agents, what is waiting on whom |
| `plan-editor end <file>` | End the session |

Every command prints JSON with a `next_step`. Read it — it is written for you.

---

## Setup, once

```sh
plan-editor setup hooks   # Claude Code: reviews land in the session you are already in
plan-editor setup mcp     # everything else: prints the MCP client config
```

With hooks installed a review reaches you on the human's next message even if
you never call `watch`, and a Stop hook keeps you from finishing with their
review unanswered. `watch` is still worth it while they are actively reviewing —
it is the difference between 40ms and whenever they next type.

Under MCP the same loop is `open_artifact` → `await_review` →
`respond_to_review`, with `ask_human` and `offer_alternatives` alongside, plus
`outline_artifact`, `read_section`, `artifact_diff` and `mark_item_applied`.

---

## When something looks wrong

**Nothing arrives.** They may not have sent yet — markup is private until they
hit Send, and silence is the normal state. `plan-editor status` shows whether a
review is waiting and who is bound.

**The same item keeps coming back.** You applied it but never responded, or the
browser never confirmed it — which it cannot do if the tab is closed or stale.
`plan-editor respond` closes the review; `plan-editor applied <file> --id <id>`
settles a single item you have already done. Do that rather than applying it
twice: a review that keeps returning after the work is finished is a loop, and
the escape hatch is declaring it.

**A note says its anchor is gone.** The element it pointed at no longer exists.
Apply what you can from `anchor_text` and flag it `needs-call` rather than
guessing at a new home for it — the human can re-point it in one click.
