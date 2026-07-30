// Resizing the note-entry area.
//
// The textarea always had the browser's native corner grip, but it is a few
// pixels wide, resizes only itself, and is forgotten on reload.

import { expect, test } from "@playwright/test";
import { boot, PLAN_HTML, waitForArtifact, type Harness } from "./harness.ts";

let h: Harness;
test.beforeAll(async () => {
  h = await boot({ name: "plan.html", content: PLAN_HTML });
});
test.afterAll(async () => {
  await h.dispose();
});

const sizes = (page: any) =>
  page.evaluate(() => ({
    composer: Math.round(document.getElementById("composer")!.getBoundingClientRect().height),
    input: Math.round(document.getElementById("input")!.getBoundingClientRect().height),
    list: Math.round(document.getElementById("list")!.getBoundingClientRect().height),
  }));

async function dragGrip(page: any, dy: number) {
  const grip = (await page.locator("#composerGrip").boundingBox())!;
  await page.mouse.move(grip.x + grip.width / 2, grip.y + grip.height / 2);
  await page.mouse.down();
  await page.mouse.move(grip.x + grip.width / 2, grip.y + dy, { steps: 15 });
  await page.mouse.up();
  await page.waitForTimeout(300);
}

test.beforeEach(async ({ page }) => {
  await page.setViewportSize({ width: 1280, height: 900 });
  await page.goto(h.url);
  await waitForArtifact(page);
  await page.evaluate(() => localStorage.removeItem("pe-composer-h"));
  await page.reload();
  await waitForArtifact(page);
});

test("the grip is a real, reachable control", async ({ page }) => {
  const grip = page.locator("#composerGrip");
  await expect(grip).toBeVisible();
  await expect(grip).toHaveAttribute("role", "separator");
  // Focusable, so it can be driven without a mouse.
  await grip.focus();
  expect(await page.evaluate(() => document.activeElement?.id)).toBe("composerGrip");
});

test("dragging up grows the entry area and the note field with it", async ({ page }) => {
  const before = await sizes(page);
  await dragGrip(page, -180);
  const after = await sizes(page);

  expect(after.composer).toBeGreaterThan(before.composer + 100);
  // The field absorbs the extra height rather than leaving dead space.
  expect(after.input).toBeGreaterThan(before.input + 100);
  expect(after.list).toBeLessThan(before.list);
});

test("the note list always keeps a usable height, however far you drag", async ({ page }) => {
  await dragGrip(page, -2000);
  const after = await sizes(page);
  expect(after.list).toBeGreaterThanOrEqual(120);
});

test("the entry area cannot be dragged shut", async ({ page }) => {
  await dragGrip(page, 2000);
  const after = await sizes(page);
  expect(after.composer).toBeGreaterThanOrEqual(130);
  await expect(page.locator("#send")).toBeVisible();
  await expect(page.locator("#input")).toBeVisible();
});

test("the size survives a reload", async ({ page }) => {
  await dragGrip(page, -160);
  const resized = await sizes(page);

  await page.reload();
  await waitForArtifact(page);
  const restored = await sizes(page);
  expect(restored.composer).toBe(resized.composer);
});

test("arrow keys resize it, and Escape restores the default", async ({ page }) => {
  const before = await sizes(page);
  await page.locator("#composerGrip").focus();
  await page.keyboard.press("ArrowUp");
  await page.keyboard.press("ArrowUp");
  await page.waitForTimeout(250);
  expect((await sizes(page)).composer).toBeGreaterThan(before.composer);

  await page.keyboard.press("Escape");
  await page.waitForTimeout(300);
  expect((await sizes(page)).composer).toBe(before.composer);
});

test("double-clicking the grip resets it to fit its content", async ({ page }) => {
  const before = await sizes(page);
  await dragGrip(page, -200);
  expect((await sizes(page)).composer).toBeGreaterThan(before.composer);

  await page.locator("#composerGrip").dblclick();
  await page.waitForTimeout(400);
  expect((await sizes(page)).composer).toBe(before.composer);
});

test("a resized area still sends a note correctly", async ({ page }) => {
  await dragGrip(page, -200);
  await page.locator("#input").fill("Written in the enlarged box.");
  await expect(page.locator("#addNote")).toBeEnabled();
  await page.locator("#addNote").click();
  await page.waitForTimeout(700);

  const draft = (await h.session()).reviews.find((r: any) => r.status === "drafting");
  expect(draft.items.some((i: any) => i.body === "Written in the enlarged box.")).toBe(true);
});
