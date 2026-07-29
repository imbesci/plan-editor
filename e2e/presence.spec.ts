// Presence, the artifact switcher, and repointing a weak anchor.

import { expect, test } from "@playwright/test";
import { artifactFrame, boot, PLAN_HTML, waitForArtifact, type Harness } from "./harness.ts";

test.describe("presence and the switcher", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.html", content: PLAN_HTML });
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("the presence pill reports a connected agent after contact", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    // A hook heartbeat is what tells the browser an agent is alive; without it
    // a hook-delivered agent showed as "no agent" while receiving every review.
    await h.cli(["notify-contact"]);
    await expect(page.locator("#presence")).toContainText(/connected|listening|working/i, { timeout: 15_000 });
  });

  test("the switcher lists other open artifacts", async ({ page }) => {
    const other = await boot({ name: "second.html", content: PLAN_HTML });
    try {
      // Same server, so both sessions are visible to the switcher.
      await other.cli([other.file, "--no-open"]);
      await page.goto(h.url);
      await waitForArtifact(page);
      await page.locator("#switcher").click();
      await expect(page.locator("#overlay")).toContainText("plan.html", { timeout: 10_000 });
    } finally {
      await other.dispose();
    }
  });
});

test.describe("repointing", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.html", content: PLAN_HTML });
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("an orphaned note can be re-pointed by clicking a new target", async ({ page }) => {
    await h.api("/items", {
      method: "POST",
      body: { items: [{ body: "This needs a home.", selector: "#risks-p", text: "The classifier is the whole design." }] },
    });
    await h.api("/review/send", { method: "POST", body: {} });

    // Delete the anchored element outright, so the anchor cannot resolve at all.
    await h.write(PLAN_HTML.replace(/<section id="risks">[\s\S]*?<\/section>/, ""));
    await new Promise((r) => setTimeout(r, 1200));

    await page.goto(h.url);
    await waitForArtifact(page);
    await page.waitForTimeout(1500);

    const repoint = page.locator("[data-repoint]").first();
    await expect(repoint).toBeVisible({ timeout: 15_000 });
    await repoint.click();

    // The banner tells the human what to do, and Escape must get them out.
    await expect(page.locator("#list")).toContainText(/click/i);
    await artifactFrame(page).locator("#milestones-p").click();
    await page.waitForTimeout(1200);

    const item = (await h.session()).reviews.flatMap((r: any) => r.items)[0];
    expect(item.selector).toContain("milestones");
    expect(item.status).not.toBe("orphaned");
  });
});
