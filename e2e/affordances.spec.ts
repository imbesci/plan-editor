// The controls added to make the panel usable without already knowing it.
//
// Everything here is in the class of bug this suite exists for: a palette that
// renders and does not run, a grip that is not draggable, a shortcut that dies
// the moment focus enters the artifact. All of them typecheck, all of them pass
// the node:test suite, and every one of them reads to a human as "it does not
// work".

import { expect, test } from "@playwright/test";
import { artifactFrame, boot, PLAN_HTML, setAnnotate, waitForArtifact, type Harness } from "./harness.ts";

let h: Harness;
test.beforeAll(async () => {
  h = await boot({ name: "plan.html", content: PLAN_HTML });
});
test.afterAll(async () => {
  await h.dispose();
});

test.beforeEach(async ({ page }) => {
  page.on("pageerror", (e) => console.log("  [pageerror]", String(e).slice(0, 240)));
  page.on("console", (m) => {
    if (m.type() === "error") console.log("  [console.error]", m.text().slice(0, 240));
  });
  await page.goto(h.url);
  await waitForArtifact(page);
});

test("the palette opens on ⌘K, filters, and actually runs the command", async ({ page }) => {
  await page.keyboard.press("Meta+k");
  await expect(page.locator("#paletteInput")).toBeVisible();

  // Subsequence matching, so a half-remembered name still finds it.
  await page.locator("#paletteInput").fill("annot");
  await expect(page.locator(".palette-row").first()).toContainText(/[Aa]nnotate/);

  await page.keyboard.press("Enter");
  await expect(page.locator("#overlay")).toBeHidden();
  // The command ran, rather than merely being listed.
  await expect(page.locator("#modeToggle")).toBeChecked();
});

test("⌘K works from inside the artifact, where every shortcut used to die", async ({ page }) => {
  // The two documents cannot see each other's key events, so a chrome binding is
  // dead from the moment the human clicks the document — which is the first thing
  // they do. Only ⌘I was ever relayed.
  await artifactFrame(page).locator("#idea-p").click();
  await page.keyboard.press("Meta+k");
  await expect(page.locator("#paletteInput")).toBeVisible();
});

test("the palette can jump the document to a section", async ({ page }) => {
  await page.keyboard.press("Meta+k");
  await page.locator("#paletteInput").fill("last section");
  const row = page.locator(".palette-row").first();
  await expect(row).toContainText("Last section");
  await row.click();
  await expect(page.locator("#overlay")).toBeHidden();
  // The section is only reachable by scrolling: the fixture is deliberately
  // taller than the viewport.
  await expect
    .poll(async () => artifactFrame(page).locator("#last").evaluate((el) => el.getBoundingClientRect().top), {
      timeout: 8_000,
    })
    .toBeLessThan(900);
});

test("the panel can be dragged wider, and remembers", async ({ page }) => {
  const width = () => page.locator("#panel").evaluate((el) => el.getBoundingClientRect().width);
  const before = await width();

  const grip = page.locator("#panelGrip");
  const box = (await grip.boundingBox())!;
  await page.mouse.move(box.x + box.width / 2, box.y + box.height / 2);
  await page.mouse.down();
  // Leftwards widens it: the panel is on the right.
  await page.mouse.move(box.x - 160, box.y + box.height / 2, { steps: 12 });
  await page.mouse.up();

  const after = await width();
  expect(after).toBeGreaterThan(before + 80);

  await page.reload();
  await waitForArtifact(page);
  expect(Math.abs((await width()) - after)).toBeLessThan(12);
});

test("double-clicking the grip puts the panel back", async ({ page }) => {
  await page.locator("#panelGrip").dblclick();
  await expect(page.locator("#toasts")).toContainText("Panel width reset");
});

test("the word count is shown, because 'cut this by a third' is the commonest note", async ({ page }) => {
  await expect(page.locator("#metrics")).toBeVisible();
  await expect(page.locator("#metrics")).toContainText(/\d+ words/);
});

test("a half-written note survives a reload", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#scope-p").click();
  await page.locator("#input").fill("this sentence is doing two jobs");

  await page.reload();
  await waitForArtifact(page);

  // It is the only thing the human types that does not exist anywhere yet, and
  // it was the only thing a stray reload ate.
  await expect(page.locator("#input")).toHaveValue("this sentence is doing two jobs");
  await expect(page.locator("#toasts")).toContainText("never sent");
});

test("n starts a note from either document", async ({ page }) => {
  await artifactFrame(page).locator("#risks-p").click();
  await page.keyboard.press("n");
  await expect(page.locator("#input")).toBeFocused();
});

test("ending with unsent notes asks first", async ({ page }) => {
  await setAnnotate(page, true);
  await artifactFrame(page).locator("#budget-p").click();
  await page.locator("#input").fill("say why three");
  await page.locator("#addNote").click();
  await expect(page.locator(".card")).toHaveCount(1);

  await page.locator("#end").click();
  // The notes are not destroyed — the draft is on the server — but the agent is
  // told to stop, so work the human was about to send goes nowhere.
  await expect(page.locator("#overlay")).toContainText("not been sent");
  await page.locator("[data-close]").first().click();
  await expect(page.locator("#overlay")).toBeHidden();
  // Still there, and the session is still open.
  await expect(page.locator(".card")).toHaveCount(1);
  await expect(page.locator("#end")).toBeEnabled();
});

test("an artifact that cannot hold an anchor says so, where the human can act on it", async () => {
  // Its own session: the advice is about the document, and the shared fixture is
  // deliberately compliant.
  const bare = await boot({
    name: "bare.html",
    content: `<!doctype html><html><head><title>Bare</title></head>
      <body><h1>No ids anywhere</h1><p>Notes here will lose their place.</p></body></html>`,
  });
  try {
    const findings = await bare.api("/doctor");
    expect(findings.status).toBe(200);
    expect(findings.body.findings.some((f: { rule: string }) => f.rule === "no-ids-at-all")).toBe(true);
  } finally {
    await bare.dispose();
  }
});

// --- the document navigator, now a popover in the top bar --------------------
//
// A drawer needed no dismissal; a popover needs three, and it overlays the
// document it is describing. Each of these is a way to leave it that a human will
// reach for, and any one of them missing leaves a panel floating over the page.

test("the navigator opens from the top bar and lists the document's sections", async ({ page }) => {
  await expect(page.locator("#navPanel")).toBeHidden();
  await expect(page.locator("#outlineCount")).toHaveText(/\d/);
  await page.locator("#navToggle").click();
  await expect(page.locator("#navPanel")).toBeVisible();
  await expect(page.locator("#outline")).toContainText("Risks");
});

test("it closes on Escape, on a click away, and on picking a section", async ({ page }) => {
  await page.locator("#navToggle").click();
  await expect(page.locator("#navPanel")).toBeVisible();
  await page.keyboard.press("Escape");
  await expect(page.locator("#navPanel")).toBeHidden();

  await page.locator("#navToggle").click();
  await expect(page.locator("#navPanel")).toBeVisible();
  // Anywhere in the chrome that is not the navigator itself.
  await page.locator("#phaseTitle").click();
  await expect(page.locator("#navPanel")).toBeHidden();

  await page.locator("#navToggle").click();
  await page.locator("#outline [data-section]").first().click();
  // The point of the click was to look at the document underneath it.
  await expect(page.locator("#navPanel")).toBeHidden();
});

test("/ still opens it and focuses find, from inside the artifact", async ({ page }) => {
  await artifactFrame(page).locator("#idea-p").click();
  await page.keyboard.press("/");
  await expect(page.locator("#navPanel")).toBeVisible();
  await expect(page.locator("#find")).toBeFocused();
});

test("moving it out of the panel gives the notes back their space", async ({ page }) => {
  // The reason for the move, measured. With the navigator still in the panel and
  // every drawer open, the notes list sat pinned to its 132px floor at every
  // window height up to 1100px — the floor is the only thing that stopped it
  // becoming a sliver. Without it the list clears the floor: 189px measured here.
  await page.setViewportSize({ width: 1024, height: 1100 });
  await page.goto(h.url);
  await waitForArtifact(page);
  await page.evaluate(() => {
    for (const drawer of document.querySelectorAll<HTMLDetailsElement>(".drawer")) drawer.open = true;
  });
  await page.waitForTimeout(300);

  // Structural, and true at every height: the outline is no longer competing for
  // the panel's vertical space at all.
  expect(await page.locator("#panel #outline").count()).toBe(0);
  expect(await page.locator("#panel .drawer").count()).toBe(2);

  const listHeight = await page.locator("#list").evaluate((el) => el.getBoundingClientRect().height);
  expect(listHeight).toBeGreaterThan(132);
});

test("the popover never widens the page, at any width", async ({ page }) => {
  for (const width of [1440, 900, 620]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(h.url);
    await waitForArtifact(page);
    await page.locator("#navToggle").click();
    await expect(page.locator("#navPanel")).toBeVisible();
    // An absolutely-positioned child still counts toward scrollWidth.
    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);
  }
});
