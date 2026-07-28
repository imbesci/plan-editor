import assert from "node:assert/strict";
import { mkdir, mkdtemp, rm, symlink, writeFile } from "node:fs/promises";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { serve } from "../src/server.ts";

/** fetch cannot set Host, so header-guard tests need the raw client. */
function rawStatus(options: { path: string; headers: Record<string, string> }): Promise<number> {
  return new Promise((resolve, reject) => {
    const request = http.request(
      { host: "127.0.0.1", port: instance.port, path: options.path, headers: options.headers },
      (response) => {
        response.resume();
        resolve(response.statusCode ?? 0);
      },
    );
    request.on("error", reject);
    request.end();
  });
}

let dir: string;
let artifact: string;
let instance: Awaited<ReturnType<typeof serve>>;
let origin: string;
let session: { key: string; token: string; url: string };

const ARTIFACT_HTML = `<!doctype html><html><head><title>Plan</title></head>
<body><h1 id="title">Original title</h1><p id="body">Original body.</p></body></html>`;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plan-editor-server-"));
  artifact = path.join(dir, "plan.html");
  await writeFile(artifact, ARTIFACT_HTML);
  instance = await serve({
    port: 0,
    stateDirectory: path.join(dir, "state"),
    version: "test",
    idleTimeoutMs: 60_000,
  });
  origin = `http://127.0.0.1:${instance.port}`;
  const response = await fetch(`${origin}/api/sessions`, {
    method: "POST",
    headers: { "content-type": "application/json" },
    body: JSON.stringify({ file: artifact }),
  });
  session = (await response.json()) as typeof session;
});

after(async () => {
  await instance.shutdown();
  await rm(dir, { recursive: true, force: true });
});

const withToken = (pathname: string) => `${origin}${pathname}${pathname.includes("?") ? "&" : "?"}t=${session.token}`;

describe("session creation", () => {
  test("returns a capability token, not just a key", () => {
    assert.ok(session.token.length >= 30, "token must be long enough to resist guessing");
    assert.ok(session.url.includes(session.token));
  });

  test("refuses a non-HTML path", async () => {
    const secret = path.join(dir, "secret.txt");
    await writeFile(secret, "top secret");
    const response = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: secret }),
    });
    assert.equal(response.status, 400, "arbitrary paths must be rejected server-side, not just in the CLI");
  });

  test("refuses a directory", async () => {
    const response = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: dir }),
    });
    assert.equal(response.status, 400);
  });
});

describe("authorization", () => {
  test("the session key alone does not grant artifact access", async () => {
    // The key is sha256(path) — offline-computable. It must never be sufficient.
    const response = await fetch(`${origin}/artifact/${session.key}/index.html`);
    assert.equal(response.status, 403);
  });

  test("a wrong token is refused", async () => {
    const response = await fetch(`${origin}/artifact/${session.key}/index.html?t=wrong`);
    assert.equal(response.status, 403);
  });

  test("the correct token serves the artifact with the SDK injected", async () => {
    const response = await fetch(withToken(`/artifact/${session.key}/index.html`));
    assert.equal(response.status, 200);
    const html = await response.text();
    assert.match(html, /<script src="\/sdk\.js" defer><\/script>/);
    assert.match(html, /Original title/);
  });

  test("the raw route serves unmodified HTML for morphing", async () => {
    const response = await fetch(withToken(`/artifact/${session.key}/raw`));
    const html = await response.text();
    assert.equal(html, ARTIFACT_HTML, "morph payload must not carry a second SDK tag");
  });

  test("a foreign Host header is rejected (DNS rebinding)", async () => {
    // Must use http.request: fetch treats Host as a forbidden header and strips
    // it, so a fetch-based version of this test would pass without ever sending
    // the hostile header.
    const status = await rawStatus({
      path: `/artifact/${session.key}/index.html?t=${session.token}`,
      headers: { Host: "evil.example.com" },
    });
    assert.equal(status, 403);
  });

  test("a legitimate Host is still accepted", async () => {
    const status = await rawStatus({
      path: `/artifact/${session.key}/index.html?t=${session.token}`,
      headers: { Host: `127.0.0.1:${instance.port}` },
    });
    assert.equal(status, 200, "the guard must not reject the host the server actually runs on");
  });

  test("a cross-origin write is refused", async () => {
    const response = await fetch(withToken(`/api/${session.key}/annotations`), {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example.com" },
      body: JSON.stringify({ annotations: [{ body: "x", tag: "element" }] }),
    });
    assert.equal(response.status, 403);
  });
});

describe("asset confinement", () => {
  test("serves a sibling asset", async () => {
    await writeFile(path.join(dir, "style.css"), "body{color:red}");
    const response = await fetch(withToken(`/artifact/${session.key}/style.css`));
    assert.equal(response.status, 200);
  });

  test("rejects traversal", async () => {
    const response = await fetch(withToken(`/artifact/${session.key}/../../etc/passwd`));
    assert.ok(response.status === 403 || response.status === 404, `expected refusal, got ${response.status}`);
  });

  test("rejects a symlink escaping the artifact directory", async () => {
    // lavish-axi had a realpath guard on its export path but not on the serving
    // path, so a symlink planted next to an artifact leaked any file.
    // The secret must live OUTSIDE the artifact's own directory for this to test
    // anything — a sibling of the artifact is legitimately in scope.
    const siteDir = path.join(dir, "site");
    await mkdir(siteDir, { recursive: true });
    const nested = path.join(siteDir, "nested.html");
    await writeFile(nested, "<html><body>nested</body></html>");
    const secret = path.join(dir, "outside-secret.txt");
    await writeFile(secret, "SENSITIVE");
    await symlink(secret, path.join(siteDir, "escape.css"));

    const created = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: nested }),
    });
    const nestedSession = (await created.json()) as { key: string; token: string };

    const response = await fetch(
      `${origin}/artifact/${nestedSession.key}/escape.css?t=${nestedSession.token}`,
    );
    const body = await response.text();
    assert.ok(!body.includes("SENSITIVE"), "a symlink out of the artifact dir must not be served");
    assert.equal(response.status, 403);
  });
});

describe("edit lifecycle", () => {
  test("submit -> poll -> morph report -> addressed", async () => {
    const submit = await fetch(withToken(`/api/${session.key}/annotations`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        annotations: [{ body: "Make the title punchier", selector: "#title", text: "Original title", tag: "element" }],
      }),
    });
    assert.equal(submit.status, 200);
    const created = (await submit.json()) as { annotations: Array<{ id: string; status: string }> };
    const id = created.annotations[0]!.id;
    assert.equal(created.annotations[0]!.status, "submitted");

    const poll = await fetch(`${origin}/api/poll?file=${encodeURIComponent(artifact)}&t=${session.token}&timeoutMs=0`);
    const result = (await poll.json()) as { status: string; annotations: Array<{ id: string; body: string }> };
    assert.equal(result.status, "feedback");
    assert.equal(result.annotations[0]?.body, "Make the title punchier");

    // Delivery must NOT delete the record — that is what made lavish-axi unable
    // to tell the human which edits had landed.
    const secondPoll = await fetch(
      `${origin}/api/poll?file=${encodeURIComponent(artifact)}&t=${session.token}&timeoutMs=0`,
    );
    const again = (await secondPoll.json()) as { status: string };
    assert.equal(again.status, "feedback", "an undelivered-but-unaddressed edit stays open");

    await fetch(withToken(`/api/${session.key}/morph-report`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ addressed: [id], orphaned: [] }),
    });

    const settled = await fetch(
      `${origin}/api/poll?file=${encodeURIComponent(artifact)}&t=${session.token}&timeoutMs=0`,
    );
    assert.equal(((await settled.json()) as { status: string }).status, "waiting");

    const stored = await instance.store.read(session.key);
    const annotation = stored?.annotations.find((entry) => entry.id === id);
    assert.equal(annotation?.status, "addressed");
    assert.ok(annotation?.addressedAt);
  });

  test("poll rejects a bad token", async () => {
    const response = await fetch(`${origin}/api/poll?file=${encodeURIComponent(artifact)}&t=nope&timeoutMs=0`);
    assert.equal(response.status, 403);
  });

  test("oversized annotation bodies are rejected", async () => {
    const response = await fetch(withToken(`/api/${session.key}/annotations`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ annotations: [{ body: "x".repeat(9000), tag: "element" }] }),
    });
    assert.equal(response.status, 400);
  });
});

describe("live patching", () => {
  test("editing the file emits a patch event over SSE", async () => {
    const controller = new AbortController();
    const response = await fetch(withToken(`/events/${session.key}`), { signal: controller.signal });
    const reader = response.body!.getReader();
    const decoder = new TextDecoder();

    const sawPatch = (async () => {
      const deadline = Date.now() + 5000;
      let buffer = "";
      while (Date.now() < deadline) {
        const { value, done } = await reader.read();
        if (done) break;
        buffer += decoder.decode(value, { stream: true });
        if (buffer.includes('"type":"patch"')) return true;
      }
      return false;
    })();

    await new Promise((resolve) => setTimeout(resolve, 250));
    await writeFile(artifact, ARTIFACT_HTML.replace("Original title", "Punchier title"));

    assert.equal(await sawPatch, true, "a file edit must push a patch event, not a reload");
    controller.abort();
  });
});
