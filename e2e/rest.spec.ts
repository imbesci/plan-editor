// The remaining surface: surgical revert, weak anchors, bulk triage, the badge,
// the ended screen, theme relay, companions, packet import, and recovery from a
// server restart.

import { writeFile } from "node:fs/promises";
import path from "node:path";
import { expect, test } from "@playwright/test";
import { artifactFrame, boot, PLAN_HTML, setAnnotate, waitForArtifact, type Harness } from "./harness.ts";

async function sendNote(h: Harness, body: string, selector: string, text: string) {
  await h.api("/items", { method: "POST", body: { items: [{ body, selector, text }] } });
  await h.api("/review/send", { method: "POST", body: {} });
}

test.describe("surgical revert", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.html", content: PLAN_HTML });
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("rejecting can undo just that section, leaving the rest of the review", async ({ page }) => {
    await sendNote(h, "Tighten the risks.", "#risks-p", "The classifier is the whole design.");
    // The agent changes two things: the one asked about, and another.
    await h.write(
      PLAN_HTML.replace(
        "The classifier is the whole design. If it mislabels a transient failure we drop work silently.",
        "The classifier decides everything.",
      ).replace("Ship the classifier first, then the split budget.", "Ship the split budget first."),
    );
    await new Promise((r) => setTimeout(r, 1200));
    await h.cli(["respond", h.file, "--summary", "Tightened risks; also reordered milestones."]);

    await page.goto(h.url);
    await waitForArtifact(page);
    await expect(page.locator("body")).toHaveAttribute("data-phase", "reviewing");

    const id = (await h.session()).reviews.flatMap((r: any) => r.items).find((i: any) => i.body === "Tighten the risks.").id;
    await page.locator(`[data-reject="${id}"]`).click();
    await page.locator("#overlay textarea").fill("Too blunt — keep the caveat.");
    // The reject sheet offers to undo the change as well.
    const undoToggle = page.locator("#overlay input[type=checkbox]");
    if (await undoToggle.count()) await undoToggle.first().check();
    await page.locator("#overlay [data-confirm-reject]").click();
    await page.waitForTimeout(2500);

    const html = await h.read();
    // The rejected section is back...
    expect(html).toContain("The classifier is the whole design.");
    // ...and the agent's other change is untouched.
    expect(html).toContain("Ship the split budget first.");

    const item = (await h.session()).reviews.flatMap((r: any) => r.items).find((i: any) => i.id === id);
    expect(item.status).toBe("rejected");
  });
});

test.describe("bulk triage and filters", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.html", content: PLAN_HTML });
    await h.api("/items", {
      method: "POST",
      body: {
        items: [
          { body: "One.", selector: "#idea-p", text: "Ingest jobs fail" },
          { body: "Two.", selector: "#scope-p", text: "We should leverage" },
          { body: "Three.", selector: "#risks-p", text: "The classifier" },
        ],
      },
    });
    await h.api("/review/send", { method: "POST", body: {} });
    const sent = (await h.session()).reviews.find((r: any) => r.status === "sent");
    await h.cli(["answer", h.file, "--id", sent.items[2].id, "--outcome", "skipped", "--note", "Not doing this."]);
    await h.cli(["respond", h.file, "--summary", "Did two of three."]);
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("filter chips narrow the list", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    await expect(page.locator(".card")).toHaveCount(3);

    await page.locator('[data-filter="skipped"]').click();
    await expect(page.locator(".card")).toHaveCount(1);
    await page.locator('[data-filter="all"]').click();
    await expect(page.locator(".card")).toHaveCount(3);
  });

  test("accept all applied settles the straightforward ones only", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    await page.locator("[data-accept-all]").click();
    await page.waitForTimeout(1500);

    const items = (await h.session()).reviews.flatMap((r: any) => r.items);
    expect(items.filter((i: any) => i.status === "accepted")).toHaveLength(2);
    // The deliberately-skipped one still needs a human decision.
    expect(items.find((i: any) => i.outcome === "skipped").status).toBe("answered");
  });
});

test.describe("presence, badge and the ended screen", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.html", content: PLAN_HTML });
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("the tab title carries a count of what is waiting on the human", async ({ page }) => {
    await sendNote(h, "Do this.", "#idea-p", "Ingest jobs fail");
    await h.cli(["respond", h.file, "--summary", "Done."]);
    await page.goto(h.url);
    await waitForArtifact(page);
    await expect(async () => expect(await page.title()).toMatch(/\(\d+\)/)).toPass({ timeout: 15_000 });
  });

  test("ending the session shows the ended screen, and a reload keeps it", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    await page.locator("#end").click();
    const confirm = page.locator("#overlay [data-confirm-end], #overlay button").filter({ hasText: /end/i });
    if (await confirm.count()) await confirm.first().click();
    await page.waitForTimeout(1200);
    expect((await h.session()).status).toBe("ended");

    await page.reload();
    await page.waitForTimeout(1500);
    // bootstrap.status is honoured: an ended session must not reload into the
    // live UI as though nothing had happened.
    await expect(page.locator("body")).toContainText(/ended/i);
  });
});

test.describe("theme, companions, packets and recovery", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.html", content: PLAN_HTML });
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("the theme toggle reaches the sandboxed artifact", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    const frame = page.frames().find((f) => f.url().includes("/artifact/"))!;

    for (let i = 0; i < 3; i++) {
      await page.locator("#theme").click();
      await page.waitForTimeout(400);
      const chromeTheme = await page.evaluate(() => document.documentElement.dataset.theme ?? "");
      const frameTheme = await frame.evaluate(() => document.documentElement.dataset.theme ?? "");
      if (chromeTheme === "dark" || chromeTheme === "light") {
        expect(frameTheme).toBe(chromeTheme);
        return;
      }
    }
    throw new Error("theme never became explicit");
  });

  test("companions set from the CLI are delivered with the review", async () => {
    const spec = path.join(h.dir, "spec.md");
    await writeFile(spec, "# Spec\n\nRetry budget is three.\n");
    await h.cli(["companions", h.file, "--with", spec]);
    await sendNote(h, "These disagree.", "#budget-p", "The budget is three attempts.");
    const review = (await h.cli(["poll", h.file, "--timeout-ms", "500"])).json;
    expect(review.reviewed_alongside[0]).toContain("spec.md");
    await h.cli(["respond", h.file, "--summary", "Noted."]);
  });

  test("a packet imported through the sheet lands in the draft", async ({ page }) => {
    const reviewId = (await h.session()).reviews.find((r: any) => r.items.length > 0).id;
    const packetPath = path.join(h.dir, "in.packet.json");
    await h.cli(["packet", "export", h.file, "--review", reviewId, "--out", packetPath]);

    const other = await boot({ name: "other.html", content: PLAN_HTML });
    try {
      await page.goto(other.url);
      await waitForArtifact(page);
      await page.locator("#record").click();
      await page.locator("#overlay input[type=file]").setInputFiles(packetPath);
      await page.waitForTimeout(2000);

      const draft = (await other.session()).reviews.find((r: any) => r.status === "drafting");
      expect(draft.items.length).toBeGreaterThan(0);
    } finally {
      await other.dispose();
    }
  });

  test("the page survives the server restarting under it", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);

    await h.cli(["stop"]);
    await page.waitForTimeout(1200);
    // The disconnection bar is what stops a dead server reading as an idle one.
    await expect(page.locator("#statusBar")).toBeVisible({ timeout: 15_000 });

    // Bring it back. `status` deliberately never starts a server, so opening the
    // artifact again is what a human would actually do.
    await h.cli([h.file, "--no-open"]);
    await page.waitForTimeout(1500);
    await h.write(PLAN_HTML.replace("three attempts", "seven attempts"));
    await expect(artifactFrame(page).locator("#budget-p")).toContainText("seven attempts", { timeout: 30_000 });
  });
});

test.describe("anchors that stop matching", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.html", content: PLAN_HTML });
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("an anchor survives the agent rewriting the very paragraph it points at", async ({ page }) => {
    await h.api("/items", {
      method: "POST",
      body: {
        items: [
          {
            body: "Say what happens on a mislabel.",
            selector: "#risks-p",
            text: "The classifier is the whole design. If it mislabels a transient failure we drop work silently.",
          },
        ],
      },
    });
    await h.api("/review/send", { method: "POST", body: {} });

    // One word changed — exactly the case exact-equality matching used to fail,
    // because the only elements it could re-find were the ones nobody edited.
    await h.write(PLAN_HTML.replace("we drop work silently", "we drop work quietly"));
    await new Promise((r) => setTimeout(r, 1200));

    await page.goto(h.url);
    await waitForArtifact(page);
    await page.waitForTimeout(1500);

    // Re-tracked from the store after a fresh load, and still attached.
    const pending = await artifactFrame(page).locator("#risks-p").evaluate((el) => el.className.includes("pe-pending"));
    expect(pending).toBe(true);
    await expect(page.locator(".card")).toContainText("Say what happens on a mislabel.");
  });

  test("a paragraph rewritten beyond recognition is flagged rather than mis-attached", async ({ page }) => {
    await h.write(
      PLAN_HTML.replace(
        "The classifier is the whole design. If it mislabels a transient failure we drop work silently.",
        "Throughput targets assume the shard rebalancer lands before the quarter closes.",
      ),
    );
    await new Promise((r) => setTimeout(r, 1200));
    await page.goto(h.url);
    await waitForArtifact(page);
    await page.waitForTimeout(2000);

    // It must not silently latch onto an unrelated paragraph.
    const attached = await artifactFrame(page)
      .locator("#risks-p")
      .evaluate((el) => el.className.includes("pe-pending"));
    expect(attached).toBe(false);
  });
});
