// The watcher must not be able to go deaf.
//
// A dropped filesystem event has the worst symptom available in this tool: the
// file changes, the browser never patches, and there is no error anywhere. It is
// also not theoretical — it is what this suite had been calling a flake, about one
// run in three under load and never once in isolation.
//
// So the native event is the delivery path and a slow `stat` is the safety net,
// and this is the test for the safety net. It cannot make the platform drop an
// event on demand, so it does the next best thing: closes the watcher outright,
// which is the most complete form of "the event will never arrive", and asserts
// that the change is still noticed.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { serve } from "../src/server.ts";

let dir: string;
let artifact: string;
let instance: Awaited<ReturnType<typeof serve>>;
let origin: string;
let session: { key: string; token: string };

const HTML = `<!doctype html><html><head><title>Plan</title></head>
<body><h1 id="title">Original</h1></body></html>`;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plan-editor-watcher-"));
  artifact = path.join(dir, "plan.html");
  await writeFile(artifact, HTML);
  instance = await serve({ port: 0, stateDirectory: path.join(dir, "state"), version: "test", idleTimeoutMs: 60_000 });
  origin = `http://127.0.0.1:${instance.port}`;
  session = (await (
    await fetch(`${origin}/api/sessions`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ file: artifact }),
    })
  ).json()) as typeof session;
});

after(async () => {
  await instance.shutdown();
  await rm(dir, { recursive: true, force: true });
});

async function versions(): Promise<Array<{ seq: number; origin: string }>> {
  const response = await fetch(`${origin}/api/${session.key}/versions?t=${session.token}`);
  return ((await response.json()) as { versions: Array<{ seq: number; origin: string }> }).versions;
}

async function waitForVersions(atLeast: number, timeoutMs: number): Promise<number> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const count = (await versions()).length;
    if (count >= atLeast || Date.now() > deadline) return count;
    await new Promise((resolve) => setTimeout(resolve, 50));
  }
}

describe("the artifact watcher", () => {
  test("an edit is recorded as a version", async () => {
    assert.equal((await versions()).length, 1, "opening snapshots the artifact");
    await writeFile(artifact, HTML.replace("Original", "Edited"));
    assert.equal(await waitForVersions(2, 6_000), 2);
  });

  test("a change is still noticed when no event ever arrives", async () => {
    const before_ = (await versions()).length;
    // The most complete possible form of a dropped event. Reaching into the
    // internals is the point: nothing a client can do simulates the platform
    // failing to tell us, and the reconciler exists for exactly that case.
    for (const watcher of instance.watchersForTest.values()) await watcher.close();

    await writeFile(artifact, HTML.replace("Original", "Edited with no event at all"));
    // Generously more than the reconcile interval: the assertion is that it is
    // noticed at all, not how fast — the fast path is the event.
    const count = await waitForVersions(before_ + 1, 10_000);
    assert.equal(count, before_ + 1, "a missed event must not mean a missed patch");

    const list = await versions();
    assert.equal(list[list.length - 1]?.origin, "edit");
  });
});
