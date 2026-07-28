import assert from "node:assert/strict";
import { describe, test } from "node:test";

import {
  buildContextInjection,
  decideStop,
  fileFromToolInput,
  MAX_CONSECUTIVE_BLOCKS,
  mergeHookSettings,
} from "../src/hooks.ts";

const session = { file: "/tmp/plan.html", key: "abc", openEdits: 2 };

describe("decideStop", () => {
  test("blocks when the human has unaddressed edits", () => {
    const decision = decideStop({ openSessions: [session], blocks: {}, killSwitch: false, stopHookActive: false });
    assert.equal(decision.block, true);
    assert.match(decision.reason!, /plan\.html/);
    assert.match(decision.reason!, /2 unaddressed edits/);
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
  const edit = (over: Partial<{ id: string; body: string; text: string; selector: string; deliveredAt: string }> = {}) => ({
    id: "e1",
    body: "Change this to Action plan",
    text: "Launch plan",
    selector: "#heading",
    ...over,
  });

  test("returns null when nothing is outstanding", () => {
    assert.equal(buildContextInjection([]), null);
    assert.equal(buildContextInjection([{ file: "/tmp/a.html", open: [] }]), null);
  });

  test("includes the full request and its anchor the first time", () => {
    const injection = buildContextInjection([{ file: "/tmp/a.html", open: [edit()] }])!;
    assert.match(injection.text, /Change this to Action plan/);
    assert.match(injection.text, /Launch plan/);
    assert.match(injection.text, /#heading/);
    assert.deepEqual(injection.deliver, ["e1"], "the edit is stamped so it is not repeated verbatim");
  });

  test("compacts already-delivered edits instead of repeating them", () => {
    const injection = buildContextInjection([
      { file: "/tmp/a.html", open: [edit({ deliveredAt: "2026-01-01T00:00:00Z" })] },
    ])!;
    assert.doesNotMatch(injection.text, /Change this to Action plan/, "full text must not repeat every prompt");
    assert.match(injection.text, /1 previously listed edit still unapplied/);
    assert.deepEqual(injection.deliver, [], "nothing new to stamp");
  });

  test("mixes fresh and repeated edits in one injection", () => {
    const injection = buildContextInjection([
      {
        file: "/tmp/a.html",
        open: [edit({ id: "old", deliveredAt: "2026-01-01T00:00:00Z" }), edit({ id: "new", body: "Add a date" })],
      },
    ])!;
    assert.match(injection.text, /Add a date/);
    assert.match(injection.text, /1 previously listed edit/);
    assert.deepEqual(injection.deliver, ["new"]);
  });

  test("groups by file across several sessions", () => {
    const injection = buildContextInjection([
      { file: "/tmp/a.html", open: [edit({ id: "a" })] },
      { file: "/tmp/b.html", open: [edit({ id: "b", body: "Tighten the intro" })] },
    ])!;
    assert.match(injection.text, /\/tmp\/a\.html/);
    assert.match(injection.text, /\/tmp\/b\.html/);
    assert.deepEqual(injection.deliver.sort(), ["a", "b"]);
  });

  test("always tells the agent not to ask for a reload", () => {
    const injection = buildContextInjection([{ file: "/tmp/a.html", open: [edit()] }])!;
    assert.match(injection.text, /never tell the user to reload/);
  });
});
