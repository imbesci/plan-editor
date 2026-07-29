import { expect, test } from "@playwright/test";
import { artifactFrame, boot, PLAN_HTML, waitForArtifact, type Harness } from "./harness.ts";

let h: Harness;
test.beforeAll(async () => { h = await boot({ name: "plan.html", content: PLAN_HTML }); });
test.afterAll(async () => { await h.dispose(); });

test("the chrome and the sandboxed artifact both render", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);

  // Chrome side.
  await expect(page.locator("label.toggle")).toBeVisible();
  await expect(page.locator("#targetHint")).toBeVisible();

  // Artifact side, across the sandbox boundary.
  await expect(artifactFrame(page).locator("#title")).toHaveText("Ingest retry plan");
  await expect(artifactFrame(page).locator("#risks-p")).toContainText("classifier");
});

test("the artifact frame is sandboxed without allow-same-origin", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);
  const sandbox = await page.locator("#artifact").getAttribute("sandbox");
  expect(sandbox).toContain("allow-scripts");
  expect(sandbox).not.toContain("allow-same-origin");
});

test("the session token never reaches the artifact frame", async ({ page }) => {
  await page.goto(h.url);
  await waitForArtifact(page);
  const leaked = await artifactFrame(page).locator("body").evaluate(
    (_b, token) => document.documentElement.outerHTML.includes(token as string),
    h.token,
  );
  expect(leaked).toBe(false);
});
