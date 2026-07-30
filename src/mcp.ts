// An MCP server, so this works outside Claude Code.
//
// The hooks are the best delivery path there is — they put a review into the
// session the human is already talking to, with no agent cooperation at all —
// but they are Claude-Code-only, and every other agent has to shell out and
// parse prose out of `next_step`. MCP gives those agents typed tools instead.
//
// Hand-rolled JSON-RPC rather than an SDK dependency: the wire format is a few
// dozen lines, and this package deliberately carries four dependencies. The
// stdio transport is newline-delimited JSON-RPC 2.0.
//
// One rule dominates this file: **stdout belongs to the protocol**. A stray
// console.log corrupts the stream and the failure looks like the client
// hanging, not like a log line. Everything diagnostic goes to stderr.

import { readFile } from "node:fs/promises";

import { awaitAnswer, longPoll } from "./cli-wait.ts";
import { baseUrl, call, CliError, ensureServer, PACKAGE_VERSION, tokenFor } from "./client.ts";
import { formatPollResult } from "./cli-format.ts";
import { inspectArtifactSource } from "./doctor.ts";
import { describeOutline, outlineOf, sectionSource } from "./outline.ts";
import type { PollResult } from "./protocol.ts";
import { canonicalFile, SessionStore } from "./store/session-store.ts";
import { stateDir } from "./paths.ts";

const PROTOCOL_VERSION = "2024-11-05";

interface Tool {
  name: string;
  description: string;
  inputSchema: Record<string, unknown>;
  run: (args: Record<string, unknown>) => Promise<unknown>;
}

function fileParam(args: Record<string, unknown>): Promise<string> {
  const file = String(args.file ?? "");
  if (!file) throw new CliError("file is required");
  return canonicalFile(file);
}

/** Waits for a review, through the shared slicing logic rather than a copy of it. */
async function waitForReview(canonical: string, deadline: number): Promise<PollResult> {
  const { token } = await tokenFor(canonical);
  return longPoll(canonical, token, deadline);
}

const TOOLS: Tool[] = [
  {
    name: "open_artifact",
    description:
      "Open an HTML or Markdown artifact for human review in the browser. Returns the session URL. After calling this, " +
      "do not edit the file until a review arrives — the document holding still is what lets the human read and annotate it.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string", description: "Path to the .html or .md artifact." },
        open_browser: { type: "boolean", description: "Launch a browser tab. Default true." },
      },
      required: ["file"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      const response = await fetch(`${baseUrl()}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: canonical, authoredBy: process.env.CLAUDE_CODE_SESSION_ID, authoredIn: process.cwd() }),
      });
      if (!response.ok) throw new CliError(`Could not open session (${response.status})`);
      const session = (await response.json()) as { url: string; hasViewer?: boolean };
      if (args.open_browser !== false && !session.hasViewer) {
        const { default: open } = await import("open");
        await open(session.url);
      }
      return { url: session.url, file: canonical, reused_existing_tab: Boolean(session.hasViewer) };
    },
  },
  {
    name: "await_review",
    description:
      "Block until the human sends a review, then return it as one batch with the standing rules and locked regions " +
      "that apply. This is the responsive path: a sent review reaches a waiting agent in milliseconds.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        max_ms: { type: "number", description: "How long to wait. Default 15 minutes." },
      },
      required: ["file"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      return formatPollResult(canonical, await waitForReview(canonical, Date.now() + Number(args.max_ms ?? 15 * 60_000)));
    },
  },
  {
    name: "respond_to_review",
    description:
      "Close the pending review with a summary of what you changed and why. This is what puts your work in front of " +
      "the human to accept or reject — editing the file alone leaves the review open.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, summary: { type: "string" } },
      required: ["file", "summary"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      return call(canonical, "/review/respond", { method: "POST", body: { summary: String(args.summary ?? "") } });
    },
  },
  {
    name: "answer_item",
    description:
      "Record how you handled one item when it was not a straightforward apply: caveat, needs-call, or skipped, with " +
      "a reason. Use this instead of silently not doing something.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        item_id: { type: "string" },
        outcome: { type: "string", enum: ["applied", "caveat", "needs-call", "skipped"] },
        note: { type: "string" },
      },
      required: ["file", "item_id", "outcome"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      return call(canonical, `/items/${String(args.item_id)}/answer`, {
        method: "POST",
        body: { outcome: args.outcome, note: args.note },
      });
    },
  },
  {
    name: "ask_human",
    description:
      "Ask about one ambiguous item and block until the human answers in the browser. Prefer this over guessing: a " +
      "confidently wrong item costs more than a question.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        item_id: { type: "string" },
        question: { type: "string" },
        max_ms: { type: "number" },
      },
      required: ["file", "item_id", "question"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      const itemId = String(args.item_id);
      await call(canonical, `/items/${itemId}/ask`, { method: "POST", body: { text: String(args.question ?? "") } });
      // Waits on this item specifically. Long-polling the review instead
      // returns instantly — the review is still pending, by definition — and
      // the agent unparks with no answer and guesses anyway.
      const item = await awaitAnswer(canonical, itemId, Date.now() + Number(args.max_ms ?? 15 * 60_000));
      if (!item) return { status: "unanswered", note: "Do not guess — ask again or flag it needs-call." };
      const reply = [...(item.thread ?? [])].reverse().find((message) => message.role === "human");
      return { status: "answered", answer: reply?.text ?? null, chose: item.chosenAlternative ?? null };
    },
  },
  {
    name: "offer_alternatives",
    description:
      "Offer the human two or more versions of a section to choose between, rendered in place in the browser. Use " +
      "when showing beats asking.",
    inputSchema: {
      type: "object",
      properties: {
        file: { type: "string" },
        item_id: { type: "string" },
        alternatives: {
          type: "array",
          items: {
            type: "object",
            properties: { id: { type: "string" }, label: { type: "string" }, html: { type: "string" } },
            required: ["label", "html"],
          },
        },
      },
      required: ["file", "item_id", "alternatives"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      return call(canonical, `/items/${String(args.item_id)}/alternatives`, {
        method: "POST",
        body: { alternatives: args.alternatives },
      });
    },
  },
  {
    name: "list_standing_rules",
    description:
      "The rules that apply to every review of this artifact, which the human set because the same correction kept " +
      "coming back. Honour them even where the current review says nothing about them.",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      return call(canonical, "/contract");
    },
  },
  {
    name: "mark_item_applied",
    description:
      "Declare one item done when the browser never confirmed it. An item leaves the agent's queue when the browser " +
      "reports that your change touched its anchor; if the tab is closed or stale that never happens, and the same item " +
      "is handed back to you on every cycle. Use this when an item you have already applied comes back.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, item_id: { type: "string" }, note: { type: "string" } },
      required: ["file", "item_id"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      return call(canonical, `/items/${String(args.item_id)}/answer`, {
        method: "POST",
        body: { outcome: "applied", ...(args.note ? { note: args.note } : {}) },
      });
    },
  },
  {
    name: "outline_artifact",
    description:
      "The artifact's sections, with the id each one anchors by, its word count and its source line range. Read this " +
      "before reading the file: it is a few hundred tokens against the whole document's several thousand, and it tells " +
      "you which single section a review item is actually about.",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    async run(args) {
      const canonical = await fileParam(args);
      return describeOutline(canonical, outlineOf(canonical, await readFile(canonical, "utf8")));
    },
  },
  {
    name: "read_section",
    description:
      "One section's source exactly as it exists in the file — markdown for a .md, markup for an .html. Use it instead " +
      "of opening the whole artifact to change one paragraph. Fails rather than guessing when the id is unknown.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, section_id: { type: "string" } },
      required: ["file", "section_id"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      const source = await readFile(canonical, "utf8");
      const id = String(args.section_id);
      const section = sectionSource(canonical, source, id);
      if (!section) {
        const ids = outlineOf(canonical, source).entries.slice(0, 40).map((entry) => entry.id);
        throw new CliError(
          `No section with id "${id}".`,
          ids.length ? [`Ids in this document: ${ids.join(", ")}`] : ["This document has no id'd sections."],
        );
      }
      return section;
    },
  },
  {
    name: "artifact_diff",
    description:
      "What changed by section since a version, so you can check your own work before reporting it. Anything here that " +
      "no review item asked for is what the human is shown as a change nobody requested.",
    inputSchema: {
      type: "object",
      properties: { file: { type: "string" }, since_version: { type: "number" } },
      required: ["file"],
    },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      const from = args.since_version === undefined ? "" : `?from=${encodeURIComponent(String(args.since_version))}`;
      return call(canonical, `/diff${from}`);
    },
  },
  {
    name: "inspect_artifact",
    description:
      "Lint an artifact for the properties this tool depends on — chiefly stable section ids, which are the " +
      "difference between a human's note being marked addressed and being marked orphaned.",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    async run(args) {
      const canonical = await fileParam(args);
      const findings = inspectArtifactSource(canonical, await readFile(canonical, "utf8"));
      return { ok: findings.every((finding) => finding.severity !== "error"), findings };
    },
  },
  {
    name: "review_transcript",
    description: "The full review record as Markdown: what was asked, what you did, what the human accepted and why.",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      const { key, token } = await tokenFor(canonical);
      const response = await fetch(`${baseUrl()}/api/${key}/transcript?t=${encodeURIComponent(token)}`);
      return { transcript: await response.text() };
    },
  },
  {
    name: "undo_last_change",
    description: "Restore the artifact to its previous version. The browser morphs in place, and the undo is itself undoable.",
    inputSchema: { type: "object", properties: { file: { type: "string" } }, required: ["file"] },
    async run(args) {
      const canonical = await fileParam(args);
      await ensureServer();
      return call(canonical, "/restore", { method: "POST", body: {} });
    },
  },
  {
    name: "session_status",
    description: "Every open artifact, which agent is bound to it, and how many items are waiting on whom.",
    inputSchema: { type: "object", properties: {} },
    async run() {
      const sessions = await new SessionStore(stateDir()).list();
      return {
        sessions: sessions.map((session) => ({
          file: session.file,
          status: session.status,
          drafting: session.reviews.find((review) => review.status === "drafting")?.items.length ?? 0,
          awaiting_agent: session.reviews.filter((review) => review.status === "sent").length,
          awaiting_human: session.reviews.flatMap((review) => review.items).filter((item) => item.status === "answered").length,
          standing_rules: (session.contract ?? []).filter((rule) => !rule.retiredAt).length,
        })),
      };
    },
  },
];

// --- JSON-RPC ---------------------------------------------------------------

interface Request {
  jsonrpc: "2.0";
  id?: number | string;
  method: string;
  params?: Record<string, unknown>;
}

function send(message: unknown): void {
  process.stdout.write(`${JSON.stringify(message)}\n`);
}

async function handle(request: Request): Promise<unknown | null> {
  const { id, method, params } = request;
  // A notification has no id and must draw no response at all — replying to one
  // is a protocol violation that some clients treat as a fatal stream error.
  const isNotification = id === undefined;

  if (method === "initialize") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        protocolVersion: PROTOCOL_VERSION,
        capabilities: { tools: {} },
        serverInfo: { name: "plan-editor", version: PACKAGE_VERSION },
      },
    };
  }
  if (method === "notifications/initialized" || method === "notifications/cancelled") return null;
  if (method === "ping") return { jsonrpc: "2.0", id, result: {} };

  if (method === "tools/list") {
    return {
      jsonrpc: "2.0",
      id,
      result: {
        tools: TOOLS.map(({ name, description, inputSchema }) => ({ name, description, inputSchema })),
      },
    };
  }

  if (method === "tools/call") {
    const name = String(params?.name ?? "");
    const tool = TOOLS.find((entry) => entry.name === name);
    if (!tool) {
      return { jsonrpc: "2.0", id, error: { code: -32602, message: `Unknown tool: ${name}` } };
    }
    try {
      const result = await tool.run((params?.arguments ?? {}) as Record<string, unknown>);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: JSON.stringify(result, null, 2) }] } };
    } catch (error) {
      // A failed tool call is reported as tool content with isError, not as a
      // JSON-RPC error: the agent should see the message and be able to recover,
      // not have the call fail underneath it.
      const message = error instanceof CliError ? [error.message, ...error.hints].join(" ") : String(error);
      return { jsonrpc: "2.0", id, result: { content: [{ type: "text", text: message }], isError: true } };
    }
  }

  if (isNotification) return null;
  return { jsonrpc: "2.0", id, error: { code: -32601, message: `Unknown method: ${method}` } };
}

export async function runMcpServer(): Promise<void> {
  process.stderr.write(`[plan-editor] MCP server ready (${TOOLS.length} tools)\n`);

  let buffer = "";
  process.stdin.setEncoding("utf8");
  for await (const chunk of process.stdin) {
    buffer += chunk;
    let newline = buffer.indexOf("\n");
    while (newline !== -1) {
      const line = buffer.slice(0, newline).trim();
      buffer = buffer.slice(newline + 1);
      newline = buffer.indexOf("\n");
      if (!line) continue;
      let request: Request;
      try {
        request = JSON.parse(line) as Request;
      } catch {
        send({ jsonrpc: "2.0", id: null, error: { code: -32700, message: "Parse error" } });
        continue;
      }
      // Sequential rather than concurrent: `await_review` and `ask_human` park
      // for minutes at a time, and a client that pipelines a second call behind
      // one of those expects it to be queued, not raced.
      const response = await handle(request).catch((error: unknown) => ({
        jsonrpc: "2.0" as const,
        id: request.id ?? null,
        error: { code: -32603, message: String(error) },
      }));
      if (response) send(response);
    }
  }
}

/** Where the client config points. Reported by `plan-editor setup mcp`. */
export function mcpServerConfig(command: string): Record<string, unknown> {
  return {
    mcpServers: {
      "plan-editor": {
        command: command.split(" ")[0],
        args: [...command.split(" ").slice(1), "mcp"],
      },
    },
  };
}

export const MCP_TOOL_NAMES = TOOLS.map((tool) => tool.name);

/** Exposed so a test can drive the protocol without spawning a process. */
export const handleForTest = handle;
