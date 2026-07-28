import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { decideStop, fileFromToolInput, MAX_CONSECUTIVE_BLOCKS, mergeHookSettings } from "../src/hooks.ts";

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
    assert.equal(merged.hooks.SessionStart!.length, 1, "unrelated events must be untouched");
    assert.equal(merged.hooks.PostToolUse!.length, 2, "the user's own PostToolUse hook must survive");
    assert.match(JSON.stringify(merged.hooks.PostToolUse), /my-linter/);
    assert.match(JSON.stringify(merged.hooks.Stop), /plan-editor hook stop/);
  });

  test("is idempotent — reinstalling does not duplicate entries", () => {
    const once = mergeHookSettings({}, "plan-editor");
    const twice = mergeHookSettings(once, "plan-editor") as { hooks: Record<string, unknown[]> };
    assert.equal(twice.hooks.PostToolUse!.length, 1);
    assert.equal(twice.hooks.Stop!.length, 1);
  });

  test("works from empty settings", () => {
    const merged = mergeHookSettings({}, "plan-editor") as { hooks: Record<string, unknown[]> };
    assert.ok(merged.hooks.Stop);
    assert.ok(merged.hooks.PostToolUse);
  });
});
