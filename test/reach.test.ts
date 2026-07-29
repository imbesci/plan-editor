// Reach: the two things that took this tool off one file type and one client.
//
// Markdown artifacts — the agent edits the .md and the browser renders it, so
// the source of truth never leaves the format the human chose. And MCP, so an
// agent that is not Claude Code gets typed tools instead of shelling out and
// parsing prose from `next_step`.

import assert from "node:assert/strict";
import { mkdtemp, readFile, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { handleForTest, MCP_TOOL_NAMES } from "../src/mcp.ts";
import { serve } from "../src/server.ts";

let dir: string;
let markdown: string;
let instance: Awaited<ReturnType<typeof serve>>;
let origin: string;
let session: { key: string; token: string };

const SOURCE = `# Retry plan

Some opening prose.

## Risks

The budget is three attempts.
`;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plan-editor-reach-"));
  markdown = path.join(dir, "plan.md");
  await writeFile(markdown, SOURCE);
  instance = await serve({ port: 0, stateDirectory: path.join(dir, "state"), version: "test", idleTimeoutMs: 60_000 });
  origin = `http://127.0.0.1:${instance.port}`;
  const response = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: markdown }),
  });
  session = (await response.json()) as typeof session;
});

after(async () => {
  await instance.shutdown();
  await rm(dir, { recursive: true, force: true });
});

const url = (pathname: string) => `${origin}${pathname}?t=${session.token}`;

describe("markdown artifacts", () => {
  test("a .md file can be opened as an artifact", () => {
    assert.ok(session.key, "the server accepted a markdown path");
  });

  test("the frame is served rendered HTML with the SDK injected", async () => {
    const html = await (await fetch(url(`/artifact/${session.key}/index.html`))).text();
    assert.match(html, /<h1[^>]*>Retry plan<\/h1>/);
    assert.match(html, /src="\/sdk\.js"/);
  });

  test("the render carries stable ids, which is what makes anchors survive", async () => {
    const html = await (await fetch(url(`/artifact/${session.key}/raw`))).text();
    assert.match(html, /id="risks"/);
  });

  test("the source route reports line ranges, because a selector is useless to an agent editing markdown", async () => {
    const result = (await (await fetch(url(`/artifact/${session.key}/source`))).json()) as {
      format: string;
      blocks: Array<{ id: string; line: number; endLine: number }>;
    };
    assert.equal(result.format, "markdown");
    const risks = result.blocks.find((block) => block.id === "risks");
    assert.ok(risks, "the Risks section is mapped back to its source lines");
    assert.equal(SOURCE.split("\n")[risks!.line - 1], "## Risks");
  });

  test("the file on disk is never rewritten as HTML", async () => {
    // The one operation capable of corrupting the user's document is a lossy
    // HTML→Markdown round trip, so there isn't one.
    assert.equal(await readFile(markdown, "utf8"), SOURCE);
  });

  test("the browser cannot write rendered HTML back over the source", async () => {
    const response = await fetch(url(`/api/${session.key}/write`), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ html: "<h1>replaced</h1>" }),
    });
    assert.equal(response.status, 409);
    assert.equal(await readFile(markdown, "utf8"), SOURCE);
  });

  test("version history stores the source and renders it on the way out", async () => {
    const rendered = await (await fetch(url(`/api/${session.key}/versions/1`))).text();
    assert.match(rendered, /<h1/, "the browser needs HTML to morph");
    const versions = (await (await fetch(url(`/api/${session.key}/versions`))).json()) as {
      versions: Array<{ bytes: number }>;
    };
    assert.equal(versions.versions[0]!.bytes, Buffer.byteLength(SOURCE), "the snapshot is the markdown, not the render");
  });

  test("the agent is given source line ranges, not CSS selectors", async () => {
    // The selector is an artefact of the render. Handing it to an agent that is
    // about to open a .md file is handing it something it cannot act on.
    await fetch(url(`/api/${session.key}/items`), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({
        items: [{ body: "Reword this.", selector: "#risks", text: "The budget is three attempts." }],
      }),
    });
    await fetch(url(`/api/${session.key}/review/send`), {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: "{}",
    });

    const result = (await (
      await fetch(`${origin}/api/poll?file=${encodeURIComponent(markdown)}&t=${session.token}&timeoutMs=0`)
    ).json()) as { status: string; sourceLines?: Record<string, { line: number }> };
    assert.equal(result.status, "review");
    assert.equal(result.sourceLines?.risks?.line, 5);

    const { formatPollResult } = await import("../src/cli-format.ts");
    const described = formatPollResult(markdown, result as never) as { items: Array<Record<string, unknown>> };
    assert.equal(described.items[0]!.source, "plan.md:5-7");
    assert.equal(described.items[0]!.selector_hint, undefined);
  });

  test("export renders rather than copying the source", async () => {
    // An export is a standalone readable copy. Writing the markdown source into
    // a `.export.html` produced a file that opened as unformatted text.
    const exported = await (await fetch(url(`/api/${session.key}/export`))).text();
    assert.match(exported, /^<!doctype html>/i);
    assert.match(exported, /<h1[^>]*>Retry plan<\/h1>/);
    assert.doesNotMatch(exported, /^# Retry plan$/m);
  });

  test("doctor lints the render, not the raw markdown", async () => {
    // Linting the source as HTML reported `no-ids-at-all` on every .md file and
    // then advised adding `<section id="…">` to it — advice with no markup to
    // apply it to, on a file that was never broken.
    const { inspectArtifactSource } = await import("../src/doctor.ts");
    assert.deepEqual(inspectArtifactSource(markdown, SOURCE), []);
    assert.ok(
      inspectArtifactSource("plan.html", SOURCE).some((finding) => finding.severity === "error"),
      "the same bytes as HTML genuinely are broken",
    );
  });

  test("a non-artifact extension is still refused", async () => {
    const script = path.join(dir, "evil.sh");
    await writeFile(script, "#!/bin/sh\n");
    const response = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: script }),
    });
    assert.equal(response.status, 400);
  });
});

describe("the MCP server", () => {
  test("initialize reports the tool capability", async () => {
    const response = (await handleForTest({ jsonrpc: "2.0", id: 1, method: "initialize" })) as {
      result: { capabilities: { tools: unknown }; serverInfo: { name: string } };
    };
    assert.ok(response.result.capabilities.tools);
    assert.equal(response.result.serverInfo.name, "plan-editor");
  });

  test("a notification draws no response at all", async () => {
    // Replying to a notification is a protocol violation some clients treat as
    // a fatal stream error.
    assert.equal(await handleForTest({ jsonrpc: "2.0", method: "notifications/initialized" }), null);
  });

  test("tools/list exposes every tool with a schema", async () => {
    const response = (await handleForTest({ jsonrpc: "2.0", id: 2, method: "tools/list" })) as {
      result: { tools: Array<{ name: string; description: string; inputSchema: { type: string } }> };
    };
    assert.equal(response.result.tools.length, MCP_TOOL_NAMES.length);
    for (const tool of response.result.tools) {
      assert.ok(tool.description.length > 20, `${tool.name} needs a description an agent can act on`);
      assert.equal(tool.inputSchema.type, "object");
    }
  });

  test("the tools cover the whole loop, not just reading", () => {
    for (const name of ["open_artifact", "await_review", "respond_to_review", "ask_human", "offer_alternatives"]) {
      assert.ok(MCP_TOOL_NAMES.includes(name), `missing ${name}`);
    }
  });

  test("an unknown tool is a JSON-RPC error, not a crash", async () => {
    const response = (await handleForTest({
      jsonrpc: "2.0",
      id: 3,
      method: "tools/call",
      params: { name: "nope", arguments: {} },
    })) as { error: { code: number } };
    assert.equal(response.error.code, -32602);
  });

  test("a failing tool reports isError content rather than failing the call", async () => {
    // The agent should see the message and be able to recover, not have the
    // call fail underneath it.
    const response = (await handleForTest({
      jsonrpc: "2.0",
      id: 4,
      method: "tools/call",
      params: { name: "inspect_artifact", arguments: { file: path.join(dir, "does-not-exist.html") } },
    })) as { result: { isError?: boolean; content: Array<{ text: string }> } };
    assert.equal(response.result.isError, true);
    assert.ok(response.result.content[0]!.text.length > 0);
  });

  test("an unknown method is rejected without killing the stream", async () => {
    const response = (await handleForTest({ jsonrpc: "2.0", id: 5, method: "nonsense/method" })) as {
      error: { code: number };
    };
    assert.equal(response.error.code, -32601);
  });
});
