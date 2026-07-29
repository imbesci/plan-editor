import assert from "node:assert/strict";
import path from "node:path";
import { describe, test } from "node:test";

import {
  buildContextInjection,
  canonicalDir,
  ownershipOf,
  decideStop,
  fileFromToolInput,
  MAX_CONSECUTIVE_BLOCKS,
  mergeHookSettings,
  type InjectionEntry,
} from "../src/hooks.ts";

// openEdits is now "how many reviews are sent and unanswered", not loose notes.
const session = { file: "/tmp/plan.html", key: "abc", openEdits: 1 };

describe("decideStop", () => {
  test("blocks when a sent review has not been responded to", () => {
    const decision = decideStop({ openSessions: [session], blocks: {}, killSwitch: false, stopHookActive: false });
    assert.equal(decision.block, true);
    assert.match(decision.reason!, /plan\.html/);
    assert.match(decision.reason!, /review you have not responded to/);
    assert.match(decision.reason!, /plan-editor respond/, "it must name the command that closes the loop");
  });

  test("allows when nothing is outstanding", () => {
    const decision = decideStop({
      openSessions: [{ ...session, openEdits: 0 }],
      blocks: {},
      killSwitch: false,
      stopHookActive: false,
    });
    assert.equal(decision.block, false);
  });

  test("allows when there are no sessions at all", () => {
    assert.equal(
      decideStop({ openSessions: [], blocks: {}, killSwitch: false, stopHookActive: false }).block,
      false,
    );
  });

  test("never stacks on an already-active stop hook", () => {
    const decision = decideStop({ openSessions: [session], blocks: {}, killSwitch: false, stopHookActive: true });
    assert.equal(decision.block, false, "stacking stop hooks is how agents get trapped in a loop");
  });

  test("the kill switch always wins", () => {
    const decision = decideStop({ openSessions: [session], blocks: {}, killSwitch: true, stopHookActive: false });
    assert.equal(decision.block, false);
  });

  test("stops blocking once the cap is reached", () => {
    // A runaway Stop hook is worse than the bug it fixes: the human cannot get
    // their agent back. The cap is the escape hatch.
    const atCap = decideStop({
      openSessions: [session],
      blocks: { abc: MAX_CONSECUTIVE_BLOCKS },
      killSwitch: false,
      stopHookActive: false,
    });
    assert.equal(atCap.block, false);

    const belowCap = decideStop({
      openSessions: [session],
      blocks: { abc: MAX_CONSECUTIVE_BLOCKS - 1 },
      killSwitch: false,
      stopHookActive: false,
    });
    assert.equal(belowCap.block, true);
  });

  test("one exhausted session does not mute another", () => {
    const decision = decideStop({
      openSessions: [session, { file: "/tmp/other.html", key: "xyz", openEdits: 1 }],
      blocks: { abc: MAX_CONSECUTIVE_BLOCKS },
      killSwitch: false,
      stopHookActive: false,
    });
    assert.equal(decision.block, true);
    assert.match(decision.reason!, /other\.html/);
    assert.doesNotMatch(decision.reason!, /tmp\/plan\.html/);
  });
});

describe("fileFromToolInput", () => {
  test("extracts an HTML file path", () => {
    assert.equal(
      fileFromToolInput(JSON.stringify({ tool_input: { file_path: "/tmp/a.html" } })),
      "/tmp/a.html",
    );
  });

  test("ignores non-HTML edits", () => {
    assert.equal(fileFromToolInput(JSON.stringify({ tool_input: { file_path: "/tmp/a.ts" } })), null);
  });

  test("survives malformed input without throwing", () => {
    assert.equal(fileFromToolInput("not json"), null);
    assert.equal(fileFromToolInput(""), null);
    assert.equal(fileFromToolInput("{}"), null);
  });
});

describe("mergeHookSettings", () => {
  test("preserves unrelated user hooks and settings", () => {
    const existing = {
      model: "opus",
      hooks: {
        PostToolUse: [{ matcher: "Bash", hooks: [{ type: "command", command: "my-linter" }] }],
        SessionStart: [{ hooks: [{ type: "command", command: "something-else" }] }],
      },
    };
    const merged = mergeHookSettings(existing, "plan-editor") as {
      model: string;
      hooks: Record<string, unknown[]>;
    };

    assert.equal(merged.model, "opus", "unrelated settings must be untouched");
    assert.equal(merged.hooks.PostToolUse!.length, 2, "the user's own PostToolUse hook must survive");
    assert.match(JSON.stringify(merged.hooks.PostToolUse), /my-linter/);
    // We install our own SessionStart entry, so this event grows — but the
    // user's existing one must still be there next to ours.
    assert.equal(merged.hooks.SessionStart!.length, 2);
    assert.match(JSON.stringify(merged.hooks.SessionStart), /something-else/);
    assert.match(JSON.stringify(merged.hooks.SessionStart), /plan-editor hook session-start/);
    assert.match(JSON.stringify(merged.hooks.Stop), /plan-editor hook stop/);
    assert.match(JSON.stringify(merged.hooks.UserPromptSubmit), /plan-editor hook user-prompt-submit/);
  });

  test("is idempotent — reinstalling does not duplicate entries", () => {
    const once = mergeHookSettings({}, "plan-editor");
    const twice = mergeHookSettings(once, "plan-editor") as { hooks: Record<string, unknown[]> };
    for (const event of ["PostToolUse", "Stop", "UserPromptSubmit", "SessionStart"]) {
      assert.equal(twice.hooks[event]!.length, 1, `${event} must not duplicate on reinstall`);
    }
  });

  test("works from empty settings", () => {
    const merged = mergeHookSettings({}, "plan-editor") as { hooks: Record<string, unknown[]> };
    assert.ok(merged.hooks.Stop);
    assert.ok(merged.hooks.PostToolUse);
  });
});

describe("buildContextInjection", () => {
  const item = (body: string) => ({ id: `i-${body}`, body, text: "Launch plan", selector: "#heading" });
  type InjectedItem = InjectionEntry["review"] extends { items: infer I } | null
    ? I extends Array<infer E>
      ? E
      : never
    : never;
  const entry = (over: Partial<{ note: string; deliveredTo: string[]; items: InjectedItem[] }> = {}) => ({
    file: "/tmp/a.html",
    ownership: "authoring" as const,
    agentKey: "A",
    review: { id: "r1", note: "cut this by a third", items: [item("Rename the heading")], ...over },
  });

  test("standing rules lead even the overall note", () => {
    const injection = buildContextInjection([
      { ...entry(), contract: [{ text: "Never use the word 'leverage'." }] },
    ]);
    const lines = injection!.text.split("\n");
    const rule = lines.findIndex((line) => line.includes("Always: Never use"));
    const note = lines.findIndex((line) => line.includes("Overall:"));
    assert.ok(rule !== -1 && rule < note, injection!.text);
  });

  test("standing rules repeat on a delivery the items are compacted out of", () => {
    // The exact inverse of the item rule, and deliberate: a rule stated once and
    // never again is one the agent breaks three turns later, and unlike an item
    // it is not visible in the file it is looking at.
    const injection = buildContextInjection([
      { ...entry({ deliveredTo: ["A"] }), contract: [{ text: "Keep sections under 200 words." }] },
    ]);
    assert.match(injection!.text, /Always: Keep sections under 200 words\./);
    assert.match(injection!.text, /1 item, listed before and still open/);
    assert.doesNotMatch(injection!.text, /Rename the heading/);
  });

  test("locked regions are named as do-not-touch", () => {
    const injection = buildContextInjection([
      { ...entry(), locks: [{ selector: "#budget", text: "40 units", label: "Budget" }] },
    ]);
    assert.match(injection!.text, /Do not touch: Budget/);
  });

  test("a verbatim item is injected as its replacement text, not as prose", () => {
    // Summarising it back into prose reintroduces exactly the ambiguity the
    // human removed by typing the words themselves.
    const injection = buildContextInjection([
      {
        ...entry({
          items: [
            {
              id: "v1",
              body: "Replace with the supplied text.",
              text: "We should leverage the queue.",
              selector: "#p1",
              tag: "verbatim",
              replacement: "We should reuse the queue.",
            },
          ],
        }),
      },
    ]);
    assert.match(injection!.text, /Replace "We should leverage the queue\." with exactly: We should reuse the queue\./);
  });

  test("a structural item is injected as its operation", () => {
    const injection = buildContextInjection([
      {
        ...entry({
          items: [
            {
              id: "s1",
              body: "move it",
              text: "Risks",
              selector: "#risks",
              tag: "structural",
              op: { kind: "move-before", targetText: "Milestones" },
            },
          ],
        }),
      },
    ]);
    assert.match(injection!.text, /move-before.*Milestones/);
  });

  test("it tells the agent to ask rather than guess", () => {
    const injection = buildContextInjection([entry()]);
    assert.match(injection!.text, /plan-editor ask/);
  });

  test("returns null when no review is pending", () => {
    assert.equal(buildContextInjection([]), null);
    assert.equal(
      buildContextInjection([{ file: "/tmp/a.html", ownership: "authoring", agentKey: "A", review: null }]),
      null,
    );
  });

  test("the overall note leads, before any item", () => {
    // It is the context that makes the items interpretable — "cut this by a
    // third" changes what every item under it means.
    const injection = buildContextInjection([entry()])!;
    const lines = injection.text.split("\n");
    const noteLine = lines.findIndex((line) => line.includes("cut this by a third"));
    const itemLine = lines.findIndex((line) => line.includes("Rename the heading"));
    assert.ok(noteLine > -1 && itemLine > -1);
    assert.ok(noteLine < itemLine, "the overall note must come first");
  });

  test("every item in the review is listed together", () => {
    const injection = buildContextInjection([
      entry({ items: [item("one"), item("two"), item("three")] }),
    ])!;
    for (const body of ["one", "two", "three"]) assert.match(injection.text, new RegExp(body));
    assert.deepEqual(injection.deliver, ["r1"]);
  });

  test("a repeat injection keeps the overall note but compacts the items", () => {
    const injection = buildContextInjection([entry({ deliveredTo: ["A"] })])!;
    assert.match(injection.text, /cut this by a third/, "the framing is never dropped");
    assert.doesNotMatch(injection.text, /Rename the heading/);
    assert.match(injection.text, /listed before and still open/);
    assert.deepEqual(injection.deliver, []);
  });

  test("a foreign session is never told about the review", () => {
    assert.equal(
      buildContextInjection([{ ...entry(), ownership: "foreign" }]),
      null,
      "an agent with no connection to the plan must not be handed its review",
    );
  });

  test("a same-project session is warned it may lack the context", () => {
    const injection = buildContextInjection([{ ...entry(), ownership: "same-project" }])!;
    assert.match(injection.text, /different agent session/);
  });

  test("it always tells the agent to respond rather than go quiet", () => {
    const injection = buildContextInjection([entry()])!;
    assert.match(injection.text, /plan-editor respond/);
    assert.match(injection.text, /never tell the user to reload/);
  });

  test("it tells the agent to read the whole set before changing anything", () => {
    // The failure this prevents: applying items one at a time, blind to how
    // they interact, which is what the live model did.
    const injection = buildContextInjection([entry()])!;
    assert.match(injection.text, /before changing anything/);
  });
});
