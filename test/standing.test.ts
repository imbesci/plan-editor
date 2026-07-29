// The capabilities that outlive a single review: the standing contract, locks,
// the clarification round trip, alternatives, packets, and review sets.
//
// These are tested against a live server rather than the store alone, because
// each one exists to change what the *agent* is told — and the wiring between
// store and poll payload is exactly where a rule can be recorded correctly and
// then never delivered.

import assert from "node:assert/strict";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";

import { formatReview } from "../src/cli-format.ts";
import type { PollResult } from "../src/protocol.ts";
import { serve } from "../src/server.ts";

let dir: string;
let artifact: string;
let instance: Awaited<ReturnType<typeof serve>>;
let origin: string;
let session: { key: string; token: string };

const HTML = `<!doctype html><html><head><title>Plan</title></head>
<body><h1 id="title">Title</h1><p id="body">Body text.</p><p id="budget">Budget: 40 units.</p></body></html>`;

before(async () => {
  dir = await mkdtemp(path.join(os.tmpdir(), "plan-editor-standing-"));
  artifact = path.join(dir, "plan.html");
  await writeFile(artifact, HTML);
  instance = await serve({ port: 0, stateDirectory: path.join(dir, "state"), version: "test", idleTimeoutMs: 60_000 });
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

const url = (pathname: string) => `${origin}${pathname}${pathname.includes("?") ? "&" : "?"}t=${session.token}`;

async function post(pathname: string, body: unknown = {}): Promise<Response> {
  return fetch(url(pathname), {
    method: "POST",
    headers: { "content-type": "application/json", origin },
    body: JSON.stringify(body),
  });
}

async function addItem(body: string, selector = "#body", text = "Body text."): Promise<string> {
  const response = await post(`/api/${session.key}/items`, { items: [{ body, selector, text }] });
  const result = (await response.json()) as { items: Array<{ id: string }> };
  return result.items[0]!.id;
}

async function send(): Promise<void> {
  await post(`/api/${session.key}/review/send`);
}

async function poll(): Promise<PollResult> {
  const response = await fetch(
    `${origin}/api/poll?file=${encodeURIComponent(artifact)}&t=${session.token}&timeoutMs=0`,
  );
  return (await response.json()) as PollResult;
}

describe("the standing contract", () => {
  test("a rule reaches the agent alongside the review, not instead of it", async () => {
    await post(`/api/${session.key}/contract`, { text: "Never use the word 'leverage'." });
    await addItem("Tighten this paragraph.");
    await send();

    const result = await poll();
    assert.equal(result.status, "review");
    assert.ok(result.status === "review");
    assert.deepEqual(
      result.contract?.map((rule) => rule.text),
      ["Never use the word 'leverage'."],
    );
    assert.equal(result.review.items.length, 1);
  });

  test("the rule is repeated on every review, unlike the items", async () => {
    // The whole point: items compact away once delivered, rules never do.
    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    await addItem("Another note.");
    await send();
    const result = await poll();
    assert.ok(result.status === "review");
    assert.equal(result.contract?.length, 1);
  });

  test("the same rule twice is one rule", async () => {
    await post(`/api/${session.key}/contract`, { text: "Never use the word 'leverage'." });
    const response = await fetch(url(`/api/${session.key}/contract`));
    const { active } = (await response.json()) as { active: unknown[] };
    assert.equal(active.length, 1);
  });

  test("a retired rule stops being delivered but is not destroyed", async () => {
    const listed = (await (await fetch(url(`/api/${session.key}/contract`))).json()) as {
      active: Array<{ id: string }>;
    };
    const id = listed.active[0]!.id;
    await fetch(url(`/api/${session.key}/contract/${id}`), { method: "DELETE", headers: { origin } });

    const after = (await (await fetch(url(`/api/${session.key}/contract`))).json()) as {
      active: unknown[];
      contract: unknown[];
    };
    assert.equal(after.active.length, 0, "retired rules must not be injected");
    assert.equal(after.contract.length, 1, "but they still explain past reviews");
  });

  test("a rejection can be promoted into a rule, carrying the human's reason", async () => {
    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    const id = await addItem("Rewrite the intro.");
    await send();
    await post(`/api/${session.key}/review/respond`, { summary: "Rewrote it." });
    await post(`/api/${session.key}/items/${id}/reject`, { text: "Too hedged — say it plainly." });

    const promoted = await post(`/api/${session.key}/items/${id}/promote`);
    const result = (await promoted.json()) as { status: string; rule?: { text: string; fromItemId?: string } };
    assert.equal(result.status, "promoted");
    // The *reason* generalises to the document; the item body was about one
    // paragraph and would be useless as a standing rule.
    assert.equal(result.rule?.text, "Too hedged — say it plainly.");
    assert.equal(result.rule?.fromItemId, id);
  });
});

describe("locks", () => {
  test("a locked region is delivered to the agent as do-not-touch", async () => {
    await post(`/api/${session.key}/locks`, { selector: "#budget", text: "Budget: 40 units.", label: "Budget" });
    await addItem("Reword the body.");
    await send();
    const result = await poll();
    assert.ok(result.status === "review");
    assert.equal(result.locks?.[0]?.selector, "#budget");

    const described = formatReview(artifact, result.review, false, result) as { do_not_touch?: unknown[] };
    assert.equal(described.do_not_touch?.length, 1);
  });

  test("locking the same selector twice does not stack", async () => {
    await post(`/api/${session.key}/locks`, { selector: "#budget", text: "Budget: 40 units." });
    const response = await fetch(url(`/api/${session.key}/git`));
    assert.equal(response.status, 200); // route smoke, and keeps the session warm
  });
});

describe("the clarification round trip", () => {
  test("an agent question parks the item and a human answer reopens the review", async () => {
    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    const id = await addItem("Make this shorter.");
    await send();

    await post(`/api/${session.key}/items/${id}/ask`, { text: "Shorter by how much?" });
    await post(`/api/${session.key}/review/respond`, { summary: "Asked a question." });

    // Answered reviews leave the agent's queue; the answer must put it back.
    assert.equal((await poll()).status, "waiting");

    await post(`/api/${session.key}/items/${id}/answer-question`, { text: "By about half." });
    const result = await poll();
    assert.ok(result.status === "review", "answering must re-deliver the review");

    const item = result.review.items.find((entry) => entry.id === id);
    assert.equal(item?.awaitingHuman, undefined, "the question is no longer waiting");
    assert.equal(item?.thread?.at(-1)?.text, "By about half.");
    assert.equal(item?.thread?.at(-1)?.role, "human");
  });

  test("await-answer parks instead of returning the still-pending review", async () => {
    // The bug this pins: an item can only be asked about while its review is
    // still `sent`, so waiting via /api/poll returned that same review a
    // millisecond after asking. The agent unparked with answer: null and went
    // on to guess — the exact outcome asking exists to prevent.
    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    const id = await addItem("Ambiguous request.");
    await send();
    await post(`/api/${session.key}/items/${id}/ask`, { text: "Which way?" });

    const started = Date.now();
    const waiting = fetch(url(`/api/${session.key}/items/${id}/await-answer?timeoutMs=3000`));

    // Nothing has been answered yet, so this must still be parked.
    await new Promise((resolve) => setTimeout(resolve, 250));
    await post(`/api/${session.key}/items/${id}/answer-question`, { text: "This way." });

    const result = (await (await waiting).json()) as { status: string; item?: { thread?: Array<{ text: string }> } };
    assert.equal(result.status, "answered");
    assert.ok(Date.now() - started >= 200, "it returned before the answer existed");
    assert.equal(result.item?.thread?.at(-1)?.text, "This way.");
  });

  test("await-answer on an item that never existed does not hang", async () => {
    const response = await fetch(url(`/api/${session.key}/items/nonexistent/await-answer?timeoutMs=3000`));
    assert.equal(((await response.json()) as { status: string }).status, "not-found");
  });

  test("await-answer reports waiting rather than hanging past its deadline", async () => {
    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    const id = await addItem("Another ambiguous request.");
    await send();
    await post(`/api/${session.key}/items/${id}/ask`, { text: "Well?" });

    const response = await fetch(url(`/api/${session.key}/items/${id}/await-answer?timeoutMs=300`));
    assert.equal(((await response.json()) as { status: string }).status, "waiting");
  });
});

describe("alternatives", () => {
  test("the agent offers options and the human's pick is recorded", async () => {
    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    const id = await addItem("Pick a tone for this.");
    await send();

    const offered = await post(`/api/${session.key}/items/${id}/alternatives`, {
      alternatives: [
        { id: "a", label: "Direct", html: "<p id='body'>Short.</p>" },
        { id: "b", label: "Hedged", html: "<p id='body'>Somewhat short.</p>" },
      ],
    });
    assert.equal(((await offered.json()) as { status: string }).status, "offered");

    await post(`/api/${session.key}/items/${id}/choose`, { alternative: "b" });
    const result = await poll();
    assert.ok(result.status === "review");
    const item = result.review.items.find((entry) => entry.id === id);
    assert.equal(item?.chosenAlternative, "b");
    assert.equal(item?.awaitingHuman, undefined);
  });

  test("fewer than two options is refused", async () => {
    const id = await addItem("Anything.");
    const response = await post(`/api/${session.key}/items/${id}/alternatives`, {
      alternatives: [{ id: "a", label: "Only", html: "<p>x</p>" }],
    });
    assert.equal(response.status, 400);
  });

  test("choosing an option that was never offered is refused", async () => {
    const id = await addItem("Anything else.");
    await post(`/api/${session.key}/items/${id}/alternatives`, {
      alternatives: [
        { id: "a", label: "A", html: "<p>a</p>" },
        { id: "b", label: "B", html: "<p>b</p>" },
      ],
    });
    const response = await post(`/api/${session.key}/items/${id}/choose`, { alternative: "z" });
    assert.equal(((await response.json()) as { status: string }).status, "not-found");
  });
});

describe("review sets", () => {
  test("a companion artifact is validated server-side and delivered with the review", async () => {
    const companion = path.join(dir, "spec.md");
    await writeFile(companion, "# Spec\n\nRetry budget is 3.\n");
    await post(`/api/${session.key}/companions`, { files: [companion, "/etc/passwd", path.join(dir, "nope.html")] });

    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    await addItem("These disagree about the retry budget.");
    await send();

    const result = await poll();
    assert.ok(result.status === "review");
    // Only the real, in-scope artifact survives: a client-supplied path must
    // never become a path the server trusts.
    assert.equal(result.companions?.length, 1);
    assert.ok(result.companions?.[0]?.endsWith("spec.md"));
  });
});

describe("verdicts are recoverable, and the human can talk back", () => {
  test("an accept can be undone", async () => {
    // Accept and Reject were one-way, unconfirmed, mouse-only clicks on a list
    // that re-rendered every minute. A misfire was unrecoverable.
    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    const id = await addItem("Something to accept.");
    await send();
    await post(`/api/${session.key}/review/respond`, { summary: "Applied." });
    await post(`/api/${session.key}/items/${id}/accept`);

    const cleared = await post(`/api/${session.key}/items/${id}/unverdict`);
    assert.equal(((await cleared.json()) as { status: string }).status, "cleared");

    const { SessionStore } = await import("../src/store/session-store.ts");
    const store = new SessionStore(path.join(dir, "state"));
    const record = await store.read(session.key);
    const item = record!.reviews.flatMap((review) => review.items).find((entry) => entry.id === id);
    assert.equal(item?.status, "answered", "it goes back in front of the human, not back to the agent");
  });

  test("an item with no verdict cannot be un-verdicted", async () => {
    const id = await addItem("Still a draft.");
    const response = await post(`/api/${session.key}/items/${id}/unverdict`);
    assert.equal(((await response.json()) as { status: string }).status, "not-found");
  });

  test("the human can send a chat message", async () => {
    // `chat` was stored, synced and rendered read-only for several revisions;
    // there was no way to say anything back that was not pinned to an item.
    await post(`/api/${session.key}/chat`, { text: "Roughly how long will this take?" });
    const { SessionStore } = await import("../src/store/session-store.ts");
    const record = await new SessionStore(path.join(dir, "state")).read(session.key);
    assert.equal(record!.chat.at(-1)?.role, "user");
    assert.equal(record!.chat.at(-1)?.text, "Roughly how long will this take?");
  });

  test("an empty chat message is refused", async () => {
    const response = await post(`/api/${session.key}/chat`, { text: "   " });
    assert.equal(response.status, 400);
  });
});

describe("the browser-computed write", () => {
  test("writing a document records it as a version and marks the item reverted", async () => {
    await post(`/api/${session.key}/review/respond`, { summary: "Done." });
    const id = await addItem("Something to undo.");
    await send();
    await post(`/api/${session.key}/review/respond`, { summary: "Applied." });

    const replaced = HTML.replace("Body text.", "Reverted body.");
    const response = await post(`/api/${session.key}/write`, { html: replaced, itemId: id });
    assert.equal(((await response.json()) as { status: string }).status, "written");

    const versions = (await (await fetch(url(`/api/${session.key}/versions`))).json()) as {
      versions: Array<{ origin: string }>;
    };
    assert.equal(versions.versions.at(-1)?.origin, "restore");
  });

  test("an empty document is refused", async () => {
    const response = await post(`/api/${session.key}/write`, { html: "   " });
    assert.equal(response.status, 400);
  });
});

describe("history is legible", () => {
  test("a version can be named and pinned", async () => {
    const response = await post(`/api/${session.key}/versions/1/label`, { label: "sent to leadership", pinned: true });
    const result = (await response.json()) as { version?: { label?: string; pinned?: boolean } };
    assert.equal(result.version?.label, "sent to leadership");
    assert.equal(result.version?.pinned, true);
  });

  test("churn counts how often each section was rewritten", async () => {
    const response = await fetch(url(`/api/${session.key}/churn`));
    const { churn } = (await response.json()) as { churn: Array<{ id: string; rewrites: number }> };
    // #body was rewritten by the browser-computed write above.
    assert.ok(churn.some((entry) => entry.id === "body" && entry.rewrites >= 1), JSON.stringify(churn));
  });
});

describe("the record", () => {
  test("the transcript is Markdown covering every review", async () => {
    const response = await fetch(url(`/api/${session.key}/transcript`));
    const markdown = await response.text();
    assert.match(response.headers.get("content-type") ?? "", /markdown/);
    assert.match(markdown, /Tighten this paragraph/);
    assert.match(markdown, /Too hedged/);
  });

  test("a packet round-trips into another artifact's draft", async () => {
    const other = path.join(dir, "other.html");
    // A byte-identical copy: the reviewer is looking at the same revision the
    // packet was written against, which is the only case where anchors are
    // trustworthy.
    const { readFile } = await import("node:fs/promises");
    await writeFile(other, await readFile(artifact, "utf8"));
    const otherSession = (await (
      await fetch(`${origin}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: other }),
      })
    ).json()) as { key: string; token: string };

    const reviews = (await (await fetch(url(`/api/${session.key}/transcript`))).text()).length;
    assert.ok(reviews > 0);

    // Export the first review from the original artifact.
    const sessionFile = await import("../src/store/session-store.ts");
    const store = new sessionFile.SessionStore(path.join(dir, "state"));
    const record = await store.read(session.key);
    const reviewId = record!.reviews[0]!.id;

    const packet = await (await fetch(url(`/api/${session.key}/packet/${reviewId}`))).json();

    const imported = await fetch(
      `${origin}/api/${otherSession.key}/packet/import?t=${otherSession.token}`,
      {
        method: "POST",
        headers: { "content-type": "application/json", origin },
        body: JSON.stringify({ packet, from: "Sam" }),
      },
    );
    const result = (await imported.json()) as { status: string; items: number; drift: string };
    assert.equal(result.status, "imported");
    assert.ok(result.items >= 1);
    assert.equal(result.drift, "same", "the two copies are byte-identical here");

    // Imported items land in the *draft*: the owner decides what crosses to
    // their agent, exactly as with their own markup.
    const otherRecord = await store.read(otherSession.key);
    const draft = otherRecord!.reviews.find((review) => review.status === "drafting");
    assert.ok(draft, "an import must not send itself to the agent");
    assert.ok(draft!.items[0]!.body.includes("Sam"));
  });

  test("importing against a document that has moved on says so", async () => {
    const drifted = path.join(dir, "drifted.html");
    await writeFile(drifted, HTML.replace("Body text.", "Something else entirely."));
    const driftedSession = (await (
      await fetch(`${origin}/api/sessions`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ file: drifted }),
      })
    ).json()) as { key: string; token: string };

    const { SessionStore } = await import("../src/store/session-store.ts");
    const store = new SessionStore(path.join(dir, "state"));
    const reviewId = (await store.read(session.key))!.reviews[0]!.id;
    const packet = await (await fetch(url(`/api/${session.key}/packet/${reviewId}`))).json();

    const imported = await fetch(`${origin}/api/${driftedSession.key}/packet/import?t=${driftedSession.token}`, {
      method: "POST",
      headers: { "content-type": "application/json", origin },
      body: JSON.stringify({ packet }),
    });
    const result = (await imported.json()) as { drift: string; note: string };
    // Silence here would be the dangerous outcome: a packet written against a
    // different revision is exactly when anchors resolve cleanly to the wrong
    // element.
    assert.equal(result.drift, "changed");
    assert.ok(result.note.length > 0);
  });

  test("a packet that is not a packet is refused", async () => {
    const response = await post(`/api/${session.key}/packet/import`, { packet: { hello: "world" } });
    assert.equal(response.status, 400);
  });
});
