// The Accept all button.

import { expect, test } from "@playwright/test";
import { boot, PLAN_HTML, waitForArtifact, type Harness } from "./harness.ts";

async function reviewWith(h: Harness, bodies: string[]) {
  await h.api("/items", {
    method: "POST",
    body: { items: bodies.map((b, i) => ({ body: b, selector: `#${["idea", "scope", "risks", "milestones"][i]}-p`, text: "x" })) },
  });
  await h.api("/review/send", { method: "POST", body: {} });
  return (await h.session()).reviews.find((r: any) => r.status === "sent");
}

test("accepts everything in one click when nothing is flagged", async ({ page }) => {
  const h = await boot({ name: "plan.html", content: PLAN_HTML });
  try {
    await reviewWith(h, ["One.", "Two.", "Three."]);
    await h.cli(["respond", h.file, "--summary", "All three applied."]);

    await page.goto(h.url);
    await waitForArtifact(page);

    const button = page.locator("[data-accept-all]");
    await expect(button).toBeVisible();
    await expect(button).toContainText("Accept all");
    await expect(button).toContainText("3");

    await button.click();
    await page.waitForTimeout(1500);

    const items = (await h.session()).reviews.flatMap((r: any) => r.items);
    expect(items.filter((i: any) => i.status === "accepted")).toHaveLength(3);
  } finally {
    await h.dispose();
  }
});

test("confirms first when some items were flagged for the human", async ({ page }) => {
  const h = await boot({ name: "plan.html", content: PLAN_HTML });
  try {
    const sent = await reviewWith(h, ["One.", "Two.", "Three."]);
    await h.cli(["answer", h.file, "--id", sent.items[1].id, "--outcome", "needs-call", "--note", "Which way?"]);
    await h.cli(["answer", h.file, "--id", sent.items[2].id, "--outcome", "skipped", "--note", "Did not do it."]);
    await h.cli(["respond", h.file, "--summary", "One applied, two flagged."]);

    await page.goto(h.url);
    await waitForArtifact(page);
    await page.locator("[data-accept-all]").click();

    // It must name what it is about to sweep up rather than doing it quietly.
    await expect(page.locator("#overlay")).toBeVisible();
    await expect(page.locator("#overlay")).toContainText("needs your call");
    await expect(page.locator("#overlay")).toContainText("not done");

    // The narrower option settles only the straightforward one.
    await page.locator("[data-accept-safe]").click();
    await page.waitForTimeout(1500);

    const items = (await h.session()).reviews.flatMap((r: any) => r.items);
    expect(items.filter((i: any) => i.status === "accepted")).toHaveLength(1);
    expect(items.filter((i: any) => i.status === "answered")).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

test("accepting everything from the sheet settles the flagged ones too", async ({ page }) => {
  const h = await boot({ name: "plan.html", content: PLAN_HTML });
  try {
    const sent = await reviewWith(h, ["One.", "Two."]);
    await h.cli(["answer", h.file, "--id", sent.items[1].id, "--outcome", "caveat", "--note", "Read this."]);
    await h.cli(["respond", h.file, "--summary", "Done."]);

    await page.goto(h.url);
    await waitForArtifact(page);
    await page.locator("[data-accept-all]").click();
    await page.locator("[data-accept-every]").click();
    await page.waitForTimeout(1500);

    const items = (await h.session()).reviews.flatMap((r: any) => r.items);
    expect(items.filter((i: any) => i.status === "accepted")).toHaveLength(2);
  } finally {
    await h.dispose();
  }
});

test("the button is offered even when nothing was a plain apply", async ({ page }) => {
  const h = await boot({ name: "plan.html", content: PLAN_HTML });
  try {
    const sent = await reviewWith(h, ["One."]);
    await h.cli(["answer", h.file, "--id", sent.items[0].id, "--outcome", "skipped", "--note", "No."]);
    await h.cli(["respond", h.file, "--summary", "Skipped it."]);

    await page.goto(h.url);
    await waitForArtifact(page);
    // This case used to render no bulk control at all.
    await expect(page.locator("[data-accept-all]")).toBeVisible();
    await page.locator("[data-accept-all]").click();
    await expect(page.locator("[data-accept-safe]")).toHaveCount(0);
    await page.locator("[data-accept-every]").click();
    await page.waitForTimeout(1200);
    expect((await h.session()).reviews.flatMap((r: any) => r.items)[0].status).toBe("accepted");
  } finally {
    await h.dispose();
  }
});
