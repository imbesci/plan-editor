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
  const edit = (over: Partial<{ id: string; body: string; text: string; selector: string; deliveredTo: string[] }> = {}) => ({
    id: "e1",
    body: "Change this to Action plan",
    text: "Launch plan",
    selector: "#heading",
    ...over,
  });

  test("returns null when nothing is outstanding", () => {
    assert.equal(buildContextInjection([]), null);
    assert.equal(buildContextInjection([{ file: "/tmp/a.html", ownership: "authoring" as const, agentKey: "A", open: [] }]), null);
  });

  test("includes the full request and its anchor the first time", () => {
    const injection = buildContextInjection([{ file: "/tmp/a.html", ownership: "authoring" as const, agentKey: "A", open: [edit()] }])!;
    assert.match(injection.text, /Change this to Action plan/);
    assert.match(injection.text, /Launch plan/);
    assert.match(injection.text, /#heading/);
    assert.deepEqual(injection.deliver, ["e1"], "the edit is stamped so it is not repeated verbatim");
  });

  test("an already-delivered edit keeps its request text but drops anchor detail", () => {
    // Collapsing these to a bare count saved a few tokens and cost the agent the
    // ability to act at all once the earlier turn's context was gone.
    const injection = buildContextInjection([
      { file: "/tmp/a.html", ownership: "authoring" as const, agentKey: "A", open: [edit({ deliveredTo: ["A"] })] },
    ])!;
    assert.match(injection.text, /Change this to Action plan/, "the agent must always be able to act on an open edit");
    assert.match(injection.text, /still open, listed before/);
    assert.doesNotMatch(injection.text, /#heading/, "anchor detail is what gets dropped on a repeat");
    assert.deepEqual(injection.deliver, [], "nothing new to stamp");
  });

  test("mixes fresh and repeated edits in one injection", () => {
    const injection = buildContextInjection([
      {
        file: "/tmp/a.html",
        ownership: "authoring" as const,
        agentKey: "A",
        open: [edit({ id: "old", deliveredTo: ["A"] }), edit({ id: "new", body: "Add a date" })],
      },
    ])!;
    assert.match(injection.text, /Add a date \(on: /, "the fresh edit carries its anchor");
    assert.match(injection.text, /Change this to Action plan \(still open, listed before\)/);
    assert.deepEqual(injection.deliver, ["new"], "only the unseen edit is stamped");
  });

  test("groups by file across several sessions", () => {
    const injection = buildContextInjection([
      { file: "/tmp/a.html", ownership: "authoring" as const, agentKey: "A", open: [edit({ id: "a" })] },
      { file: "/tmp/b.html", ownership: "authoring" as const, agentKey: "A", open: [edit({ id: "b", body: "Tighten the intro" })] },
    ])!;
    assert.match(injection.text, /\/tmp\/a\.html/);
    assert.match(injection.text, /\/tmp\/b\.html/);
    assert.deepEqual(injection.deliver.sort(), ["a", "b"]);
  });

  test("always tells the agent not to ask for a reload", () => {
    const injection = buildContextInjection([{ file: "/tmp/a.html", ownership: "authoring" as const, agentKey: "A", open: [edit()] }])!;
    assert.match(injection.text, /never tell the user to reload/);
  });
});

describe("ownershipOf — routing edits back to the agent that wrote the plan", () => {
  const AUTHOR = "11111111-1111-1111-1111-111111111111";
  const OTHER = "22222222-2222-2222-2222-222222222222";
  const session = { authoredBy: AUTHOR, authoredIn: "/work/proj" };

  test("the authoring session owns it", () => {
    assert.equal(ownershipOf(session, { sessionId: AUTHOR, cwd: "/work/proj" }), "authoring");
  });

  test("an unrelated session in an unrelated directory hears nothing", () => {
    // This is the bug the global broadcast had: someone working on a different
    // project got the edits and had no idea what they referred to.
    assert.equal(ownershipOf(session, { sessionId: OTHER, cwd: "/work/other" }), "foreign");
  });

  test("a different session in the same project gets it, flagged", () => {
    // The human may have started a fresh session to carry on with the same plan.
    // Dropping their edit silently is worse than handing it over with a caveat.
    assert.equal(ownershipOf(session, { sessionId: OTHER, cwd: "/work/proj" }), "same-project");
  });

  test("a subdirectory of the authoring cwd still counts as the project", () => {
    assert.equal(ownershipOf(session, { sessionId: OTHER, cwd: "/work/proj/src/deep" }), "same-project");
  });

  test("the authoring session still owns it from a subdirectory", () => {
    assert.equal(ownershipOf(session, { sessionId: AUTHOR, cwd: "/work/proj/src" }), "authoring");
  });

  test("a session opened outside Claude Code falls back to directory scope", () => {
    const noAuthor = { authoredIn: "/work/proj" };
    assert.equal(ownershipOf(noAuthor, { sessionId: OTHER, cwd: "/work/proj" }), "authoring");
    assert.equal(ownershipOf(noAuthor, { sessionId: OTHER, cwd: "/elsewhere" }), "foreign");
  });

  test("a session with no provenance at all is surfaced rather than lost", () => {
    assert.equal(ownershipOf({}, { sessionId: OTHER, cwd: "/anywhere" }), "authoring");
  });
});

describe("scoping applied to injection and blocking", () => {
  const edit2 = { id: "x", body: "Tighten this", text: "Some text", selector: "#a" };

  test("foreign sessions are excluded from the injection entirely", () => {
    assert.equal(
      buildContextInjection([{ file: "/tmp/a.html", ownership: "foreign", agentKey: "A", open: [edit2] }]),
      null,
      "an agent with no connection to the plan must not be handed its edits",
    );
  });

  test("same-project injections carry a warning about missing context", () => {
    const injection = buildContextInjection([{ file: "/tmp/a.html", ownership: "same-project", agentKey: "A", open: [edit2] }])!;
    assert.match(injection.text, /different agent session/);
    assert.match(injection.text, /read the file before applying/);
  });

  test("authoring injections carry no such warning", () => {
    const injection = buildContextInjection([{ file: "/tmp/a.html", ownership: "authoring", agentKey: "A", open: [edit2] }])!;
    assert.doesNotMatch(injection.text, /different agent session/);
  });

  test("Stop never blocks a session that does not own the artifact", () => {
    for (const ownership of ["foreign", "same-project"] as const) {
      const decision = decideStop({
        openSessions: [{ file: "/tmp/a.html", key: "k", openEdits: 3, ownership }],
        blocks: {},
        killSwitch: false,
        stopHookActive: false,
      });
      assert.equal(decision.block, false, `${ownership} sessions must be free to finish`);
    }
  });

  test("Stop still blocks the authoring session", () => {
    const decision = decideStop({
      openSessions: [{ file: "/tmp/a.html", key: "k", openEdits: 3, ownership: "authoring" }],
      blocks: {},
      killSwitch: false,
      stopHookActive: false,
    });
    assert.equal(decision.block, true);
  });
});

describe("canonicalDir", () => {
  test("resolves a symlinked directory so both sides of a comparison agree", () => {
    // macOS: /tmp is a symlink to /private/tmp. process.cwd() reports the
    // resolved form while a hook reports the literal one, so without this the
    // same directory compares as two different projects and routing silently
    // drops the edit.
    const viaSymlink = canonicalDir("/tmp");
    const direct = canonicalDir(canonicalDir("/tmp"));
    assert.equal(viaSymlink, direct, "canonicalisation must be idempotent");
    assert.ok(path.isAbsolute(viaSymlink!));
  });

  test("passes through a path that cannot be resolved", () => {
    assert.equal(canonicalDir("/definitely/not/here"), path.resolve("/definitely/not/here"));
  });

  test("undefined stays undefined", () => {
    assert.equal(canonicalDir(undefined), undefined);
  });
});

describe("delivery is tracked per agent session", () => {
  const base = { id: "e1", body: "Rename the heading", text: "Launch plan", selector: "#h" };

  test("a second agent seeing it first does not downgrade the authoring agent", () => {
    // The failure this prevents: with one global delivered stamp, whichever
    // session's hook fired first consumed the full text and every other session —
    // including the one that actually wrote the plan — got a bare count.
    const seenByOther = { ...base, deliveredTo: ["other-session"] };

    const toAuthor = buildContextInjection([
      { file: "/tmp/a.html", ownership: "authoring", agentKey: "author-session", open: [seenByOther] },
    ])!;
    assert.match(toAuthor.text, /Rename the heading/, "the authoring agent still gets the full request");
    assert.deepEqual(toAuthor.deliver, ["e1"]);

    const toOther = buildContextInjection([
      { file: "/tmp/a.html", ownership: "same-project", agentKey: "other-session", open: [seenByOther] },
    ])!;
    assert.match(toOther.text, /Rename the heading \(still open, listed before\)/, "the agent that already saw it still gets the request, without the anchor");
    assert.doesNotMatch(toOther.text, /#h\b/, "but not the anchor detail again");
  });
});
