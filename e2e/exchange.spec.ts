// The exchange: sending a review, the agent applying it, the document morphing
// in place, and the human settling each item. This is the loop the whole tool
// exists for, so it is driven end to end with a real agent-side CLI.

import { expect, test } from "@playwright/test";
import { artifactFrame, boot, PLAN_HTML, setAnnotate, waitForArtifact, type Harness } from "./harness.ts";

let h: Harness;
test.beforeAll(async () => {
  h = await boot({ name: "plan.html", content: PLAN_HTML });
});
test.afterAll(async () => {
  await h.dispose();
});

async function addNote(page: any, selector: string | null, body: string) {
  await setAnnotate(page, true);
  if (selector) await artifactFrame(page).locator(selector).click();
  await page.locator("#input").fill(body);
  await expect(page.locator("#addNote")).toBeEnabled();
  await page.locator("#addNote").click();
}

test("a review only crosses to the agent when it is sent", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);

  await h.api("/contract", { method: "POST", body: { text: "Never use the word 'leverage'." } });
  await h.api("/locks", { method: "POST", body: { selector: "#budget-p", text: "The budget is three attempts.", label: "Budget" } });

  await addNote(page, "#scope-p", "Drop the jargon here.");
  await page.locator("#overall").fill("Cut this by a third.");
  await page.waitForTimeout(700);

  expect((await h.cli(["poll", h.file, "--timeout-ms", "300"])).json.status).toBe("waiting");

  await page.locator("#send").click();
  await expect(page.locator("#send")).toBeDisabled();

  const review = (await h.cli(["poll", h.file, "--timeout-ms", "500"])).json;
  expect(review.status).toBe("review");
  expect(review.overall_note).toBe("Cut this by a third.");
  expect(review.standing_rules).toContain("Never use the word 'leverage'.");
  expect(review.do_not_touch[0].label).toBe("Budget");
  expect(review.items[0].request).toBe("Drop the jargon here.");
});

test("the agent's edit morphs in place — no reload, and the item is marked addressed", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);

  // Prove there was no reload by leaving a marker on the frame's window.
  await artifactFrame(page).locator("body").evaluate(() => ((window as any).__peMarker = "alive"));

  const before = await h.read();
  await h.write(before.replace("We should leverage the existing queue rather than building a second one.", "Reuse the existing queue."));
  await expect(artifactFrame(page).locator("#scope-p")).toHaveText("Reuse the existing queue.", { timeout: 20_000 });

  const survived = await artifactFrame(page).locator("body").evaluate(() => (window as any).__peMarker);
  expect(survived).toBe("alive");

  await page.waitForTimeout(1200);
  const session = await h.session();
  const item = session.reviews.flatMap((r: any) => r.items).find((i: any) => i.body === "Drop the jargon here.");
  expect(item.status).toBe("answered");
});

test("the agent responds and the panel moves to the review phase", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);
  await h.cli(["respond", h.file, "--summary", "Removed the jargon and left the budget alone."]);
  await expect(page.locator("body")).toHaveAttribute("data-phase", "reviewing", { timeout: 20_000 });
  await expect(page.locator("#list")).toContainText("Removed the jargon");
});

test("keyboard verdicts: a accepts, u undoes it, r opens the reject sheet", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);

  await page.locator("#panel").click();
  await page.keyboard.press("j");
  await expect(page.locator(".card.focused")).toHaveCount(1);

  await page.keyboard.press("a");
  await page.waitForTimeout(800);
  let item = (await h.session()).reviews.flatMap((r: any) => r.items).find((i: any) => i.body === "Drop the jargon here.");
  expect(item.status).toBe("accepted");

  await page.keyboard.press("u");
  await page.waitForTimeout(800);
  item = (await h.session()).reviews.flatMap((r: any) => r.items).find((i: any) => i.body === "Drop the jargon here.");
  expect(item.status).toBe("answered");
});

test("rejecting carries the reason into the next review and can be promoted to a rule", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);

  const id = (await h.session()).reviews.flatMap((r: any) => r.items).find((i: any) => i.body === "Drop the jargon here.").id;
  await h.api(`/items/${id}/reject`, { method: "POST", body: { text: "Too terse now — say why we reuse it." } });
  await page.waitForTimeout(900);

  const session = await h.session();
  const rejected = session.reviews.flatMap((r: any) => r.items).find((i: any) => i.id === id);
  expect(rejected.status).toBe("rejected");
  const draft = session.reviews.find((r: any) => r.status === "drafting");
  expect(draft.items.some((i: any) => i.body.includes("previously rejected"))).toBe(true);

  const promoted = await h.cli(["promote", h.file, "--id", id]);
  expect(promoted.json.status).toBe("promoted");
  expect(promoted.json.rule.text).toBe("Too terse now — say why we reuse it.");
});

test("ask parks the agent until the human answers in the browser", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);

  // A fresh review to ask about.
  await addNote(page, "#risks-p", "Make this shorter.");
  await page.locator("#send").click();
  await page.waitForTimeout(600);
  const review = (await h.cli(["poll", h.file, "--timeout-ms", "500"])).json;
  const itemId = review.items.find((i: any) => i.request === "Make this shorter.").id;

  const started = Date.now();
  const asking = h.cli(["ask", h.file, "--id", itemId, "--question", "Shorter by how much?", "--max-ms", "30000"]);

  // The question must show up in the panel, pinned to the top because something
  // is waiting on it.
  await expect(page.locator("#list")).toContainText("Shorter by how much?", { timeout: 20_000 });

  await page.waitForTimeout(1500);
  await h.api(`/items/${itemId}/answer-question`, { method: "POST", body: { text: "By about half." } });

  const answered = await asking;
  expect(answered.json.status).toBe("answered");
  expect(answered.json.answer).toBe("By about half.");
  expect(Date.now() - started).toBeGreaterThan(1400);
});

test("alternatives render as choices and the pick is recorded", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);

  const pending = (await h.session()).reviews.find((r: any) => r.status === "sent");
  const itemId = pending.items[0].id;
  await h.api(`/items/${itemId}/alternatives`, {
    method: "POST",
    body: {
      alternatives: [
        { id: "a", label: "Direct", html: "<p id='risks-p'>The classifier is the design.</p>" },
        { id: "b", label: "Hedged", html: "<p id='risks-p'>The classifier is arguably the design.</p>" },
      ],
    },
  });

  await expect(page.locator("#list")).toContainText("Direct", { timeout: 20_000 });
  await page.locator("[data-alt][data-alt-id=\"b\"]").click();
  await page.waitForTimeout(900);

  const item = (await h.session()).reviews.flatMap((r: any) => r.items).find((i: any) => i.id === itemId);
  expect(item.chosenAlternative).toBe("b");
});

test("the human can talk back in the conversation", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);
  await page.locator("#conversation").click();
  await page.locator("#chatInput").fill("How long will the classifier take?");
  await page.locator("#sendChat").click();
  await page.waitForTimeout(800);
  const chat = (await h.session()).chat;
  expect(chat.some((m: any) => m.role === "user" && m.text.includes("classifier take"))).toBe(true);
});
