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

const note = (body: string, selector = "#a") => ({ body, selector, text: "anchor text", tag: "element" as const });

describe("SessionStore — sessions", () => {
  test("opening the same file twice keeps one session, one token", async () => {
    const store = await freshStore();
    const canonical = await canonicalFile(artifact);
    const first = await store.open(canonical);
    const second = await store.open(canonical);
    assert.equal(first.key, second.key);
    assert.equal(first.token, second.token, "token must stay stable so open tabs keep access");
    assert.equal((await store.list()).length, 1);
  });

  test("sessions are independent files, so one project cannot clobber another", async () => {
    const store = await freshStore();
    const other = path.join(dir, "other.html");
    await writeFile(other, "<h1>other</h1>");
    const a = await store.open(await canonicalFile(artifact));
    const b = await store.open(await canonicalFile(other));

    await Promise.all([store.addItems(a.key, [note("a")]), store.addItems(b.key, [note("b")])]);

    assert.equal((await store.read(a.key))?.reviews[0]?.items.length, 1);
    assert.equal((await store.read(b.key))?.reviews[0]?.items.length, 1);
  });

  test("concurrent note additions do not lose any", async () => {
    // `await read` … `await write` without a queue means two handlers read the
    // same snapshot and the second write silently discards the first.
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));

    await Promise.all(Array.from({ length: 25 }, (_, index) => store.addItems(session.key, [note(`note ${index}`)])));

    const items = (await store.read(session.key))?.reviews[0]?.items ?? [];
    assert.equal(items.length, 25, "every concurrent addition must survive");
    assert.equal(new Set(items.map((item) => item.body)).size, 25, "none may be overwritten by a stale snapshot");
  });

  test("sessionKey is stable and path-derived", () => {
    assert.equal(sessionKey("/tmp/a.html"), sessionKey("/tmp/a.html"));
    assert.notEqual(sessionKey("/tmp/a.html"), sessionKey("/tmp/b.html"));
  });
});

describe("the markup phase is private", () => {
  test("notes accumulate in a draft the agent cannot see", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));

    await store.addItems(session.key, [note("first"), note("second")]);
    await store.setDraftNote(session.key, "cut this by a third");

    assert.equal(await store.pendingReview(session.key), null, "a draft must never reach the agent");
    const draft = (await store.read(session.key))?.reviews[0];
    assert.equal(draft?.status, "drafting");
    assert.equal(draft?.items.length, 2);
    assert.equal(draft?.note, "cut this by a third");
  });

  test("a draft survives a reload — it is server state, not browser state", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    await store.addItems(session.key, [note("keep me")]);

    const reread = new SessionStore(store.dir.replace(/\/sessions$/, ""));
    assert.equal((await reread.read(session.key))?.reviews[0]?.items[0]?.body, "keep me");
  });

  test("notes can be removed while drafting", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    const created = await store.addItems(session.key, [note("mistake"), note("keeper")]);
    await store.removeItem(session.key, created![0]!.id);

    const items = (await store.read(session.key))?.reviews[0]?.items ?? [];
    assert.equal(items.length, 1);
    assert.equal(items[0]?.body, "keeper");
  });

  test("sending is the one moment anything crosses to the agent", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    await store.addItems(session.key, [note("do this")]);
    await store.setDraftNote(session.key, "overall guidance");

    const sent = await store.sendReview(session.key);
    assert.equal(sent?.status, "sent");
    assert.equal(sent?.note, "overall guidance", "the overall note travels with the review");
    assert.equal(sent?.items[0]?.status, "sent");

    const pending = await store.pendingReview(session.key);
    assert.equal(pending?.id, sent?.id);
  });

  test("an empty review cannot be sent", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    assert.equal(await store.sendReview(session.key), null);
  });

  test("a review with only an overall note can be sent", async () => {
    // "The tone is too hedged throughout" is a complete review on its own.
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    await store.setDraftNote(session.key, "the tone is too hedged throughout");
    assert.equal((await store.sendReview(session.key))?.status, "sent");
  });

  test("new notes after sending start a fresh draft", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    await store.addItems(session.key, [note("round one")]);
    await store.sendReview(session.key);
    await store.addItems(session.key, [note("round two")]);

    const stored = await store.read(session.key);
    assert.equal(stored?.reviews.length, 2);
    assert.equal(stored?.reviews[0]?.status, "sent");
    assert.equal(stored?.reviews[1]?.status, "drafting");
  });
});

describe("the agent's response", () => {
  async function sentSession() {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    const created = await store.addItems(session.key, [note("one"), note("two")]);
    await store.sendReview(session.key);
    return { store, key: session.key, ids: created!.map((item) => item.id) };
  }

  test("the morph marks touched items answered", async () => {
    const { store, key, ids } = await sentSession();
    await store.applyMorphReport(key, { addressed: [ids[0]!], orphaned: [] });

    const items = (await store.read(key))?.reviews[0]?.items ?? [];
    assert.equal(items[0]?.status, "answered");
    assert.equal(items[0]?.outcome, "applied");
    assert.equal(items[1]?.status, "sent", "an untouched item is still with the agent");
  });

  test("responding answers everything the agent did not speak to", async () => {
    // Silence would otherwise leave items stuck with no way for the human to act.
    const { store, key } = await sentSession();
    const review = await store.respondToReview(key, "tightened both, dropped a heading");

    assert.equal(review?.status, "answered");
    assert.equal(review?.summary, "tightened both, dropped a heading");
    assert.ok(review?.items.every((item) => item.status === "answered"));
  });

  test("an agent can flag one item rather than guessing", async () => {
    const { store, key, ids } = await sentSession();
    await store.answerItem(key, ids[0]!, "needs-call", "two of your notes contradict here");

    const item = (await store.read(key))?.reviews[0]?.items[0];
    assert.equal(item?.outcome, "needs-call");
    assert.equal(item?.agentNote, "two of your notes contradict here");
  });

  test("responding does not overwrite an outcome the agent already set", async () => {
    const { store, key, ids } = await sentSession();
    await store.answerItem(key, ids[0]!, "skipped", "conflicts with the overall note");
    await store.respondToReview(key, "done");

    assert.equal((await store.read(key))?.reviews[0]?.items[0]?.outcome, "skipped");
  });
});

describe("the human's verdict", () => {
  async function answeredSession() {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    const created = await store.addItems(session.key, [note("one"), note("two")]);
    await store.sendReview(session.key);
    await store.respondToReview(session.key, "done");
    return { store, key: session.key, ids: created!.map((item) => item.id) };
  }

  test("accepting settles an item", async () => {
    const { store, key, ids } = await answeredSession();
    await store.setItemVerdict(key, ids[0]!, "accepted");
    assert.equal((await store.read(key))?.reviews[0]?.items[0]?.status, "accepted");
  });

  test("a review closes once every item has a verdict", async () => {
    const { store, key, ids } = await answeredSession();
    await store.setItemVerdict(key, ids[0]!, "accepted");
    assert.notEqual((await store.read(key))?.reviews[0]?.status, "closed");
    await store.setItemVerdict(key, ids[1]!, "accepted");
    assert.equal((await store.read(key))?.reviews[0]?.status, "closed");
  });

  test("rejecting carries the reason into the next review", async () => {
    // A rejection the agent never hears about is the worst possible outcome.
    const { store, key, ids } = await answeredSession();
    await store.setItemVerdict(key, ids[0]!, "rejected", "that made it worse");
    const moved = await store.requeueRejected(key);

    assert.equal(moved, 1);
    const draft = (await store.read(key))?.reviews.find((review) => review.status === "drafting");
    assert.equal(draft?.items.length, 1);
    assert.match(draft!.items[0]!.body, /previously rejected: that made it worse/);
  });

  test("requeueing twice does not duplicate the item", async () => {
    const { store, key, ids } = await answeredSession();
    await store.setItemVerdict(key, ids[0]!, "rejected", "no");
    await store.requeueRejected(key);
    await store.requeueRejected(key);

    const draft = (await store.read(key))?.reviews.find((review) => review.status === "drafting");
    assert.equal(draft?.items.length, 1);
  });
});

describe("housekeeping", () => {
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

  test("a record written before reviews existed still loads", async () => {
    const store = await freshStore();
    const session = await store.open(await canonicalFile(artifact));
    const file = path.join(store.dir, `${session.key}.json`);
    await writeFile(
      file,
      JSON.stringify({ ...session, reviews: undefined, annotations: [{ id: "old", body: "legacy" }] }),
    );

    const loaded = await store.read(session.key);
    assert.deepEqual(loaded?.reviews, [], "legacy annotations are dropped rather than crashing the read");
  });
});
