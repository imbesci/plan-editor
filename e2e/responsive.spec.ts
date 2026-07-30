// The panel at small window sizes.
//
// There were no breakpoints at all, so the toolbar's min-content width pushed
// the whole grid past the viewport and the drawers collapsed into a wall of
// unlabelled bars. Every assertion here is something that was visibly wrong.

import { expect, test } from "@playwright/test";
import { boot, PLAN_HTML, waitForArtifact, type Harness } from "./harness.ts";

let h: Harness;
test.beforeAll(async () => {
  h = await boot({ name: "plan.html", content: PLAN_HTML });
  await h.api("/contract", { method: "POST", body: { text: "Never use the word 'leverage'." } });
  await h.api("/locks", { method: "POST", body: { selector: "#budget-p", text: "The budget", label: "Budget" } });
  await h.api("/items", {
    method: "POST",
    body: { items: [{ body: "Tighten this section.", selector: "#risks-p", text: "The classifier is the whole design." }] },
  });
});
test.afterAll(async () => {
  await h.dispose();
});

const WIDTHS = [1440, 1180, 1024, 900, 820, 720, 620];

for (const width of WIDTHS) {
  test(`the layout never scrolls sideways at ${width}px`, async ({ page }) => {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(h.url);
    await waitForArtifact(page);

    const overflow = await page.evaluate(() => ({
      scrollWidth: document.documentElement.scrollWidth,
      clientWidth: document.documentElement.clientWidth,
    }));
    // The Send button used to be clipped off the right edge before the artifact
    // was even uncomfortable.
    expect(overflow.scrollWidth).toBeLessThanOrEqual(overflow.clientWidth + 1);

    // Every toolbar control stays inside the window, wrapping if it must.
    const escaped = await page.evaluate(() => {
      const limit = document.documentElement.clientWidth + 1;
      return [...document.querySelectorAll(".bar button, .bar .toggle, .bar select")].filter(
        (el) => el.getBoundingClientRect().right > limit,
      ).length;
    });
    expect(escaped).toBe(0);
  });
}

test("the toolbar stays on one row at desktop widths", async ({ page }) => {
  // Adding one control to the bar took its content from 993px to 1129px against
  // 1128px available — it wrapped by a single pixel, and nothing caught it: the
  // overflow test above passes happily, because wrapping is how the bar avoids
  // overflowing. A second toolbar row costs the artifact height across the full
  // width of the app, permanently, which is worse than whatever the control was
  // added for.
  // Below roughly 1340px the bar genuinely cannot hold its controls on one line
  // and wrapping is the designed behaviour — that was true before the Document
  // button existed too. These are the widths where one row is achievable.
  for (const width of [1680, 1500, 1400]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(h.url);
    await waitForArtifact(page);

    // Measured by height, not by counting distinct child offsets: the controls
    // have different heights and are vertically centred, so their `top` values
    // differ *within* a single row. Counting those reports five rows for a bar
    // that has one, which is a test that fails on a correct layout.
    const bar = await page.evaluate(() => {
      const el = document.querySelector(".bar")!;
      const style = getComputedStyle(el);
      const padding = parseFloat(style.paddingTop) + parseFloat(style.paddingBottom);
      const tallest = Math.max(...[...el.children].map((child) => child.getBoundingClientRect().height));
      return { height: el.getBoundingClientRect().height, oneRow: tallest + padding };
    });
    // +4 for the border and sub-pixel rounding; a second row costs ~33px, so
    // there is no ambiguity between the two cases.
    expect(bar.height, `the toolbar wrapped at ${width}px`).toBeLessThanOrEqual(bar.oneRow + 4);
  }
});

test("the drawers stay separated and legible as the panel narrows", async ({ page }) => {
  for (const width of [1440, 1024, 900, 720]) {
    await page.setViewportSize({ width, height: 900 });
    await page.goto(h.url);
    await waitForArtifact(page);

    const drawers = await page.evaluate(() => {
      const boxes = [...document.querySelectorAll(".drawer")].map((el) => {
        const summary = el.querySelector("summary")!.getBoundingClientRect();
        const style = getComputedStyle(el);
        return { top: el.getBoundingClientRect().top, summaryHeight: summary.height, marginTop: parseFloat(style.marginTop) };
      });
      return boxes;
    });

    // The standing contract and the locks. The document navigator used to be a
    // third drawer here and is now a popover in the toolbar.
    expect(drawers.length).toBeGreaterThanOrEqual(2);
    for (const drawer of drawers) {
      // A header squeezed to a sliver is unreadable — this is what three
      // unlabelled grey bars looked like.
      expect(drawer.summaryHeight).toBeGreaterThanOrEqual(28);
      expect(drawer.marginTop).toBeGreaterThan(0);
    }
  }
});

test("the review list keeps a usable height with every drawer open", async ({ page }) => {
  await page.setViewportSize({ width: 1024, height: 800 });
  await page.goto(h.url);
  await waitForArtifact(page);

  await page.evaluate(() => {
    for (const drawer of document.querySelectorAll<HTMLDetailsElement>(".drawer")) drawer.open = true;
  });
  await page.waitForTimeout(400);

  const listHeight = await page.evaluate(() => document.querySelector("#list")!.getBoundingClientRect().height);
  // It collapsed to a few pixels: the notes, the point of the panel, squeezed
  // into a sliver between two headers.
  expect(listHeight).toBeGreaterThan(100);
});

test("below the breakpoint the panel stacks under the artifact", async ({ page }) => {
  await page.setViewportSize({ width: 760, height: 900 });
  await page.goto(h.url);
  await waitForArtifact(page);

  const { panel, stage } = await page.evaluate(() => ({
    panel: document.querySelector(".panel")!.getBoundingClientRect(),
    stage: document.querySelector(".stage")!.getBoundingClientRect(),
  }));
  expect(Math.round(panel.width)).toBe(Math.round(stage.width));
  expect(panel.top).toBeGreaterThan(stage.top);

  // Send stays reachable without scrolling the panel to the bottom first.
  await expect(page.locator("#send")).toBeInViewport();
});
