import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";

import { defaultPort, LOOPBACK, serverLogFile, stateDir } from "./paths.ts";
import type { Annotation, PollResult } from "./protocol.ts";
import { canonicalFile, SessionStore, sessionKey } from "./store/session-store.ts";

const PACKAGE_VERSION = process.env.PLAN_EDITOR_BUILD_VERSION ?? "0.1.0";

/**
 * The detached server only restarts when the CLI's version differs from the
 * running one. Keying that on package.json alone means every edit to src/ is
 * silently ignored until someone bumps a version by hand — the failure is a
 * server quietly running stale code, which looks like the new code not working.
 * Folding the newest source/bundle mtime into the identity makes any change
 * restart it.
 */
async function codeSignature(): Promise<string> {
  const roots = [fileURLToPath(new URL("./", import.meta.url)), fileURLToPath(new URL("../dist/", import.meta.url))];
  let newest = 0;
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = await readdir(root, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const info = await stat(path.join(root, entry)).catch(() => null);
      if (info?.isFile()) newest = Math.max(newest, info.mtimeMs);
    }
  }
  return `${PACKAGE_VERSION}+${Math.round(newest)}`;
}

let VERSION = PACKAGE_VERSION;

class CliError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
  }
}

function baseUrl(): string {
  return `http://${LOOPBACK}:${defaultPort()}`;
}

async function health(): Promise<{ app?: string; version?: string } | null> {
  try {
    const response = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(600) });
    if (!response.ok) return null;
    return (await response.json()) as { app?: string; version?: string };
  } catch {
    return null;
  }
}

async function ensureServer(): Promise<void> {
  VERSION = await codeSignature();
  const existing = await health();
  if (existing?.app === "plan-editor" && existing.version === VERSION) return;
  if (existing?.app === "plan-editor") {
    await fetch(`${baseUrl()}/shutdown`, { method: "POST" }).catch(() => {});
    await delay(200);
  } else if (existing) {
    throw new CliError(`Port ${defaultPort()} is occupied by another server`, [
      "Set PLAN_EDITOR_PORT to a free port.",
    ]);
  }

  await mkdir(stateDir(), { recursive: true });
  const logFd = openSync(serverLogFile(), "a");
  // process.execPath is the bun binary; re-invoking this same source file keeps
  // the detached server on exactly the runtime that spawned it.
  const child = spawn(process.execPath, [fileURLToPath(import.meta.url), "server"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100);
    const probe = await health();
    if (probe?.app === "plan-editor" && probe.version === VERSION) return;
  }
  throw new CliError("plan-editor server did not start", [`Check ${serverLogFile()} for details.`]);
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The session token is the credential for every route. The CLI reads it from the
 * session file, which it can only do because it already has filesystem access to
 * the state directory — the same trust level as reading the artifact itself.
 */
async function tokenFor(canonical: string): Promise<{ key: string; token: string }> {
  const store = new SessionStore(stateDir());
  const key = sessionKey(canonical);
  const session = await store.read(key);
  if (!session) {
    throw new CliError(`No plan-editor session for ${canonical}`, [`Run \`plan-editor ${canonical}\` first.`]);
  }
  return { key, token: session.token };
}

// --- commands ---------------------------------------------------------------

async function openCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An HTML file path is required", ["Run `plan-editor <file.html>`"]);
  const canonical = await canonicalFile(file);
  await ensureServer();

  const response = await fetch(`${baseUrl()}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    // Captures which Claude Code session is opening this, so the edits the human
    // makes come back to the agent that actually wrote the plan.
    body: JSON.stringify({
      file: canonical,
      authoredBy: process.env.CLAUDE_CODE_SESSION_ID,
      authoredIn: process.cwd(),
    }),
  });
  if (!response.ok) {
    const detail = (await response.json().catch(() => ({}))) as { error?: string };
    throw new CliError(detail.error ?? `Could not open session (${response.status})`);
  }
  const session = (await response.json()) as { key: string; url: string; token: string };

  if (!args.includes("--no-open")) await open(session.url);

  return {
    session: { file: canonical, url: session.url },
    next_step:
      `The artifact is open. Now run \`plan-editor poll ${canonical}\`. It long-polls until the human submits an edit ` +
      `and stays silent while waiting — that is normal, never kill it. When edits arrive, apply them by editing ${canonical} ` +
      `normally; plan-editor patches the open browser in place, so do not tell the user to reload.`,
  };
}

async function pollCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An HTML file path is required", ["Run `plan-editor poll <file.html>`"]);
  const canonical = await canonicalFile(file);
  await ensureServer();
  const { token } = await tokenFor(canonical);

  const replyIndex = args.indexOf("--reply");
  if (replyIndex !== -1 && args[replyIndex + 1]) {
    const { key } = await tokenFor(canonical);
    await fetch(`${baseUrl()}/api/${key}/agent-reply?t=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: args[replyIndex + 1] }),
    });
  }

  const timeoutIndex = args.indexOf("--timeout-ms");
  const timeout = timeoutIndex !== -1 ? `&timeoutMs=${encodeURIComponent(String(args[timeoutIndex + 1]))}` : "";

  if (!timeout) {
    process.stderr.write(
      `[plan-editor] Waiting for edits on ${canonical}. This stays silent until the human submits — leave it running. ` +
        `If it is interrupted, re-run the same command; submitted edits are never lost.\n`,
    );
  }

  const url = `${baseUrl()}/api/poll?file=${encodeURIComponent(canonical)}&t=${encodeURIComponent(token)}${timeout}`;
  const response = await fetch(url);
  const result = (await response.json()) as PollResult;
  return formatPollResult(canonical, result);
}

/** Absolute path of a command on PATH, or null. */
async function which(name: string): Promise<string | null> {
  const { access } = await import("node:fs/promises");
  for (const dir of (process.env.PATH ?? "").split(":")) {
    if (!dir) continue;
    const candidate = path.join(dir, name);
    try {
      await access(candidate);
      return candidate;
    } catch {
      // keep looking
    }
  }
  return null;
}

export function formatPollResult(file: string, result: PollResult): unknown {
  if (result.status === "waiting") {
    return {
      status: "waiting",
      next_step: `No edits arrived before the timeout. Run \`plan-editor poll ${file}\` without --timeout-ms to wait indefinitely.`,
    };
  }
  if (result.status === "ended") {
    return {
      status: "ended",
      ended_by: result.endedBy,
      next_step: "The human ended this session. Stop polling and report back in the conversation.",
    };
  }
  return {
    status: "feedback",
    edits: result.annotations.map((entry: Annotation) => ({
      id: entry.id,
      request: entry.body,
      anchor_text: entry.text,
      selector_hint: entry.selector,
    })),
    next_step:
      `Apply each edit by editing ${file} directly. The open browser patches itself in place — never ask the user to reload. ` +
      `Give top-level sections stable \`id\` attributes so edits can be matched precisely. ` +
      `The open browser marks each edit applied automatically once your change touches its anchor. If the same edit comes back ` +
      `on the next cycle, the browser could not confirm it — run \`plan-editor applied ${file} --id <id>\` so it stops repeating. ` +
      `Then run \`plan-editor watch ${file}\` so the next edit reaches you in milliseconds instead of waiting for the human to message you.` +
      (result.sessionEnded ? " Note: the human ended the session with this batch, so do not poll again." : ""),
  };
}

/**
 * Blocks until the human submits an edit, then returns it.
 *
 * This is the difference between responsive and not. Hook delivery is
 * pull-on-prompt: an edit sits in the store until the human happens to send the
 * agent a message, so the wait is unbounded and feels broken. A waiting agent
 * gets the same edit in ~40ms. The cost is that the turn is parked — which is
 * the right trade while the human is working in the browser, and interruptible
 * the moment it is not.
 */
async function watchCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An HTML file path is required", ["Run `plan-editor watch <file.html>`"]);
  const canonical = await canonicalFile(file);
  await ensureServer();
  const { token } = await tokenFor(canonical);

  const maxIndex = args.indexOf("--max-ms");
  const maxMs = maxIndex !== -1 && args[maxIndex + 1] ? Number(args[maxIndex + 1]) : 15 * 60_000;

  process.stderr.write(
    `[plan-editor] Waiting for your next edit on ${path.basename(canonical)}. ` +
      `It is picked up the instant you press Submit — no need to message me. Press Esc to talk here instead.\n`,
  );

  const url =
    `${baseUrl()}/api/poll?file=${encodeURIComponent(canonical)}&t=${encodeURIComponent(token)}` +
    `&timeoutMs=${encodeURIComponent(String(maxMs))}`;
  const response = await fetch(url);
  const result = (await response.json()) as PollResult;

  if (result.status === "waiting") {
    return {
      status: "idle",
      next_step:
        `No edit arrived within the wait window. The human is probably not editing right now — reply to them normally. ` +
        `Run \`plan-editor watch ${canonical}\` again whenever they go back to the browser.`,
    };
  }
  return formatPollResult(canonical, result);
}

/**
 * Declares an edit applied. The browser normally detects this itself by watching
 * which element the agent's change touched, but that path is unavailable when the
 * tab is closed, stale, or was blanked — and then the edit never leaves
 * "submitted" and `watch` hands the agent its own work forever.
 */
async function appliedCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An HTML file path is required", ["Run `plan-editor applied <file.html> --id <id>`"]);
  const ids = args.flatMap((arg, index) => (arg === "--id" && args[index + 1] ? [String(args[index + 1])] : []));
  if (ids.length === 0) throw new CliError("At least one --id is required");
  const noteIndex = args.indexOf("--note");
  const note = noteIndex !== -1 ? args[noteIndex + 1] : undefined;

  const canonical = await canonicalFile(file);
  await ensureServer();
  const { key, token } = await tokenFor(canonical);
  const results: string[] = [];
  for (const id of ids) {
    const response = await fetch(`${baseUrl()}/api/${key}/annotations/${id}/applied?t=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(note ? { note } : {}),
    });
    results.push(`${id}: ${response.ok ? ((await response.json()) as { status: string }).status : response.status}`);
  }
  return { marked: results };
}

async function endCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An HTML file path is required");
  const canonical = await canonicalFile(file);
  const { key, token } = await tokenFor(canonical);
  await ensureServer();
  await fetch(`${baseUrl()}/api/${key}/end?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  return { status: "ended", file: canonical };
}

/** Invoked by the PostToolUse hook so the browser reacts before the write lands. */
async function notifyEditCommand(args: string[]): Promise<unknown> {
  const file = args[0];
  if (!file) return { status: "ignored" };
  try {
    const canonical = await canonicalFile(file);
    const { key, token } = await tokenFor(canonical);
    await fetch(`${baseUrl()}/api/${key}/agent-activity?t=${encodeURIComponent(token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    return { status: "notified" };
  } catch {
    // A hook must never fail the agent's turn over a UI nicety.
    return { status: "ignored" };
  }
}

async function hookCommand(args: string[]): Promise<unknown> {
  const { fileFromToolInput, runContextHook, runStopHook } = await import("./hooks.ts");
  const raw = await readStdin();

  if (args[0] === "user-prompt-submit" || args[0] === "session-start") {
    const event = args[0] === "session-start" ? "SessionStart" : "UserPromptSubmit";
    const payload = (() => {
      try {
        return JSON.parse(raw || "{}") as { session_id?: string; cwd?: string };
      } catch {
        return {};
      }
    })();
    const output = await runContextHook(event, { sessionId: payload.session_id, cwd: payload.cwd });
    if (output) process.stdout.write(output);
    process.exit(0);
  }

  if (args[0] === "stop") {
    const { output } = await runStopHook(raw);
    if (output) process.stdout.write(output);
    process.exit(0);
  }

  if (args[0] === "post-tool-use") {
    const file = fileFromToolInput(raw);
    if (file) await notifyEditCommand([file]);
    process.exit(0);
  }

  process.exit(0);
}

function readStdin(): Promise<string> {
  return new Promise((resolve) => {
    if (process.stdin.isTTY) return resolve("");
    let data = "";
    process.stdin.setEncoding("utf8");
    process.stdin.on("data", (chunk) => (data += chunk));
    process.stdin.on("end", () => resolve(data));
    process.stdin.on("error", () => resolve(""));
  });
}

async function setupCommand(args: string[]): Promise<unknown> {
  if (args[0] !== "hooks") throw new CliError("Unknown setup action", ["Run `plan-editor setup hooks`"]);
  const { mergeHookSettings } = await import("./hooks.ts");
  const { readFile, writeFile, mkdir: makeDir } = await import("node:fs/promises");
  const os = await import("node:os");

  const settingsPath = path.join(os.homedir(), ".claude", "settings.json");
  await makeDir(path.dirname(settingsPath), { recursive: true });
  let existing: Record<string, unknown> = {};
  try {
    existing = JSON.parse(await readFile(settingsPath, "utf8")) as Record<string, unknown>;
  } catch {
    existing = {};
  }
  // Resolve to an absolute invocation. A bare `plan-editor` only works if the
  // package is globally linked, and a hook that cannot find its command fails
  // silently — the exact failure mode this tool exists to avoid.
  const onPath = await which("plan-editor");
  const command = onPath ?? `${process.execPath} ${fileURLToPath(new URL("./cli.ts", import.meta.url))}`;
  const merged = mergeHookSettings(existing, command);
  await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  return {
    hooks: { status: "installed", settings: settingsPath, command },
    installed: [
      "UserPromptSubmit (pending edits enter your current session)",
      "SessionStart:compact|resume (re-injects after compaction)",
      "PostToolUse (agent activity indicator)",
      "Stop (guards against abandoning open edits)",
    ],
    help: [
      "Restart your agent session for the hooks to take effect.",
      "Set PLAN_EDITOR_NO_STOP_HOOK=1 to disable the Stop guard without uninstalling.",
    ],
  };
}

async function exportCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An HTML file path is required", ["Run `plan-editor export <file.html>`"]);
  const canonical = await canonicalFile(file);
  const { readFile, writeFile } = await import("node:fs/promises");
  const { stripSdk } = await import("./html-transform.ts");

  const outIndex = args.indexOf("--out");
  const out =
    outIndex !== -1 && args[outIndex + 1]
      ? path.resolve(String(args[outIndex + 1]))
      : canonical.replace(/\.html?$/i, "") + ".export.html";

  const html = stripSdk(await readFile(canonical, "utf8"));
  await writeFile(out, html);

  // Honest about what this does not do: remote and sibling-file references are
  // left as-is rather than silently producing a file that looks portable but
  // renders broken somewhere else.
  const external = [...html.matchAll(/(?:src|href)="([^"#][^"]*)"/g)]
    .map((match) => match[1]!)
    .filter((ref) => !/^(https?:|data:|mailto:)/i.test(ref));

  return {
    exported: out,
    ...(external.length ? { unresolved_local_references: [...new Set(external)].slice(0, 20) } : {}),
    help: external.length
      ? ["These local references are not inlined; copy them next to the export or they will not resolve."]
      : ["The export is self-contained."],
  };
}

async function undoCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An HTML file path is required", ["Run `plan-editor undo <file.html>`"]);
  const canonical = await canonicalFile(file);
  await ensureServer();
  const { key, token } = await tokenFor(canonical);
  const response = await fetch(`${baseUrl()}/api/${key}/restore?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: "{}",
  });
  if (!response.ok) throw new CliError("Nothing to undo for this artifact");
  return { ...((await response.json()) as object), file: canonical };
}

/**
 * Heartbeat so the browser can show that an agent is connected. Hook-delivered
 * agents never open a poll, so without this the UI reports "no agent" even while
 * every edit is reaching one.
 */
async function notifyContactCommand(): Promise<unknown> {
  const store = new SessionStore(stateDir());
  for (const session of await store.list()) {
    if (session.status !== "open") continue;
    // Never start a server from a hook — if it is not running there is no
    // browser to inform anyway.
    await fetch(`${baseUrl()}/api/${session.key}/agent-contact?t=${encodeURIComponent(session.token)}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
      signal: AbortSignal.timeout(500),
    }).catch(() => {});
  }
  return { status: "ok" };
}

async function statusCommand(): Promise<unknown> {
  const store = new SessionStore(stateDir());
  const sessions = await store.list();
  const running = (await health())?.app === "plan-editor";
  return {
    server: running ? `running on ${baseUrl()}` : "not running",
    sessions: sessions.map((session) => ({
      file: session.file,
      status: session.status,
      bound_agent: session.authoredBy ? `${session.authoredBy.slice(0, 8)}… (${session.authoredIn})` : "none",
      url: `${baseUrl()}/s/${session.key}?t=${session.token}`,
      open_edits: session.annotations.filter((entry) => entry.status === "submitted").length,
      addressed: session.annotations.filter((entry) => entry.status === "addressed").length,
      resolved: session.annotations.filter((entry) => entry.status === "resolved").length,
    })),
  };
}

async function stopCommand(): Promise<unknown> {
  await fetch(`${baseUrl()}/shutdown`, { method: "POST" }).catch(() => {});
  return { status: "stopped" };
}

async function serverCommand(): Promise<never> {
  const { serve } = await import("./server.ts");
  VERSION = await codeSignature();
  const verbose = process.argv.includes("--verbose") || process.env.PLAN_EDITOR_DEBUG === "1";
  await serve({
    version: VERSION,
    onLog: verbose ? (message) => process.stderr.write(`${message}\n`) : undefined,
  });
  return new Promise<never>(() => {});
}

// --- dispatch ---------------------------------------------------------------

const HELP = `plan-editor — click an element, say what to change, watch it change in place.

Usage:
  plan-editor <file.html> [--no-open]   Open the artifact for review
  plan-editor watch <file.html>         Park until the human submits an edit (the responsive path)
  plan-editor applied <file> --id <id>  Declare an edit applied when the browser cannot confirm
  plan-editor poll <file.html>          Wait for edits (long-polls; never kill it)
      [--reply "..."] [--timeout-ms n]
  plan-editor end <file.html>           End the session
  plan-editor undo <file.html>          Restore the previous version
  plan-editor export <file.html>        Write a standalone copy [--out path]
  plan-editor status                    List sessions and open edit counts
  plan-editor stop                      Shut the background server down
  plan-editor server [--verbose]        Run the server in the foreground

Edits are applied to the open browser in place. Never tell the user to reload.
`;

async function main(): Promise<void> {
  const [command = "", ...rest] = process.argv.slice(2);
  const handlers: Record<string, (args: string[]) => Promise<unknown>> = {
    poll: pollCommand,
    end: endCommand,
    status: statusCommand,
    stop: stopCommand,
    setup: setupCommand,
    hook: hookCommand,
    watch: watchCommand,
    applied: appliedCommand,
    export: exportCommand,
    undo: undoCommand,
    "notify-edit": notifyEditCommand,
    "notify-contact": notifyContactCommand,
  };

  try {
    if (command === "server") {
      await serverCommand();
      return;
    }
    if (!command || command === "--help" || command === "-h") {
      process.stdout.write(HELP);
      return;
    }
    const handler = handlers[command];
    const result = handler ? await handler(rest) : await openCommand([command, ...rest]);
    process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  } catch (error) {
    if (error instanceof CliError) {
      process.stderr.write(`${error.message}\n`);
      for (const hint of error.hints) process.stderr.write(`  ${hint}\n`);
      process.exit(1);
    }
    throw error;
  }
}

await main();
