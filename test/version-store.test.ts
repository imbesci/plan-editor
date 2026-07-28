import assert from "node:assert/strict";
import { mkdtemp, rm } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { MAX_VERSIONS, VersionStore } from "../src/store/version-store.ts";

let dir: string;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plan-editor-versions-"));
});

after(async () => {
  await rm(dir, { recursive: true, force: true });
});

async function freshStore(): Promise<VersionStore> {
  return new VersionStore(await mkdtemp(path.join(dir, "root-")));
}

describe("VersionStore", () => {
  test("records versions in order", async () => {
    const store = await freshStore();
    await store.snapshot("k", "<p>one</p>", "open");
    await store.snapshot("k", "<p>two</p>", "edit");

    const versions = await store.list("k");
    assert.deepEqual(
      versions.map((entry) => entry.seq),
      [1, 2],
    );
    assert.equal(versions[0]?.origin, "open");
    assert.equal(await store.read("k", 1), "<p>one</p>");
    assert.equal(await store.read("k", 2), "<p>two</p>");
  });

  test("ignores a write that did not change the content", async () => {
    // A touch that rewrites identical bytes must not create a version —
    // otherwise undo becomes a no-op the user has to press twice.
    const store = await freshStore();
    await store.snapshot("k", "<p>same</p>", "open");
    const second = await store.snapshot("k", "<p>same</p>", "edit");

    assert.equal(second, null);
    assert.equal((await store.list("k")).length, 1);
  });

  test("previousSeq points at the version undo should restore", async () => {
    const store = await freshStore();
    assert.equal(await store.previousSeq("k"), null, "nothing to undo with no history");
    await store.snapshot("k", "<p>one</p>", "open");
    assert.equal(await store.previousSeq("k"), null, "nothing to undo with a single version");
    await store.snapshot("k", "<p>two</p>", "edit");
    assert.equal(await store.previousSeq("k"), 1);
    await store.snapshot("k", "<p>three</p>", "edit");
    assert.equal(await store.previousSeq("k"), 2);
  });

  test("caps history oldest-first and deletes the dropped files", async () => {
    const store = await freshStore();
    for (let i = 0; i < MAX_VERSIONS + 5; i += 1) {
      await store.snapshot("k", `<p>${i}</p>`, "edit");
    }
    const versions = await store.list("k");
    assert.equal(versions.length, MAX_VERSIONS);
    assert.equal(versions[versions.length - 1]?.seq, MAX_VERSIONS + 5);
    assert.equal(await store.read("k", 1), null, "dropped snapshots are removed from disk, not just the index");
  });

  test("concurrent snapshots do not interleave", async () => {
    const store = await freshStore();
    await Promise.all(
      Array.from({ length: 15 }, (_, index) => store.snapshot("k", `<p>${index}</p>`, "edit")),
    );
    const versions = await store.list("k");
    assert.equal(versions.length, 15);
    assert.deepEqual(
      versions.map((entry) => entry.seq),
      Array.from({ length: 15 }, (_, index) => index + 1),
      "sequence numbers must be dense and ordered even under concurrency",
    );
  });

  test("keys are isolated from each other", async () => {
    const store = await freshStore();
    await store.snapshot("a", "<p>a</p>", "open");
    await store.snapshot("b", "<p>b</p>", "open");
    assert.equal((await store.list("a")).length, 1);
    assert.equal(await store.read("b", 1), "<p>b</p>");
  });

  test("reading a missing version returns null rather than throwing", async () => {
    const store = await freshStore();
    assert.equal(await store.read("nope", 7), null);
    assert.deepEqual(await store.list("nope"), []);
  });
});
