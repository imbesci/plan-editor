import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { canonicalFile, SessionStore, sessionKey } from "../src/store/session-store.ts";

let dir: string;
let artifact: string;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plan-editor-store-"));
  artifact = path.join(dir, "plan.html");
  await writeFile(artifact, "<h1>plan</h1>");
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function freshStore(): Promise<SessionStore> {
  const store = new SessionStore(await mkdtemp(path.join(dir, "state-")));
  await store.init();
  return store;
}

describe("SessionStore", () => {
  test("opening the same file twice keeps one session, one token", async () => {
    const store = await freshStore();
    const canonical = await canonicalFile(artifact);
    const first = await store.open(canonical);
    const second = await store.open(canonical);
    assert.equal(first.key, second.key);
    assert.equal(first.token, second.token, "token must stay stable so open tabs keep access");
    assert.equal((await store.list()).length, 1);
  });

  test("concurrent submits do not lose annotations", async () => {
    // The bug this store exists to prevent: with `await read` ... `await write`
    // and no queue, two concurrent handlers read the same snapshot and the
    // second write discards the first's annotation.
    const store = await freshStore();
    const canonical = await canonicalFile(artifact);
    const session = await store.open(canonical);

    const submissions = Array.from({ length: 25 }, (_, index) =>
      store.addAnnotations(session.key, [
        { body: `edit ${index}`, selector: `#s${index}`, text: "", tag: "element" as const },
      ]),
    );
    await Promise.all(submissions);

    const stored = await store.read(session.key);
    assert.equal(stored?.annotations.length, 25, "every concurrent submit must survive");
    const bodies = new Set(stored?.annotations.map((entry) => entry.body));
    assert.equal(bodies.size, 25, "no annotation may be overwritten by a stale snapshot");
  });

  test("a concurrent end and submit both land", async () => {
    const store = await freshStore();
    const canonical = await canonicalFile(artifact);
    const session = await store.open(canonical);
    await Promise.all([
      store.addAnnotations(session.key, [{ body: "late edit", selector: "", text: "", tag: "element" }]),
      store.end(session.key, "user"),
    ]);
    const stored = await store.read(session.key);
    assert.equal(stored?.status, "ended");
    assert.equal(stored?.annotations.length, 1, "an in-flight submit must not be dropped by the end");
  });

  test("sessions are independent files, so one project cannot clobber another", async () => {
    const store = await freshStore();
    const other = path.join(dir, "other.html");
    await writeFile(other, "<h1>other</h1>");
    const a = await store.open(await canonicalFile(artifact));
    const b = await store.open(await canonicalFile(other));

    await Promise.all([
      store.addAnnotations(a.key, [{ body: "a", selector: "", text: "", tag: "element" }]),
      store.addAnnotations(b.key, [{ body: "b", selector: "", text: "", tag: "element" }]),
    ]);

    assert.equal((await store.read(a.key))?.annotations.length, 1);
    assert.equal((await store.read(b.key))?.annotations.length, 1);
  });

  test("morph report marks addressed and orphaned annotations", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    const created = await store.addAnnotations(session.key, [
      { body: "one", selector: "#a", text: "", tag: "element" },
      { body: "two", selector: "#b", text: "", tag: "element" },
      { body: "three", selector: "#c", text: "", tag: "element" },
    ]);
    assert.ok(created);
    const [one, two, three] = created;

    await store.applyMorphReport(session.key, { addressed: [one!.id], orphaned: [two!.id] });

    const stored = await store.read(session.key);
    const byId = new Map(stored?.annotations.map((entry) => [entry.id, entry.status]));
    assert.equal(byId.get(one!.id), "addressed");
    assert.equal(byId.get(two!.id), "orphaned");
    assert.equal(byId.get(three!.id), "submitted", "untouched annotations stay open");
  });

  test("openAnnotations returns only submitted ones", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    const created = await store.addAnnotations(session.key, [
      { body: "open", selector: "", text: "", tag: "element" },
      { body: "done", selector: "", text: "", tag: "element" },
    ]);
    await store.setAnnotationStatus(session.key, created![1]!.id, "addressed");
    const open = await store.openAnnotations(session.key);
    assert.equal(open.length, 1);
    assert.equal(open[0]?.body, "open");
  });

  test("state survives a torn write attempt (atomic rename)", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    await store.addAnnotations(session.key, [{ body: "keep me", selector: "", text: "", tag: "element" }]);
    // Reading immediately after a write must always yield parseable JSON; a
    // truncate-in-place write could expose a partial document here.
    for (let i = 0; i < 20; i += 1) {
      void store.addChat(session.key, "agent", `tick ${i}`);
    }
    const stored = await store.read(session.key);
    assert.ok(stored, "session file must always parse");
  });

  test("prune drops old ended sessions only", async () => {
    const store = await freshStore();
    const openSession = await store.open(await canonicalFile(artifact));
    const other = path.join(dir, "prunable.html");
    await writeFile(other, "<h1>x</h1>");
    const endedSession = await store.open(await canonicalFile(other));
    await store.end(endedSession.key, "agent");

    const removed = await store.prune(0, Date.now() + 1000);
    assert.equal(removed, 1);
    assert.ok(await store.read(openSession.key), "open sessions are never pruned");
    assert.equal(await store.read(endedSession.key), null);
  });

  test("sessionKey is stable and path-derived", () => {
    assert.equal(sessionKey("/tmp/a.html"), sessionKey("/tmp/a.html"));
    assert.notEqual(sessionKey("/tmp/a.html"), sessionKey("/tmp/b.html"));
  });
});
