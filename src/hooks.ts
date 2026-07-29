// Claude Code hook handlers.
//
// The blocking poll is the fragile part of every tool in this shape: the loop
// only continues because the agent chooses to re-enter it, and a compaction or a
// stray "here's what I did" reply drops it silently. A Stop hook turns that from
// a hope into an invariant.
//
// A runaway Stop hook is far worse than the bug it fixes, so this one is bounded
// three ways: a per-session block counter, a hard cap, and an env kill switch.

import { realpathSync } from "node:fs";
import { readFile } from "node:fs/promises";
import path from "node:path";

import { stateDir } from "./paths.ts";
import { queued, writeFileAtomically } from "./store/atomic.ts";
import { SessionStore } from "./store/session-store.ts";

export const MAX_CONSECUTIVE_BLOCKS = 2;

interface StopHookInput {
  stop_hook_active?: boolean;
  session_id?: string;
  cwd?: string;
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
  openSessions: Array<{ file: string; openEdits: number; key: string; ownership?: Ownership }>;
  blocks: Record<string, number>;
  killSwitch: boolean;
  stopHookActive: boolean;
}): StopDecision {
  if (input.killSwitch) return { block: false };
  // Claude Code sets this when the agent is already continuing because of a stop
  // hook. Never stack on top of that.
  if (input.stopHookActive) return { block: false };

  // Only the agent that owns the artifact gets held back. Blocking an unrelated
  // session because some other project has open edits is intolerable.
  const pending = input.openSessions.filter(
    (session) => session.openEdits > 0 && (session.ownership ?? "authoring") === "authoring",
  );
  if (pending.length === 0) return { block: false };

  const blockable = pending.filter((session) => (input.blocks[session.key] ?? 0) < MAX_CONSECUTIVE_BLOCKS);
  if (blockable.length === 0) return { block: false };

  const summary = blockable
    .map((session) => `${session.file}`)
    .join(", ");
  return {
    block: true,
    reason:
      `The human sent you a review you have not responded to: ${summary}. ` +
      `Apply it, then run \`plan-editor respond <file> --summary "<what you changed and why>"\` — that is what puts your ` +
      `work in front of them. If you believe it is already handled, run \`plan-editor status\` to confirm before finishing.`,
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

  const agent: AgentIdentity = { sessionId: parsed.session_id, cwd: canonicalDir(parsed.cwd) };
  const store = new SessionStore(stateDir());
  const sessions = await store.list();
  const openSessions = sessions
    .filter((session) => session.status === "open")
    .map((session) => ({
      key: session.key,
      file: session.file,
      ownership: ownershipOf(session, agent),
      openEdits: session.reviews.filter((review) => review.status === "sent").length,
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

export interface AgentIdentity {
  /** The Claude Code session this hook fired in. */
  sessionId?: string;
  cwd?: string;
}

export type Ownership = "authoring" | "same-project" | "foreign";

function isWithin(parent: string, child: string): boolean {
  const relative = path.relative(parent, child);
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

/**
 * Directory comparison must go through realpath on both sides. `process.cwd()`
 * already returns a resolved path, but a hook reports whatever the agent's cwd
 * string is — and on macOS /tmp is a symlink to /private/tmp, so the two
 * disagree for the exact same directory and routing silently fails.
 */
export function canonicalDir(dir: string | undefined): string | undefined {
  if (!dir) return undefined;
  try {
    return realpathSync(dir);
  } catch {
    return path.resolve(dir);
  }
}

/**
 * Decides whether a given agent session should hear about an artifact's edits.
 *
 * This is the whole point of the tool: an inline edit is only worth much to the
 * agent that produced the plan, because that agent holds the conversation the
 * plan came out of. Broadcasting to every open session both spams unrelated work
 * and hands the edit to an agent with no idea why the plan says what it says.
 */
export function ownershipOf(
  session: { authoredBy?: string; authoredIn?: string },
  agent: AgentIdentity,
): Ownership {
  if (session.authoredBy && agent.sessionId) {
    if (session.authoredBy === agent.sessionId) return "authoring";
    // Claimed by a different agent session. Fall through to the directory check
    // rather than returning "foreign" outright: the human may have started a
    // fresh session to carry on with the same plan, and silently dropping their
    // edit is worse than handing it over with a caveat.
  }
  if (session.authoredIn && agent.cwd && (isWithin(session.authoredIn, agent.cwd) || isWithin(agent.cwd, session.authoredIn))) {
    return session.authoredBy && session.authoredBy !== agent.sessionId ? "same-project" : "authoring";
  }
  // No provenance recorded at all (opened before this existed, or outside a
  // Claude session): surfacing beats losing the edit.
  if (!session.authoredBy && !session.authoredIn) return "authoring";
  return "foreign";
}

export interface InjectionEntry {
  file: string;
  ownership: Ownership;
  /** The pending review, if the human has sent one. */
  review: {
    id: string;
    note: string;
    items: Array<{ id: string; body: string; text: string; selector: string }>;
    deliveredTo?: string[];
  } | null;
  /** Identifies the agent asking, so delivery is tracked per session. */
  agentKey: string;
}

export interface Injection {
  text: string;
  /** Review ids to stamp as delivered, so the full text is not repeated. */
  deliver: string[];
}

/**
 * Describes a *review*, leading with its overall note.
 *
 * The note is what makes the individual items interpretable — "cut this by a
 * third" changes the meaning of every item under it — so it goes first and is
 * never dropped, even on a repeat injection.
 */
export function buildContextInjection(entries: InjectionEntry[]): Injection | null {
  const pending = entries.filter((entry) => entry.review && entry.ownership !== "foreign");
  if (pending.length === 0) return null;

  const lines: string[] = [];
  const deliver: string[] = [];

  for (const entry of pending) {
    const review = entry.review!;
    const seen = (review.deliveredTo ?? []).includes(entry.agentKey);
    lines.push(
      entry.ownership === "same-project"
        ? `A review is waiting on ${entry.file} (sent from a different agent session — read the file first, you may not have the context behind it):`
        : `A review is waiting on ${entry.file}:`,
    );
    if (review.note) lines.push(`  Overall: ${review.note}`);

    if (seen) {
      lines.push(`  (${review.items.length} item${review.items.length === 1 ? "" : "s"}, listed before and still open)`);
    } else {
      for (const item of review.items) {
        const anchor = item.text ? ` (on: "${item.text.slice(0, 80)}")` : " (whole page)";
        lines.push(`  • ${item.body}${anchor}`);
      }
      deliver.push(review.id);
    }
  }

  lines.push(
    "",
    "Read the overall note and every item before changing anything — they were written as one pass and can pull against each other.",
    "Apply them by editing the file directly; the open browser patches itself in place, so never tell the user to reload.",
    "When you are done, run `plan-editor respond <file> --summary \"<what you changed and why>\"` to put your work in front of them.",
  );

  return { text: lines.join("\n"), deliver };
}

export async function runContextHook(
  event: "UserPromptSubmit" | "SessionStart",
  rawAgent: AgentIdentity,
): Promise<string> {
  const agent: AgentIdentity = { sessionId: rawAgent.sessionId, cwd: canonicalDir(rawAgent.cwd) };
  const store = new SessionStore(stateDir());
  const sessions = (await store.list()).filter((session) => session.status === "open");

  const agentKey = agent.sessionId ?? `cwd:${agent.cwd ?? "unknown"}`;
  const entries: InjectionEntry[] = sessions.map((session) => {
    const review = session.reviews.find((entry) => entry.status === "sent");
    return {
      file: session.file,
      ownership: ownershipOf(session, agent),
      agentKey,
      review: review
        ? {
            id: review.id,
            note: review.note,
            deliveredTo: review.deliveredTo,
            items: review.items.map((item) => ({
              id: item.id,
              body: item.body,
              text: item.text,
              selector: item.selector,
            })),
          }
        : null,
    };
  });

  const injection = buildContextInjection(entries);
  if (!injection) return "";

  for (const session of sessions) {
    if (ownershipOf(session, agent) === "foreign") continue;
    for (const id of injection.deliver) {
      if (session.reviews.some((review) => review.id === id)) await store.markDelivered(session.key, id, agentKey);
    }
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
    [
      "UserPromptSubmit",
      {
        hooks: [
          { type: "command", command: `${command} hook user-prompt-submit`, timeout: 10 },
          // Separate entry so the browser learns an agent is alive even on turns
          // with no outstanding edits to inject.
          { type: "command", command: `${command} notify-contact`, timeout: 5 },
        ],
      },
    ],
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
