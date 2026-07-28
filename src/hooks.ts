// Claude Code hook handlers.
//
// The blocking poll is the fragile part of every tool in this shape: the loop
// only continues because the agent chooses to re-enter it, and a compaction or a
// stray "here's what I did" reply drops it silently. A Stop hook turns that from
// a hope into an invariant.
//
// A runaway Stop hook is far worse than the bug it fixes, so this one is bounded
// three ways: a per-session block counter, a hard cap, and an env kill switch.

import { readFile } from "node:fs/promises";
import path from "node:path";

import { stateDir } from "./paths.ts";
import { queued, writeFileAtomically } from "./store/atomic.ts";
import { SessionStore } from "./store/session-store.ts";

export const MAX_CONSECUTIVE_BLOCKS = 2;

interface StopHookInput {
  stop_hook_active?: boolean;
}

interface GuardState {
  blocks: Record<string, number>;
}

function guardFile(): string {
  return path.join(stateDir(), "stop-guard.json");
}

async function readGuard(): Promise<GuardState> {
  try {
    return JSON.parse(await readFile(guardFile(), "utf8")) as GuardState;
  } catch {
    return { blocks: {} };
  }
}

async function updateGuard(key: string, next: (current: number) => number): Promise<number> {
  return queued("stop-guard", async () => {
    const state = await readGuard();
    const value = next(state.blocks[key] ?? 0);
    if (value <= 0) delete state.blocks[key];
    else state.blocks[key] = value;
    await writeFileAtomically(guardFile(), `${JSON.stringify(state, null, 2)}\n`);
    return value;
  });
}

export interface StopDecision {
  block: boolean;
  reason?: string;
}

/**
 * Decides whether the agent should be held back. Pure-ish so the policy is
 * testable without a live session.
 */
export function decideStop(input: {
  openSessions: Array<{ file: string; openEdits: number; key: string }>;
  blocks: Record<string, number>;
  killSwitch: boolean;
  stopHookActive: boolean;
}): StopDecision {
  if (input.killSwitch) return { block: false };
  // Claude Code sets this when the agent is already continuing because of a stop
  // hook. Never stack on top of that.
  if (input.stopHookActive) return { block: false };

  const pending = input.openSessions.filter((session) => session.openEdits > 0);
  if (pending.length === 0) return { block: false };

  const blockable = pending.filter((session) => (input.blocks[session.key] ?? 0) < MAX_CONSECUTIVE_BLOCKS);
  if (blockable.length === 0) return { block: false };

  const summary = blockable
    .map((session) => `${session.file} (${session.openEdits} unaddressed edit${session.openEdits === 1 ? "" : "s"})`)
    .join(", ");
  return {
    block: true,
    reason:
      `The human has submitted edits you have not applied yet: ${summary}. ` +
      `Apply them by editing the file, then run \`plan-editor poll <file> --reply "<what you changed>"\`. ` +
      `If you believe the edits are already handled, run \`plan-editor status\` to confirm before finishing.`,
  };
}

export async function runStopHook(rawInput: string): Promise<{ output: string; exitCode: number }> {
  let parsed: StopHookInput = {};
  try {
    parsed = JSON.parse(rawInput || "{}") as StopHookInput;
  } catch {
    // A malformed payload must never wedge the agent.
    return { output: "", exitCode: 0 };
  }

  const store = new SessionStore(stateDir());
  const sessions = await store.list();
  const openSessions = sessions
    .filter((session) => session.status === "open")
    .map((session) => ({
      key: session.key,
      file: session.file,
      openEdits: session.annotations.filter((entry) => entry.status === "submitted").length,
    }));

  const guard = await readGuard();
  const decision = decideStop({
    openSessions,
    blocks: guard.blocks,
    killSwitch: process.env.PLAN_EDITOR_NO_STOP_HOOK === "1",
    stopHookActive: Boolean(parsed.stop_hook_active),
  });

  if (!decision.block) {
    // Finishing cleanly resets the counters, so the next genuine round of edits
    // gets a fresh budget instead of inheriting an exhausted one.
    for (const session of openSessions) {
      if (session.openEdits === 0) await updateGuard(session.key, () => 0);
    }
    return { output: "", exitCode: 0 };
  }

  for (const session of openSessions.filter((entry) => entry.openEdits > 0)) {
    await updateGuard(session.key, (current) => current + 1);
  }
  return { output: JSON.stringify({ decision: "block", reason: decision.reason }), exitCode: 0 };
}

// ---------------------------------------------------------------------------
// UserPromptSubmit — the reason this tool does not need a second agent.
//
// A blocking `poll` does reach the session that runs it, but it requires the
// agent to volunteer a blocking call, and running it in a fresh terminal gives
// you an agent with no context. Injecting on UserPromptSubmit puts the edits
// into the session you are already talking to: submit in the browser, say
// anything, and they are simply there.
// ---------------------------------------------------------------------------

export interface InjectionEntry {
  file: string;
  open: Array<{ id: string; body: string; text: string; selector: string; deliveredAt?: string }>;
}

export interface Injection {
  text: string;
  /** Ids to stamp as delivered, so their full text is not repeated every prompt. */
  deliver: string[];
}

export function buildContextInjection(entries: InjectionEntry[]): Injection | null {
  const withOpen = entries.filter((entry) => entry.open.length > 0);
  if (withOpen.length === 0) return null;

  const lines: string[] = [];
  const deliver: string[] = [];

  for (const entry of withOpen) {
    const fresh = entry.open.filter((annotation) => !annotation.deliveredAt);
    const repeated = entry.open.filter((annotation) => annotation.deliveredAt);

    lines.push(`Open edits on ${entry.file}:`);
    for (const annotation of fresh) {
      const anchor = annotation.text
        ? ` (on: "${annotation.text.slice(0, 80)}"${annotation.selector ? ` — ${annotation.selector}` : ""})`
        : "";
      lines.push(`  • ${annotation.body}${anchor}`);
      deliver.push(annotation.id);
    }
    // Already shown once. Repeating the full text every prompt burns context and
    // reads as nagging, but the agent still needs to know they are outstanding.
    if (repeated.length > 0) {
      lines.push(`  • (${repeated.length} previously listed edit${repeated.length === 1 ? "" : "s"} still unapplied)`);
    }
  }

  lines.push(
    "",
    "Apply these by editing the file directly — the open browser patches itself in place, so never tell the user to reload.",
    "Each edit is marked applied automatically once your change touches the element it was anchored to.",
  );

  return { text: lines.join("\n"), deliver };
}

export async function runContextHook(event: "UserPromptSubmit" | "SessionStart"): Promise<string> {
  const store = new SessionStore(stateDir());
  const sessions = (await store.list()).filter((session) => session.status === "open");

  const entries: InjectionEntry[] = sessions.map((session) => ({
    file: session.file,
    open: session.annotations
      .filter((annotation) => annotation.status === "submitted")
      .map((annotation) => ({
        id: annotation.id,
        body: annotation.body,
        text: annotation.text,
        selector: annotation.selector,
        deliveredAt: annotation.deliveredAt,
      })),
  }));

  const injection = buildContextInjection(entries);
  if (!injection) return "";

  for (const session of sessions) {
    const ids = injection.deliver.filter((id) => session.annotations.some((entry) => entry.id === id));
    if (ids.length > 0) await store.markDelivered(session.key, ids);
  }

  return JSON.stringify({
    hookSpecificOutput: { hookEventName: event, additionalContext: injection.text },
  });
}

/** PostToolUse: tells the browser the agent is working before the write lands. */
export function fileFromToolInput(rawInput: string): string | null {
  try {
    const parsed = JSON.parse(rawInput || "{}") as { tool_input?: { file_path?: string } };
    const file = parsed.tool_input?.file_path;
    if (!file) return null;
    return [".html", ".htm"].includes(path.extname(file).toLowerCase()) ? file : null;
  } catch {
    return null;
  }
}

/** Merges plan-editor hooks into settings without disturbing existing entries. */
export function mergeHookSettings(existing: Record<string, unknown>, command: string): Record<string, unknown> {
  const settings = { ...existing };
  const hooks = { ...((settings.hooks as Record<string, unknown>) ?? {}) };

  const entries: Array<[string, Record<string, unknown>]> = [
    [
      "PostToolUse",
      {
        matcher: "Edit|Write|MultiEdit",
        hooks: [{ type: "command", command: `${command} hook post-tool-use`, timeout: 5 }],
      },
    ],
    // The one that removes the need for a second agent: pending edits land in
    // whatever session the human is already talking to.
    ["UserPromptSubmit", { hooks: [{ type: "command", command: `${command} hook user-prompt-submit`, timeout: 10 }] }],
    // Re-injects after a compaction or resume, which is where the loop is
    // otherwise silently lost.
    [
      "SessionStart",
      { matcher: "compact|resume", hooks: [{ type: "command", command: `${command} hook session-start`, timeout: 10 }] },
    ],
    ["Stop", { hooks: [{ type: "command", command: `${command} hook stop`, timeout: 10 }] }],
  ];

  for (const [event, entry] of entries) {
    const list = Array.isArray(hooks[event]) ? [...(hooks[event] as unknown[])] : [];
    const withoutOurs = list.filter((item) => !JSON.stringify(item).includes("plan-editor hook"));
    hooks[event] = [...withoutOurs, entry];
  }

  settings.hooks = hooks;
  return settings;
}
