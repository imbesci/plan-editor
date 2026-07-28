import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";

import { defaultPort, LOOPBACK, serverLogFile, stateDir } from "./paths.ts";
import type { Annotation, PollResult } from "./protocol.ts";
import { canonicalFile, SessionStore, sessionKey } from "./store/session-store.ts";

const VERSION = process.env.PLAN_EDITOR_BUILD_VERSION ?? "0.1.0";

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
    body: JSON.stringify({ file: canonical }),
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
      `Then run \`plan-editor poll ${file} --reply "<what you changed>"\` to report back and keep waiting.` +
      (result.sessionEnded ? " Note: the human ended the session with this batch, so do not poll again." : ""),
  };
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
  const { fileFromToolInput, runStopHook } = await import("./hooks.ts");
  const raw = await readStdin();

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
  const merged = mergeHookSettings(existing, "plan-editor");
  await writeFile(settingsPath, `${JSON.stringify(merged, null, 2)}\n`);
  return {
    hooks: { status: "installed", settings: settingsPath },
    installed: ["PostToolUse (agent activity)", "Stop (guards against abandoning open edits)"],
    help: [
      "Restart your agent session for the hooks to take effect.",
      "Set PLAN_EDITOR_NO_STOP_HOOK=1 to disable the Stop guard without uninstalling.",
    ],
  };
}

async function statusCommand(): Promise<unknown> {
  const store = new SessionStore(stateDir());
  const sessions = await store.list();
  return {
    sessions: sessions.map((session) => ({
      file: session.file,
      status: session.status,
      open_edits: session.annotations.filter((entry) => entry.status === "submitted").length,
      addressed: session.annotations.filter((entry) => entry.status === "addressed").length,
    })),
  };
}

async function stopCommand(): Promise<unknown> {
  await fetch(`${baseUrl()}/shutdown`, { method: "POST" }).catch(() => {});
  return { status: "stopped" };
}

async function serverCommand(): Promise<never> {
  const { serve } = await import("./server.ts");
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
  plan-editor poll <file.html>          Wait for edits (long-polls; never kill it)
      [--reply "..."] [--timeout-ms n]
  plan-editor end <file.html>           End the session
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
    "notify-edit": notifyEditCommand,
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
