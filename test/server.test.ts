import assert from "node:assert/strict";
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from "node:fs/promises";
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

describe("shutdown", () => {
  test("the server reports when it has actually stopped", async () => {
    // Without this the detached process has no way to know it is done: the CLI
    // parked on a promise that never settled, so `stop` and every
    // version-driven restart closed the listener and left the process alive.
    // Because the code signature is part of the server's identity, that leaked
    // one process per edit to src/ — 48 were found running.
    const directory = await mkdtemp(path.join(os.tmpdir(), "plan-editor-shutdown-"));
    const other = await serve({ port: 0, stateDirectory: directory, version: "test", idleTimeoutMs: 60_000 });

    let stopped = false;
    void other.closed.then(() => (stopped = true));
    assert.equal(stopped, false, "it must not resolve while the server is up");

    await other.shutdown();
    await other.closed;
    assert.equal(stopped, true);

    await rm(directory, { recursive: true, force: true });
  });
});

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
    const response = await fetch(withToken(`/api/${session.key}/items`), {
      method: "POST",
      headers: { "content-type": "application/json", Origin: "https://evil.example.com" },
      body: JSON.stringify({ items: [{ body: "x", tag: "element" }] }),
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

describe("the two phases", () => {
  const note = (body: string) => ({ body, selector: "#title", text: "Original title", tag: "element" });

  async function addNote(body: string) {
    const response = await fetch(withToken(`/api/${session.key}/items`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [note(body)] }),
    });
    return ((await response.json()) as { items: Array<{ id: string }> }).items[0]!.id;
  }

  const poll = async () =>
    (await (
      await fetch(`${origin}/api/poll?file=${encodeURIComponent(artifact)}&t=${session.token}&timeoutMs=0`)
    ).json()) as { status: string; review?: { note: string; items: Array<{ body: string }> } };

  test("drafted notes are invisible to the agent", async () => {
    await addNote("first note");
    await addNote("second note");
    assert.equal((await poll()).status, "waiting", "a draft is the human's private workspace");
  });

  test("the overall note is stored while drafting", async () => {
    await fetch(withToken(`/api/${session.key}/review/note`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ note: "cut this by a third" }),
    });
    assert.equal((await poll()).status, "waiting");
  });

  test("sending hands over the whole review at once, note first", async () => {
    const sent = await fetch(withToken(`/api/${session.key}/review/send`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(sent.status, 200);

    const result = await poll();
    assert.equal(result.status, "review");
    assert.equal(result.review?.note, "cut this by a third");
    assert.equal(result.review?.items.length, 2, "both notes arrive together, not one at a time");
  });

  test("polling twice returns the same review — it is not consumed on delivery", async () => {
    assert.equal((await poll()).status, "review");
  });

  test("responding closes it and puts the work in front of the human", async () => {
    const response = await fetch(withToken(`/api/${session.key}/review/respond`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ summary: "tightened both" }),
    });
    assert.equal(((await response.json()) as { status: string }).status, "answered");
    assert.equal((await poll()).status, "waiting", "an answered review is no longer the agent's problem");

    const stored = await instance.store.read(session.key);
    const review = stored?.reviews.find((entry) => entry.summary === "tightened both");
    assert.ok(review?.items.every((item) => item.status === "answered"));
  });

  test("rejecting an item puts it back into the next review", async () => {
    const stored = await instance.store.read(session.key);
    const answered = stored!.reviews.flatMap((r) => r.items).find((item) => item.status === "answered")!;

    await fetch(withToken(`/api/${session.key}/items/${answered.id}/reject`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ text: "that made it worse" }),
    });

    const after = await instance.store.read(session.key);
    const draft = after?.reviews.find((review) => review.status === "drafting");
    assert.ok(draft, "a fresh draft is created to carry the rejection");
    assert.match(JSON.stringify(draft?.items), /that made it worse/);
  });

  test("an empty review is refused", async () => {
    const fresh = path.join(dir, "empty-review.html");
    await writeFile(fresh, ARTIFACT_HTML);
    const created = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: fresh }),
    });
    const other = (await created.json()) as { key: string; token: string };
    const response = await fetch(`${origin}/api/${other.key}/review/send?t=${other.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    assert.equal(response.status, 400);
  });
});

describe("versions, undo, and export", () => {
  test("opening a session snapshots the artifact", async () => {
    const response = await fetch(withToken(`/api/${session.key}/versions`));
    const { versions } = (await response.json()) as { versions: Array<{ seq: number; origin: string }> };
    assert.ok(versions.length >= 1);
    assert.equal(versions[0]?.origin, "open");
  });

  test("restore writes an old version back and is itself recorded", async () => {
    const before = (await (await fetch(withToken(`/api/${session.key}/versions`))).json()) as {
      versions: Array<{ seq: number }>;
    };
    const firstSeq = before.versions[0]!.seq;
    const original = await (await fetch(withToken(`/api/${session.key}/versions/${firstSeq}`))).text();

    await writeFile(artifact, ARTIFACT_HTML.replace("Original title", "Changed for restore"));
    await new Promise((resolve) => setTimeout(resolve, 400));

    const restore = await fetch(withToken(`/api/${session.key}/restore`), {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ seq: firstSeq }),
    });
    assert.equal(restore.status, 200);

    const onDisk = await readFile(artifact, "utf8");
    assert.equal(onDisk, original, "restoring writes the snapshot back to the artifact itself");

    const after = (await (await fetch(withToken(`/api/${session.key}/versions`))).json()) as {
      versions: Array<{ origin: string }>;
    };
    assert.equal(
      after.versions[after.versions.length - 1]?.origin,
      "restore",
      "the restore is itself a version, so undo is undoable",
    );
  });

  test("export strips the injected SDK", async () => {
    const response = await fetch(withToken(`/api/${session.key}/export`));
    const html = await response.text();
    assert.doesNotMatch(html, /sdk\.js/);
    assert.match(response.headers.get("content-disposition") ?? "", /attachment/);
  });

  test("version routes require the token", async () => {
    assert.equal((await fetch(`${origin}/api/${session.key}/versions`)).status, 403);
    assert.equal((await fetch(`${origin}/api/${session.key}/export`)).status, 403);
  });
});

describe("long-poll slicing", () => {
  // Its own artifact, so the shared session's leftover open edits from earlier
  // tests do not make every poll return immediately.
  let sliceFile: string;
  let sliceSession: { key: string; token: string };

  before(async () => {
    sliceFile = path.join(dir, "slice.html");
    await writeFile(sliceFile, ARTIFACT_HTML);
    const created = await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: sliceFile }),
    });
    sliceSession = (await created.json()) as typeof sliceSession;
  });

  test("a slice that expires returns waiting rather than erroring", async () => {
    // watch/poll issue many short requests instead of one long one, because a
    // single multi-minute request trips Bun's own fetch timeout and surfaced as
    // an unhandled TimeoutError that killed the command mid-wait.
    const response = await fetch(
      `${origin}/api/poll?file=${encodeURIComponent(sliceFile)}&t=${sliceSession.token}&timeoutMs=250`,
    );
    assert.equal(response.status, 200);
    assert.equal(((await response.json()) as { status: string }).status, "waiting");
  });

  test("a review sent mid-slice is returned by that slice", async () => {
    const pending = fetch(
      `${origin}/api/poll?file=${encodeURIComponent(sliceFile)}&t=${sliceSession.token}&timeoutMs=4000`,
    );
    await new Promise((resolve) => setTimeout(resolve, 150));
    await fetch(`${origin}/api/${sliceSession.key}/items?t=${sliceSession.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ items: [{ body: "mid-slice arrival", tag: "element" }] }),
    });
    // Adding a note must NOT wake it — only sending does.
    await fetch(`${origin}/api/${sliceSession.key}/review/send?t=${sliceSession.token}`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: "{}",
    });
    const result = (await (await pending).json()) as { status: string; review?: { items: Array<{ body: string }> } };
    assert.equal(result.status, "review", "the waiting slice must wake on send, not time out");
    assert.ok(result.review?.items.some((entry) => entry.body === "mid-slice arrival"));
  });
});
