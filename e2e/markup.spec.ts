// The markup phase: everything the human does before anything crosses to the
// agent. Driven with real clicks and real keystrokes into the sandboxed frame.

import { expect, test } from "@playwright/test";
import { artifactFrame, boot, PLAN_HTML, setAnnotate, targetHint, waitForArtifact, type Harness } from "./harness.ts";

let h: Harness;
test.beforeAll(async () => {
  h = await boot({ name: "plan.html", content: PLAN_HTML });
});
test.afterAll(async () => {
  await h.dispose();
});

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 240)));
  page.on("console", (m) => { if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 240)); });
  await page.goto(h.url);
  await waitForArtifact(page);
});

test("clicking an element arms a note, and the panel says what it is pinned to", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#idea-p").click();
  await expect(targetHint(page)).toContainText("Pinned to");
  await expect(artifactFrame(page).locator("#idea-p")).toHaveClass(/pe-pending/);
});

test("clicking the same element again un-selects it", async ({ page }) => {
  await setAnnotate(page, true);
  const target = artifactFrame(page).locator("#idea-p");
  await target.click();
  await expect(targetHint(page)).toContainText("Pinned to");
  await target.click();
  await expect(targetHint(page)).toContainText("Nothing selected");
  await expect(target).not.toHaveClass(/pe-pending/);
});

test("Escape inside the artifact clears the selection", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#risks-p").click();
  await expect(targetHint(page)).toContainText("Pinned to");
  await artifactFrame(page).locator("body").press("Escape");
  await expect(targetHint(page)).toContainText("Nothing selected");
});

test("the Clear selection button un-selects", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#risks-p").click();
  await page.locator("#clearTarget").click();
  await expect(targetHint(page)).toContainText("Nothing selected");
  await expect(artifactFrame(page).locator("#risks-p")).not.toHaveClass(/pe-pending/);
});

test("leaving annotate mode drops the selection and cleans the document", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#scope-p").click();
  await setAnnotate(page, false);
  await expect(targetHint(page)).toContainText("Nothing selected");
  // The mark must not outlive the mode that produced it.
  const outlined = await artifactFrame(page)
    .locator("#scope-p")
    .evaluate((el) => getComputedStyle(el).outlineStyle === "dashed");
  expect(outlined).toBe(false);
});

test("shift-click builds one note covering several elements, and again removes one", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#idea-p").click();
  await artifactFrame(page).locator("#scope-p").click({ modifiers: ["Shift"] });
  await expect(targetHint(page)).toContainText("2 elements");
  await artifactFrame(page).locator("#scope-p").click({ modifiers: ["Shift"] });
  await expect(targetHint(page)).toContainText("Pinned to");
});

test("a note reaches the draft and is private until sent", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#risks-p").click();
  await page.locator("#input").fill("Say what happens when the classifier is wrong.");
  await page.locator("#addNote").click();
  await expect(page.locator(".card")).toHaveCount(1);

  const session = await h.session();
  const draft = session.reviews.find((r: any) => r.status === "drafting");
  expect(draft.items).toHaveLength(1);
  expect(draft.items[0].body).toContain("classifier is wrong");

  // Nothing has crossed: a poll must still find nothing.
  const polled = await h.cli(["poll", h.file, "--timeout-ms", "300"]);
  expect(polled.json.status).toBe("waiting");
});

test("the draft survives a reload, because it lives on the server", async ({ page }) => {
  await page.reload();
  await waitForArtifact(page);
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator(".card").first()).toContainText("classifier is wrong");
});

test("a note with nothing selected applies to the page as a whole", async ({ page }) => {
  await setAnnotate(page, true);
  await expect(targetHint(page)).toContainText("Nothing selected");
  await page.locator("#input").fill("The whole thing is too long.");
  await page.locator("#addNote").click();
  await expect(page.locator(".card")).toHaveCount(2);

  const draft = (await h.session()).reviews.find((r: any) => r.status === "drafting");
  expect(draft.items.some((i: any) => i.tag === "page")).toBe(true);
});

test("selecting text anchors to the selection rather than the whole element", async ({ page }) => {
  await setAnnotate(page, true);
  // A real drag, which is how a selection is actually made: the click that ends
  // the drag is the one the SDK reads the selection from. Setting a selection
  // programmatically and then clicking does not work, and correctly so — the
  // mousedown of a separate click collapses it first.
  const box = (await artifactFrame(page).locator("#milestones-p").boundingBox())!;
  const y = box.y + 8;
  await page.mouse.move(box.x + 4, y);
  await page.mouse.down();
  await page.mouse.move(box.x + 120, y, { steps: 15 });
  await page.mouse.up();

  await expect(targetHint(page)).toContainText("Pinned to");
  await page.locator("#input").fill("Reword this opener.");
  await expect(page.locator("#addNote")).toBeEnabled();
  await page.locator("#addNote").click();
  await page.waitForTimeout(500);

  const draft = (await h.session()).reviews.find((r: any) => r.status === "drafting");
  const item = draft.items.find((i: any) => i.body === "Reword this opener.");
  expect(item.tag).toBe("text");
  expect(item.text.length).toBeLessThan(60);
});

test("a draft note can be removed", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#last-p").click();
  await page.waitForTimeout(250);
  await page.locator("#input").fill("A note that will be removed.");
  await expect(page.locator("#addNote")).toBeEnabled();
  await page.locator("#addNote").click();

  const card = page.locator(".card", { hasText: "A note that will be removed." });
  await expect(card).toHaveCount(1);
  await card.locator("[data-drop]").click();
  await expect(card).toHaveCount(0);
});

test("suggest mode proposes exact replacement text and restores the document", async ({ page }) => {
  const frame = artifactFrame(page);
  await page.locator("#suggest").click();
  await expect(page.locator("#suggest")).toHaveAttribute("aria-pressed", "true");

  const original = await frame.locator("#scope-p").textContent();
  await frame.locator("#scope-p").click();
  await page.waitForTimeout(300);
  await frame.locator("#scope-p").evaluate((el) => {
    (el as HTMLElement).textContent = "We should reuse the existing queue.";
    el.dispatchEvent(new FocusEvent("focusout", { bubbles: true }));
  });
  await page.waitForTimeout(600);

  const draft = (await h.session()).reviews.find((r: any) => r.status === "drafting");
  const verbatim = draft.items.find((i: any) => i.tag === "verbatim");
  expect(verbatim).toBeTruthy();
  expect(verbatim.replacement).toBe("We should reuse the existing queue.");
  expect(verbatim.text).toContain("leverage");

  // The human is proposing, not editing: the document must go back.
  await expect(frame.locator("#scope-p")).toHaveText(original!);
  expect(await h.read()).toContain("leverage");
});

test("a structural gesture sends the operation, not prose", async ({ page }) => {
  await page.locator("#structural").selectOption("delete");
  await artifactFrame(page).locator("#budget-p").click();
  await page.waitForTimeout(500);

  const draft = (await h.session()).reviews.find((r: any) => r.status === "drafting");
  const structural = draft.items.find((i: any) => i.tag === "structural");
  expect(structural).toBeTruthy();
  expect(structural.op.kind).toBe("delete");
});

test("Lock this marks a region do-not-touch", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#budget-p").click();
  await page.locator("#lockTarget").click();
  await page.locator("#lockLabel").fill("The budget number");
  await page.locator("[data-confirm-lock]").click();
  await page.waitForTimeout(500);

  const session = await h.session();
  expect(session.locks).toHaveLength(1);
  expect(session.locks[0].label).toBe("The budget number");
});
