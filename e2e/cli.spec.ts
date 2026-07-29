// Every CLI command, driven against a live server, asserting real effects
// rather than exit codes. This is the agent's entire interface to the tool.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import { expect, test } from "@playwright/test";
import { boot, PLAN_HTML, type Harness } from "./harness.ts";

const run = promisify(execFile);
/**
 * Bun, not whatever is running the tests.
 *
 * Playwright runs under Node and the CLI imports TypeScript directly, so a
 * `process.execPath` child dies on the first `import "./cli.ts"`.
 */
function resolveBun(): string {
  if (process.env.PE_BUN) return process.env.PE_BUN;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "bun");
    if (dir && existsSync(candidate)) return candidate;
  }
  return "bun";
}
const BUN = resolveBun();
const BIN = path.resolve(import.meta.dirname, "../bin/plan-editor.js");

let h: Harness;
test.beforeAll(async () => {
  h = await boot({ name: "plan.html", content: PLAN_HTML });
});
test.afterAll(async () => {
  await h.dispose();
});

test("status reports the session, the bound agent and the counts", async () => {
  const { json } = await h.cli(["status"]);
  expect(json.server).toContain("running");
  const entry = json.sessions.find((s: any) => s.file === h.file);
  expect(entry.status).toBe("open");
  expect(entry).toHaveProperty("standing_rules");
  expect(entry).toHaveProperty("awaiting_your_answer");
});

test("doctor lints a good artifact clean and a bad one loudly", async () => {
  const good = await h.cli(["doctor", h.file]);
  expect(good.json.ok).toBe(true);

  const bad = path.join(h.dir, "bad.html");
  await writeFile(bad, `<html><body><p id="a">one</p><p id="a">dup</p></body></html>`);
  const result = await h.cli(["doctor", bad]);
  expect(result.json.ok).toBe(false);
  expect(result.json.findings.some((f: any) => f.rule === "duplicate-ids")).toBe(true);
});

test("new writes a starter artifact that passes doctor", async () => {
  for (const template of ["plan", "spec", "report"]) {
    const target = path.join(h.dir, `starter-${template}.html`);
    const created = await h.cli(["new", target, "--template", template, "--title", "Test"]);
    expect(created.json.template).toBe(template);
    const linted = await h.cli(["doctor", target]);
    expect(linted.json.ok).toBe(true);
  }
});

test("new refuses to overwrite without --force", async () => {
  const target = path.join(h.dir, "plan.html");
  await expect(h.cli(["new", target])).rejects.toThrow();
  const forced = await h.cli(["new", target, "--force", "--template", "plan"]);
  expect(forced.json.created).toBe(target);
});

test("contract adds, lists and retires standing rules", async () => {
  await h.cli(["contract", h.file, "--add", "Never use the word 'leverage'."]);
  const listed = await h.cli(["contract", h.file]);
  expect(listed.json.rules).toHaveLength(1);

  const id = listed.json.rules[0].id;
  await h.cli(["contract", h.file, "--retire", id]);
  expect((await h.cli(["contract", h.file])).json.rules).toHaveLength(0);
});

test("lock and unlock a region", async () => {
  const locked = await h.cli(["lock", h.file, "--selector", "#budget-p", "--label", "Budget"]);
  expect(locked.json.status).toBe("locked");
  expect((await h.session()).locks).toHaveLength(1);

  await h.cli(["lock", h.file, "--remove", locked.json.lock.id]);
  expect((await h.session()).locks).toHaveLength(0);
});

test("companions validates paths server-side", async () => {
  const spec = path.join(h.dir, "spec.md");
  await writeFile(spec, "# Spec\n");
  const result = await h.cli(["companions", h.file, "--with", spec, "/etc/passwd"]);
  expect(result.json.companions).toHaveLength(1);
  expect(result.json.companions[0]).toContain("spec.md");
});

test("the full agent round trip: poll, answer, respond", async () => {
  await h.api("/items", {
    method: "POST",
    body: { items: [{ body: "Tighten the risks.", selector: "#risks-p", text: "The classifier is the whole design." }] },
  });
  await h.api("/review/send", { method: "POST", body: {} });

  const review = (await h.cli(["poll", h.file, "--timeout-ms", "500"])).json;
  expect(review.status).toBe("review");
  const id = review.items[0].id;

  await h.cli(["answer", h.file, "--id", id, "--outcome", "caveat", "--note", "Shortened, but kept the caveat."]);
  const responded = await h.cli(["respond", h.file, "--summary", "Tightened it."]);
  expect(responded.json.status).toBe("answered");

  const item = (await h.session()).reviews.flatMap((r: any) => r.items).find((i: any) => i.id === id);
  expect(item.outcome).toBe("caveat");
  expect(item.agentNote).toContain("kept the caveat");
});

test("watch returns idle when nothing arrives", async () => {
  const result = await h.cli(["watch", h.file, "--max-ms", "1200"]);
  expect(result.json.status).toBe("idle");
});

test("alternatives are offered from a JSON file", async () => {
  await h.api("/items", { method: "POST", body: { items: [{ body: "Pick a tone.", selector: "#idea-p", text: "Ingest jobs fail" }] } });
  await h.api("/review/send", { method: "POST", body: {} });
  const review = (await h.cli(["poll", h.file, "--timeout-ms", "500"])).json;
  const id = review.items[0].id;

  const altsFile = path.join(h.dir, "alts.json");
  await writeFile(
    altsFile,
    JSON.stringify([
      { id: "a", label: "Direct", html: "<p>Short.</p>" },
      { id: "b", label: "Hedged", html: "<p>Somewhat short.</p>" },
    ]),
  );
  const offered = await h.cli(["alternatives", h.file, "--id", id, "--json", altsFile]);
  expect(offered.json.status).toBe("offered");
  await h.cli(["respond", h.file, "--summary", "Offered two."]);
});

test("version labels and pins, and churn reports rewrites", async () => {
  await h.write((await h.read()).replace("three attempts", "four attempts"));
  await new Promise((r) => setTimeout(r, 1000));

  const labelled = await h.cli(["version", h.file, "--seq", "1", "--label", "first cut", "--pin"]);
  expect(labelled.json.version.label).toBe("first cut");
  expect(labelled.json.version.pinned).toBe(true);

  const churn = await h.cli(["churn", h.file]);
  expect(Array.isArray(churn.json.churn)).toBe(true);
});

test("undo restores the previous version", async () => {
  const before = await h.read();
  const undone = await h.cli(["undo", h.file]);
  expect(undone.json.status).toBe("restored");
  await new Promise((r) => setTimeout(r, 800));
  expect(await h.read()).not.toBe(before);
});

test("transcript writes the review record as Markdown", async () => {
  const out = path.join(h.dir, "record.md");
  const result = await h.cli(["transcript", h.file, "--out", out]);
  expect(result.json.written).toBe(out);
  const markdown = await readFile(out, "utf8");
  expect(markdown).toContain("# Review record");
  expect(markdown).toContain("Tighten the risks.");
});

test("export writes a standalone copy with the SDK stripped", async () => {
  const out = path.join(h.dir, "share.html");
  const result = await h.cli(["export", h.file, "--out", out]);
  expect(result.json.exported).toBe(out);
  const html = await readFile(out, "utf8");
  expect(html).not.toContain("/sdk.js");
  expect(html).toContain("Ingest retry plan");
});

test("a packet round-trips to another artifact's draft", async () => {
  const reviewId = (await h.session()).reviews.find((r: any) => r.items.length > 0).id;
  const packetPath = path.join(h.dir, "review.packet.json");
  const exported = await h.cli(["packet", "export", h.file, "--review", reviewId, "--out", packetPath]);
  expect(exported.json.written).toBe(packetPath);

  const other = await boot({ name: "other.html", content: PLAN_HTML });
  try {
    const imported = await other.cli(["packet", "import", other.file, "--in", packetPath, "--from", "Sam"]);
    expect(imported.json.status).toBe("imported");
    expect(imported.json.items).toBeGreaterThan(0);
    const draft = (await other.session()).reviews.find((r: any) => r.status === "drafting");
    expect(draft.items[0].body).toContain("Sam");
  } finally {
    await other.dispose();
  }
});

test("commit stages and commits only the artifact", async () => {
  const repo = await mkdtemp(path.join(os.tmpdir(), "pe-git-"));
  try {
    const git = (args: string[]) => run("git", args, { cwd: repo });
    await git(["init", "-q"]);
    await git(["config", "user.email", "t@example.com"]);
    await git(["config", "user.name", "T"]);
    const file = path.join(repo, "plan.html");
    await writeFile(file, PLAN_HTML);
    await writeFile(path.join(repo, "unrelated.txt"), "do not commit me");
    await git(["add", "plan.html"]);
    await git(["commit", "-qm", "init"]);

    const g = await boot({ name: "tracked.html", content: PLAN_HTML });
    try {
      // Open the file that actually lives in the repo.
      await g.cli([file, "--no-open"]);
      await writeFile(file, PLAN_HTML.replace("three attempts", "six attempts"));
      await new Promise((r) => setTimeout(r, 900));
      const committed = await g.cli(["commit", file, "--message", "docs: apply review"]);
      expect(committed.json.committed).toBe(true);

      const { stdout } = await git(["log", "--oneline"]);
      expect(stdout).toContain("docs: apply review");
      const { stdout: status } = await git(["status", "--porcelain"]);
      expect(status).toContain("unrelated.txt");
    } finally {
      await g.dispose();
    }
  } finally {
    await rm(repo, { recursive: true, force: true });
  }
});

test("setup mcp prints a usable client config", async () => {
  const { json } = await h.cli(["setup", "mcp"]);
  const server = json.config.mcpServers["plan-editor"];
  expect(server.args[server.args.length - 1]).toBe("mcp");
});

test("the MCP server speaks JSON-RPC on stdio", async () => {
  const messages = [
    { jsonrpc: "2.0", id: 1, method: "initialize" },
    { jsonrpc: "2.0", method: "notifications/initialized" },
    { jsonrpc: "2.0", id: 2, method: "tools/list" },
    { jsonrpc: "2.0", id: 3, method: "tools/call", params: { name: "session_status", arguments: {} } },
  ]
    .map((m) => JSON.stringify(m))
    .join("\n");

  const child = execFile(BUN, [BIN, "mcp"], { env: { ...process.env, PLAN_EDITOR_STATE_DIR: h.stateDir, PLAN_EDITOR_PORT: String(h.port) } });
  let out = "";
  child.stdout!.on("data", (chunk) => (out += chunk));
  child.stdin!.write(messages + "\n");
  await new Promise((r) => setTimeout(r, 3500));
  child.kill();

  const replies = out.trim().split("\n").filter(Boolean).map((line) => JSON.parse(line));
  // A notification must draw no reply, so three messages with ids yield three.
  expect(replies).toHaveLength(3);
  expect(replies[0].result.serverInfo.name).toBe("plan-editor");
  expect(replies[1].result.tools.length).toBeGreaterThan(5);
  expect(replies[2].result.content[0].text).toContain("sessions");
});

test("end closes the session and the agent is told to stop waiting", async () => {
  const ended = await h.cli(["end", h.file]);
  expect(ended.json.status).toBe("ended");
  const polled = await h.cli(["poll", h.file, "--timeout-ms", "500"]);
  expect(polled.json.status).toBe("ended");
});

test.describe("the hook delivery path", () => {
  let g: Harness;
  test.beforeAll(async () => {
    g = await boot({ name: "hooked.html", content: PLAN_HTML });
  });
  test.afterAll(async () => {
    await g.dispose();
  });

  /** Runs a hook exactly as Claude Code does: JSON on stdin, JSON on stdout. */
  async function hook(event: string, payload: unknown): Promise<{ code: number; out: string }> {
    return new Promise((resolve) => {
      const child = execFile(
        BUN,
        [BIN, "hook", event],
        { env: { ...process.env, PLAN_EDITOR_STATE_DIR: g.stateDir, PLAN_EDITOR_PORT: String(g.port) } },
        () => {},
      );
      let out = "";
      child.stdout!.on("data", (c) => (out += c));
      child.on("close", (code) => resolve({ code: code ?? 0, out }));
      child.stdin!.end(JSON.stringify(payload));
    });
  }

  test("UserPromptSubmit injects the pending review into the session", async () => {
    await g.cli(["contract", g.file, "--add", "Never use the word 'leverage'."]);
    await g.api("/items", {
      method: "POST",
      body: { items: [{ body: "Tighten the risks.", selector: "#risks-p", text: "The classifier is the whole design." }] },
    });
    await g.api("/review/send", { method: "POST", body: {} });

    // cwd matches, so this session owns the artifact.
    const { code, out } = await hook("user-prompt-submit", { session_id: "sess-1", cwd: g.dir });
    expect(code).toBe(0);
    const payload = JSON.parse(out);
    expect(payload.hookSpecificOutput.hookEventName).toBe("UserPromptSubmit");
    const text = payload.hookSpecificOutput.additionalContext;
    expect(text).toContain("Tighten the risks.");
    // The standing rule leads, and is repeated on every injection.
    expect(text).toContain("Always: Never use the word 'leverage'.");
    expect(text).toContain("plan-editor respond");
  });

  test("a second injection compacts the items but keeps the standing rule", async () => {
    const { out } = await hook("user-prompt-submit", { session_id: "sess-1", cwd: g.dir });
    const text = JSON.parse(out).hookSpecificOutput.additionalContext;
    expect(text).toContain("Always: Never use the word 'leverage'.");
    expect(text).toMatch(/1 item, listed before and still open/);
    expect(text).not.toContain("Tighten the risks.");
  });

  test("a foreign session is never told about the review", async () => {
    const { out } = await hook("user-prompt-submit", { session_id: "someone-else", cwd: "/tmp" });
    expect(out.trim()).toBe("");
  });

  test("Stop blocks the authoring agent while a review is unanswered", async () => {
    // Must be the session that actually opened the artifact: Stop only ever
    // blocks the authoring agent, never a different session that happens to
    // share the directory.
    const authoring = (await g.session()).authoredBy;
    const { out } = await hook("stop", { session_id: authoring, cwd: g.dir });
    const decision = JSON.parse(out);
    expect(decision.decision).toBe("block");
    expect(decision.reason).toContain("plan-editor respond");
  });

  test("Stop does not hold an unrelated project hostage", async () => {
    const { out } = await hook("stop", { session_id: "other", cwd: "/tmp" });
    expect(out.trim()).toBe("");
  });

  test("a session that shares the directory but did not author it is not blocked", async () => {
    const { out } = await hook("stop", { session_id: "sess-1", cwd: g.dir });
    expect(out.trim()).toBe("");
  });

  test("Stop stops blocking once the review is answered", async () => {
    await g.cli(["respond", g.file, "--summary", "Done."]);
    const authoring = (await g.session()).authoredBy;
    const { out } = await hook("stop", { session_id: authoring, cwd: g.dir });
    expect(out.trim()).toBe("");
  });
});
