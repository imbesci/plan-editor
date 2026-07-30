// History, the navigator, and the record — the parts that read the session
// rather than change the document.

import { expect, test } from "@playwright/test";
import { artifactFrame, boot, PLAN_HTML, waitForArtifact, type Harness } from "./harness.ts";

let h: Harness;
test.beforeAll(async () => {
  h = await boot({ name: "plan.html", content: PLAN_HTML });
  // Three distinct versions to scrub through.
  const base = await h.read();
  await h.write(base.replace("three attempts", "five attempts"));
  await new Promise((r) => setTimeout(r, 900));
  await h.write((await h.read()).replace("Ship the classifier first", "Ship the split budget first"));
  await new Promise((r) => setTimeout(r, 900));
});
test.afterAll(async () => {
  await h.dispose();
});

test.beforeEach(async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);
});

test("history lists every version and can name and pin one", async ({ page }) => {
  await page.locator("#history").click();
  await expect(page.locator("#overlay")).toBeVisible();
  await expect(page.locator("#overlay .versions .version")).toHaveCount(3);

  await page.locator("#overlay [data-name]").last().click();
  await page.locator("#overlay input").first().fill("sent to leadership");
  await page.locator("#overlay input").first().press("Enter");
  await page.waitForTimeout(700);

  const versions = (await h.api("/versions")).body.versions;
  expect(versions.some((v: any) => v.label === "sent to leadership")).toBe(true);

  await page.locator("#overlay [data-pin]").first().click();
  await page.waitForTimeout(700);
  expect((await h.api("/versions")).body.versions.some((v: any) => v.pinned)).toBe(true);
});

test("any two versions can be compared, not just against current", async ({ page }) => {
  await page.locator("#history").click();
  const versions = page.locator("#overlay .versions .version");
  await versions.nth(0).locator("[data-a]").click();
  await versions.nth(1).locator("[data-b]").click();
  // The strip is newest-first, so nth(0)/nth(1) is the newest pair. The point is
  // that an arbitrary pair can be compared, not that it is against current.
  await expect(page.locator("#diffPane")).toContainText(/v\d+ → v\d+/, { timeout: 10_000 });
});

test("restoring a version writes it back and is itself recorded", async ({ page }) => {
  const beforeCount = (await h.api("/versions")).body.versions.length;
  await page.locator("#history").click();
  // The oldest version — the newest is already current, so there is nothing to
  // restore to.
  await page.locator("#overlay .versions [data-pick]").last().click();
  await page.waitForTimeout(800);
  await page.locator("#diffPane [data-restore]").click();
  await page.waitForTimeout(1500);

  expect(await h.read()).toContain("three attempts");
  const after = (await h.api("/versions")).body.versions;
  expect(after.length).toBeGreaterThan(beforeCount);
  expect(after[after.length - 1].origin).toBe("restore");
});

test("undo restores the previous version through the same path", async ({ page }) => {
  const before = await h.read();
  await page.locator("#undo").click();
  await page.waitForTimeout(1500);
  expect(await h.read()).not.toBe(before);
});

test("closing history leaves the live document, never a preview", async ({ page }) => {
  await page.locator("#history").click();
  await page.locator("#overlay .versions [data-pick]").last().click();
  await page.waitForTimeout(600);
  await page.locator("#overlay [data-close]").first().click();
  await page.waitForTimeout(900);
  const live = await artifactFrame(page).locator("#budget-p").textContent();
  expect(live).toBe((await h.read()).match(/<p id="budget-p">([^<]*)</)![1]);
});

test("churn names the sections that keep being rewritten", async ({ page }) => {
  const churn = (await h.api("/churn")).body.churn;
  expect(Array.isArray(churn)).toBe(true);
  await page.locator("#history").click();
  await expect(page.locator("#overlay")).toContainText("rewritten", { timeout: 10_000 });
});

test("the navigator lists the document's sections and finds text in it", async ({ page }) => {
  // It lives in the top bar now, as a popover: it is the one part of the review
  // panel that was never about the review, and it was taking vertical space from
  // the notes.
  await page.locator("#navToggle").click();
  await expect(page.locator("#outline")).toContainText("The idea", { timeout: 10_000 });
  await expect(page.locator("#outline")).toContainText("Risks");

  await page.locator("#find").fill("classifier");
  await page.waitForTimeout(900);
  await expect(page.locator("#findCount")).toContainText(/\d/);
});

test("clicking an outline entry scrolls the artifact to it", async ({ page }) => {
  await page.locator("#navToggle").click();
  await page.locator("#outline [data-section]").last().click();
  await page.waitForTimeout(900);
  const scrolled = await artifactFrame(page).locator("body").evaluate(() => window.scrollY);
  expect(scrolled).toBeGreaterThan(0);
});

test("the record sheet offers the transcript, packets and git", async ({ page }) => {
  await page.locator("#record").click();
  await expect(page.locator("#overlay")).toBeVisible();
  await expect(page.locator("#overlay")).toContainText(/transcript/i);
  await expect(page.locator("#overlay")).toContainText(/packet/i);
  await expect(page.locator("#overlay")).toContainText(/git/i);
});

test("the transcript is real Markdown covering the session", async () => {
  const response = await fetch(`http://127.0.0.1:${h.port}/api/${h.key}/transcript?t=${h.token}`);
  const markdown = await response.text();
  expect(response.headers.get("content-type")).toContain("markdown");
  expect(markdown).toContain("# Review record");
});

test("the standing contract can be added to and retired from the panel", async ({ page }) => {
  await page.locator("#standingPanel").click();
  await page.locator("#ruleInput").fill("Keep sections under 200 words.");
  await page.locator("#addRule").click();
  await expect(page.locator("#contractList")).toContainText("under 200 words", { timeout: 10_000 });

  const active = (await h.api("/contract")).body.active;
  expect(active).toHaveLength(1);

  await page.locator("#contractList [data-retire-rule]").first().click();
  await page.waitForTimeout(800);
  expect((await h.api("/contract")).body.active).toHaveLength(0);
  // Retired, not destroyed — it still explains the reviews it shaped.
  expect((await h.api("/contract")).body.contract).toHaveLength(1);
});
