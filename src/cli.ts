import path from "node:path";
import { fileURLToPath } from "node:url";

import open from "open";

import { baseUrl, call, CliError, codeSignature, ensureServer, health, tokenFor } from "./client.ts";
import { formatPollResult } from "./cli-format.ts";
import { awaitAnswer, longPoll } from "./cli-wait.ts";
import { stateDir } from "./paths.ts";
import type { ContractRule } from "./protocol.ts";
import { canonicalFile, SessionStore } from "./store/session-store.ts";

export { formatPollResult, formatReview } from "./cli-format.ts";

// --- commands ---------------------------------------------------------------

async function openCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An artifact path is required", ["Run `plan-editor <file.html|file.md>`"]);
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
  const session = (await response.json()) as { key: string; url: string; token: string; hasViewer?: boolean };

  // Only launch a browser when nothing is already watching. Re-running this
  // during development otherwise leaves a pile of tabs, each holding its own
  // stream and morphing independently.
  const alreadyOpen = Boolean(session.hasViewer);
  if (!args.includes("--no-open") && (!alreadyOpen || args.includes("--force-open"))) {
    await open(session.url);
  }

  return {
    session: { file: canonical, url: session.url, reused_existing_tab: alreadyOpen },
    next_step:
      `The artifact is open. The human now marks it up at their own pace — you will hear nothing until they send the whole ` +
      `review as one batch, which is deliberate. Run \`plan-editor watch ${canonical}\` and wait; it stays silent until then, ` +
      `which is normal. Do not edit the file in the meantime: the document staying still is what lets them read and annotate it.`,
  };
}

async function pollCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An artifact path is required", ["Run `plan-editor poll <file>`"]);
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
  const explicit = timeoutIndex !== -1 ? Number(args[timeoutIndex + 1]) : null;

  if (explicit === null) {
    process.stderr.write(
      `[plan-editor] Waiting for edits on ${canonical}. This stays silent until the human submits — leave it running. ` +
        `If it is interrupted, re-run the same command; submitted edits are never lost.\n`,
    );
  }

  const result =
    explicit !== null
      ? await longPoll(canonical, token, Date.now() + Math.max(0, explicit))
      : await longPoll(canonical, token, Date.now() + 24 * 3600_000);
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
  if (!file) throw new CliError("An artifact path is required", ["Run `plan-editor watch <file>`"]);
  const canonical = await canonicalFile(file);
  await ensureServer();
  const { token } = await tokenFor(canonical);

  const maxIndex = args.indexOf("--max-ms");
  const maxMs = maxIndex !== -1 && args[maxIndex + 1] ? Number(args[maxIndex + 1]) : 15 * 60_000;

  process.stderr.write(
    `[plan-editor] Waiting for your next edit on ${path.basename(canonical)}. ` +
      `It is picked up the instant you press Submit — no need to message me. Press Esc to talk here instead.\n`,
  );

  const result = await longPoll(canonical, token, Date.now() + maxMs);

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

/** Closes out the pending review with the agent's overall response. */
async function respondCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An artifact path is required", ['Run `plan-editor respond <file> --summary "..."`']);
  const summaryIndex = args.indexOf("--summary");
  const summary = summaryIndex !== -1 ? String(args[summaryIndex + 1] ?? "") : "";
  if (!summary) throw new CliError("--summary is required", ["The human needs to know what you did and why."]);

  const canonical = await canonicalFile(file);
  await ensureServer();
  const { key, token } = await tokenFor(canonical);
  const response = await fetch(`${baseUrl()}/api/${key}/review/respond?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ summary }),
  });
  const result = (await response.json()) as { status: string };
  return {
    ...result,
    next_step:
      result.status === "answered"
        ? `The review is now in front of the human to accept or reject item by item. Run \`plan-editor watch ${canonical}\` to wait for their next review.`
        : `There was no pending review to respond to.`,
  };
}

/** Flags how one item was handled, when it was not a straightforward apply. */
async function answerCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An artifact path is required");
  const value = (flag: string) => {
    const index = args.indexOf(flag);
    return index !== -1 ? args[index + 1] : undefined;
  };
  const id = value("--id");
  if (!id) throw new CliError("--id is required");

  const canonical = await canonicalFile(file);
  await ensureServer();
  const { key, token } = await tokenFor(canonical);
  const response = await fetch(`${baseUrl()}/api/${key}/items/${id}/answer?t=${encodeURIComponent(token)}`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ outcome: value("--outcome") ?? "applied", note: value("--note") }),
  });
  return await response.json();
}

async function endCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An artifact path is required");
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
  if (args[0] === "mcp") return setupMcp(args.slice(1));
  if (args[0] !== "hooks") throw new CliError("Unknown setup action", ["Run `plan-editor setup hooks` or `setup mcp`"]);
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

/**
 * Prints the MCP client config rather than editing a config file.
 *
 * `setup hooks` writes to ~/.claude/settings.json because there is exactly one
 * such file and its shape is known. MCP clients are many — Claude Desktop,
 * Cursor, editors — with different config paths and schemas, and silently
 * rewriting the wrong one is worse than printing the four lines to paste.
 */
async function setupMcp(args: string[]): Promise<unknown> {
  const { mcpServerConfig } = await import("./mcp.ts");
  const onPath = await which("plan-editor");
  const command = onPath ?? `${process.execPath} ${fileURLToPath(new URL("./cli.ts", import.meta.url))}`;
  const config = mcpServerConfig(command);

  const out = valueOf(args, "--out");
  if (out) {
    const { writeFile } = await import("node:fs/promises");
    const target = path.resolve(out);
    await writeFile(target, `${JSON.stringify(config, null, 2)}\n`);
    return { written: target, config };
  }
  return {
    config,
    help: [
      "Add this to your MCP client's config (Claude Desktop: claude_desktop_config.json).",
      "For Claude Code, `plan-editor setup hooks` is strictly better — hooks deliver a review into the session you " +
        "are already in, with no tool call required at all.",
    ],
  };
}

async function exportCommand(args: string[]): Promise<unknown> {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An artifact path is required", ["Run `plan-editor export <file>`"]);
  const canonical = await canonicalFile(file);
  const { readFile, writeFile } = await import("node:fs/promises");
  const { stripSdk } = await import("./html-transform.ts");
  const { isMarkdownPath, renderMarkdown } = await import("./markdown.ts");

  const outIndex = args.indexOf("--out");
  const out =
    outIndex !== -1 && args[outIndex + 1]
      ? path.resolve(String(args[outIndex + 1]))
      : `${canonical.replace(/\.(html?|md|markdown|mdx)$/i, "")}.export.html`;

  // An export is a standalone *readable* copy, so a markdown artifact is
  // rendered rather than copied. Writing the source into a `.export.html` was
  // the previous behaviour and produced a file that opened as a wall of
  // unformatted text.
  const source = await readFile(canonical, "utf8");
  const html = isMarkdownPath(canonical)
    ? renderMarkdown(source, { title: path.basename(canonical) }).html
    : stripSdk(source);
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
  if (!file) throw new CliError("An artifact path is required", ["Run `plan-editor undo <file>`"]);
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

// --- shared argument plumbing ------------------------------------------------
//
// Every command below needs the same three things: the file, the session token,
// and a JSON round trip. Hand-rolling that per command is how the older ones
// drifted apart in their error handling.

function valueOf(args: string[], flag: string): string | undefined {
  const index = args.indexOf(flag);
  return index !== -1 ? args[index + 1] : undefined;
}

function fileArg(args: string[], usage: string): string {
  const file = args.find((arg) => !arg.startsWith("--"));
  if (!file) throw new CliError("An artifact path is required", [usage]);
  return file;
}

/**
 * Asks the human a question about one item and parks until they answer.
 *
 * `--outcome needs-call` was a dead end before this: the agent could flag an
 * ambiguity and had no way to hear the answer short of the human happening to
 * send a whole new review. Guessing instead is how a review comes back with
 * three items right and one confidently wrong.
 */
async function askCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, 'Run `plan-editor ask <file> --id <item-id> --question "..."`');
  const id = valueOf(args, "--id");
  const question = valueOf(args, "--question");
  if (!id) throw new CliError("--id is required", ["Use the item id from the review you were given."]);
  if (!question) throw new CliError("--question is required");

  const canonical = await canonicalFile(file);
  await ensureServer();
  await call(canonical, `/items/${id}/ask`, { method: "POST", body: { text: question } });

  const maxMs = Number(valueOf(args, "--max-ms") ?? 15 * 60_000);
  process.stderr.write(`[plan-editor] Asked, and waiting for an answer on ${path.basename(canonical)}.\n`);
  const item = await awaitAnswer(canonical, id, Date.now() + Math.max(0, maxMs));
  if (!item) {
    return {
      status: "unanswered",
      next_step:
        `The human has not answered yet. Do not guess: either run \`plan-editor ask\` again to keep waiting, or leave the ` +
        `item with \`--outcome needs-call\` and respond to the rest of the review.`,
    };
  }
  const reply = [...(item.thread ?? [])].reverse().find((message) => message.role === "human");
  return {
    status: "answered",
    item_id: id,
    answer: reply?.text ?? null,
    ...(item.chosenAlternative ? { chose: item.chosenAlternative } : {}),
    next_step: "Apply the item as answered, then respond to the review as usual.",
  };
}


/** Offers the human two or more versions rather than picking one blind. */
async function alternativesCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, "Run `plan-editor alternatives <file> --id <item-id> --json <file.json>`");
  const id = valueOf(args, "--id");
  if (!id) throw new CliError("--id is required");
  const jsonPath = valueOf(args, "--json");
  const inline = valueOf(args, "--alternatives");
  if (!jsonPath && !inline) {
    throw new CliError("--json <file> or --alternatives '<json>' is required", [
      'Each entry is {"id","label","html"} and at least two are needed.',
    ]);
  }
  const { readFile } = await import("node:fs/promises");
  const raw = jsonPath ? await readFile(path.resolve(jsonPath), "utf8") : inline!;
  let alternatives: unknown;
  try {
    alternatives = JSON.parse(raw);
  } catch {
    throw new CliError("The alternatives payload is not valid JSON");
  }

  const canonical = await canonicalFile(file);
  await ensureServer();
  await call(canonical, `/items/${id}/alternatives`, { method: "POST", body: { alternatives } });
  return {
    status: "offered",
    next_step:
      `The human now picks one in the browser. Run \`plan-editor ask ${canonical} --id ${id} --question "which option?"\` ` +
      `only if you also need prose; otherwise \`plan-editor watch ${canonical}\` picks the choice up.`,
  };
}

/** The rules that outlive every review. */
async function contractCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, 'Run `plan-editor contract <file> [--add "rule"] [--retire <id>]`');
  const canonical = await canonicalFile(file);
  await ensureServer();

  const add = valueOf(args, "--add");
  if (add) return { ...(await call(canonical, "/contract", { method: "POST", body: { text: add } })) };
  const retire = valueOf(args, "--retire");
  if (retire) return { ...(await call(canonical, `/contract/${retire}`, { method: "DELETE" })) };

  const result = (await call(canonical, "/contract")) as { active?: ContractRule[] };
  return {
    rules: (result.active ?? []).map((rule) => ({ id: rule.id, text: rule.text })),
    note: "These are injected ahead of every review of this document.",
  };
}

/** Promotes a rejection into a standing rule. */
async function promoteCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, "Run `plan-editor promote <file> --id <item-id>`");
  const id = valueOf(args, "--id");
  if (!id) throw new CliError("--id is required");
  const canonical = await canonicalFile(file);
  await ensureServer();
  return call(canonical, `/items/${id}/promote`, {
    method: "POST",
    body: { ...(valueOf(args, "--text") ? { text: valueOf(args, "--text") } : {}) },
  });
}

async function lockCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, 'Run `plan-editor lock <file> --selector "#budget" [--label "..."]`');
  const canonical = await canonicalFile(file);
  await ensureServer();
  const remove = valueOf(args, "--remove");
  if (remove) return call(canonical, `/locks/${remove}`, { method: "DELETE" });
  const selector = valueOf(args, "--selector");
  if (!selector) throw new CliError("--selector is required", ["Or use --remove <lock-id>."]);
  return call(canonical, "/locks", {
    method: "POST",
    body: { selector, text: valueOf(args, "--text") ?? "", label: valueOf(args, "--label") },
  });
}

/** Lints an artifact against the contract that makes anchoring work. */
async function doctorCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, "Run `plan-editor doctor <file.html>`");
  const canonical = await canonicalFile(file);
  const { readFile } = await import("node:fs/promises");
  const { inspectArtifactSource } = await import("./doctor.ts");
  const { isMarkdownPath } = await import("./markdown.ts");
  const findings = inspectArtifactSource(canonical, await readFile(canonical, "utf8"));
  const errors = findings.filter((finding) => finding.severity === "error");
  return {
    file: canonical,
    ok: errors.length === 0,
    findings,
    help: findings.length
      ? [
          "Stable section ids are the highest-value fix: idiomorph matches on id first, so ids are the difference " +
            "between a note being marked addressed and being marked orphaned.",
        ]
      : isMarkdownPath(canonical)
        ? ["Markdown artifacts get their ids from the renderer, so there is nothing to fix by hand."]
        : ["This artifact follows the contract."],
  };
}

/** Writes a starter artifact that already satisfies the contract. */
async function newCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, "Run `plan-editor new <file.html> --template plan|spec|report`");
  const { renderTemplate, TEMPLATES } = await import("./doctor.ts");
  const kind = (valueOf(args, "--template") ?? "plan") as keyof typeof TEMPLATES;
  if (!(kind in TEMPLATES)) throw new CliError(`Unknown template: ${kind}`, [`Try: ${Object.keys(TEMPLATES).join(", ")}`]);
  const title = valueOf(args, "--title") ?? path.basename(file).replace(/\.html?$/i, "").replace(/[-_]/g, " ");

  const { writeFile } = await import("node:fs/promises");
  const target = path.resolve(file);
  const { access } = await import("node:fs/promises");
  const exists = await access(target).then(
    () => true,
    () => false,
  );
  // Never silently overwrite a document someone is working on.
  if (exists && !args.includes("--force")) {
    throw new CliError(`${target} already exists`, ["Pass --force to overwrite it."]);
  }
  await writeFile(target, renderTemplate(kind, title));
  return { created: target, template: kind, next_step: `Open it with \`plan-editor ${target}\`.` };
}

/** The review record — what was asked, what was done, what was accepted. */
async function transcriptCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, "Run `plan-editor transcript <file> [--out path.md]`");
  const canonical = await canonicalFile(file);
  await ensureServer();
  const { key, token } = await tokenFor(canonical);
  const response = await fetch(`${baseUrl()}/api/${key}/transcript?t=${encodeURIComponent(token)}`);
  if (!response.ok) throw new CliError("Could not build a transcript for this artifact");
  const markdown = await response.text();
  const out = valueOf(args, "--out");
  if (!out) return { transcript: markdown };
  const { writeFile } = await import("node:fs/promises");
  const target = path.resolve(out);
  await writeFile(target, markdown);
  return { written: target };
}

/** Sequential handoff: no server exposure, no accounts, no merge problem. */
async function packetCommand(args: string[]): Promise<unknown> {
  const action = args[0];
  const rest = args.slice(1);
  const file = fileArg(rest, "Run `plan-editor packet export|import <file> …`");
  const canonical = await canonicalFile(file);
  await ensureServer();
  const { readFile, writeFile } = await import("node:fs/promises");

  if (action === "export") {
    const { key, token } = await tokenFor(canonical);
    const reviewId = valueOf(rest, "--review");
    if (!reviewId) throw new CliError("--review <review-id> is required", ["`plan-editor status` lists them."]);
    const response = await fetch(`${baseUrl()}/api/${key}/packet/${reviewId}?t=${encodeURIComponent(token)}`);
    if (!response.ok) throw new CliError("No such review on this artifact");
    const target = path.resolve(valueOf(rest, "--out") ?? "review.packet.json");
    await writeFile(target, await response.text());
    return { written: target, help: ["Send this file to your reviewer; they import it against their own copy."] };
  }

  if (action === "import") {
    const source = valueOf(rest, "--in");
    if (!source) throw new CliError("--in <review.packet.json> is required");
    const packet = JSON.parse(await readFile(path.resolve(source), "utf8")) as unknown;
    return call(canonical, "/packet/import", {
      method: "POST",
      body: { packet, from: valueOf(rest, "--from") ?? path.basename(source) },
    });
  }

  throw new CliError("Unknown packet action", ["Use `packet export` or `packet import`."]);
}

async function commitCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, 'Run `plan-editor commit <file> --message "..."`');
  const canonical = await canonicalFile(file);
  await ensureServer();
  const message = valueOf(args, "--message");
  if (!message) throw new CliError("--message is required");
  return call(canonical, "/git/commit", { method: "POST", body: { message } });
}

/** Names or pins a version, so history is not a row of anonymous `v7`s. */
async function versionCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, 'Run `plan-editor version <file> --seq 12 --label "sent to leadership" [--pin]`');
  const canonical = await canonicalFile(file);
  await ensureServer();
  const seq = valueOf(args, "--seq");
  if (!seq) throw new CliError("--seq is required");
  return call(canonical, `/versions/${seq}/label`, {
    method: "POST",
    body: {
      ...(valueOf(args, "--label") !== undefined ? { label: valueOf(args, "--label") } : {}),
      ...(args.includes("--pin") ? { pinned: true } : args.includes("--unpin") ? { pinned: false } : {}),
    },
  });
}

/** Which sections keep being rewritten — i.e. where the disagreement is. */
async function churnCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, "Run `plan-editor churn <file>`");
  const canonical = await canonicalFile(file);
  await ensureServer();
  const result = (await call(canonical, "/churn")) as { churn?: Array<{ id: string; rewrites: number }> };
  return {
    churn: result.churn ?? [],
    note: "A section rewritten many times is one you and the agent still disagree about.",
  };
}

/** Artifacts reviewed together, so a cross-cutting note is answerable. */
async function companionsCommand(args: string[]): Promise<unknown> {
  const file = fileArg(args, "Run `plan-editor companions <file> --with a.md b.html`");
  const canonical = await canonicalFile(file);
  await ensureServer();
  const index = args.indexOf("--with");
  const files = index === -1 ? [] : args.slice(index + 1).filter((arg) => !arg.startsWith("--"));
  return call(canonical, "/companions", { method: "POST", body: { files } });
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
      drafting: session.reviews.find((r) => r.status === "drafting")?.items.length ?? 0,
      awaiting_agent: session.reviews.filter((r) => r.status === "sent").length,
      awaiting_your_review: session.reviews
        .flatMap((r) => r.items)
        .filter((i) => i.status === "answered").length,
      // A parked agent is the one state where someone is actively blocked, so
      // it is worth surfacing above the tallies that merely accumulate.
      awaiting_your_answer: session.reviews.flatMap((r) => r.items).filter((i) => i.awaitingHuman).length,
      standing_rules: (session.contract ?? []).filter((rule) => !rule.retiredAt).length,
      locked_regions: (session.locks ?? []).length,
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
  const instance = await serve({
    version: await codeSignature(),
    onLog: verbose ? (message) => process.stderr.write(`${message}\n`) : undefined,
  });

  // Park until the server actually stops, then leave. This used to park on a
  // promise that never settled, so `plan-editor stop` and every version-driven
  // restart closed the listener and left the process running forever — one
  // leaked process per edit to src/, since the code signature is part of the
  // server's identity.
  await instance.closed;
  process.exit(0);
}

// --- dispatch ---------------------------------------------------------------

const HELP = `plan-editor — click an element, say what to change, watch it change in place.

Reviewing (.html, .htm, .md):
  plan-editor <file> [--no-open]        Open the artifact for review
  plan-editor watch <file>              Park until the human sends a review (the responsive path)
  plan-editor respond <file> --summary  Close the review with what you changed and why
  plan-editor answer <file> --id <id>   Flag one item: --outcome caveat|needs-call|skipped --note ".."
  plan-editor ask <file> --id <id>      Ask about one item and park until answered
      --question "..." [--max-ms n]
  plan-editor alternatives <file>       Offer two or more versions to pick from
      --id <id> --json alts.json
  plan-editor poll <file>               Wait for a review (long-polls; never kill it)
      [--reply "..."] [--timeout-ms n]
  plan-editor end <file>                End the session

Standing context (outlives any one review):
  plan-editor contract <file>           List the rules injected into every review
      [--add "rule"] [--retire <id>]
  plan-editor promote <file> --id <id>  Turn a rejection into a standing rule
  plan-editor lock <file>               Mark a region the agent must not touch
      --selector "#budget" [--label ".."] [--remove <id>]
  plan-editor companions <file>         Review several artifacts as one set
      --with a.md b.html

History and the record:
  plan-editor undo <file>               Restore the previous version
  plan-editor version <file> --seq n    Name or pin a version [--label ".."] [--pin]
  plan-editor churn <file>              Which sections keep being rewritten
  plan-editor transcript <file>         The review record as Markdown [--out path]
  plan-editor export <file>             Write a standalone copy [--out path]
  plan-editor commit <file>             Commit the artifact [--message "..."]
  plan-editor packet export <file>      Hand a review to another reviewer
      --review <id> [--out path]
  plan-editor packet import <file>      Take one back [--in path] [--from name]

Authoring and setup:
  plan-editor new <file>                Write a compliant starter artifact
      [--template plan|spec|report] [--title ".."]
  plan-editor doctor <file>             Lint an artifact for anchoring problems
  plan-editor setup hooks               Install the Claude Code hooks
  plan-editor mcp                       Run the MCP server on stdio
  plan-editor status                    List sessions and open review counts
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
    respond: respondCommand,
    answer: answerCommand,
    export: exportCommand,
    undo: undoCommand,
    ask: askCommand,
    alternatives: alternativesCommand,
    contract: contractCommand,
    promote: promoteCommand,
    lock: lockCommand,
    doctor: doctorCommand,
    new: newCommand,
    transcript: transcriptCommand,
    packet: packetCommand,
    commit: commitCommand,
    version: versionCommand,
    churn: churnCommand,
    companions: companionsCommand,
    "notify-edit": notifyEditCommand,
    "notify-contact": notifyContactCommand,
  };

  try {
    if (command === "server") {
      await serverCommand();
      return;
    }
    // The MCP server owns stdio and must never have JSON help written into it.
    if (command === "mcp") {
      const { runMcpServer } = await import("./mcp.ts");
      await runMcpServer();
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
