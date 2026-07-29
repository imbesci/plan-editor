// Cross-boundary behaviour: keyboard relay out of the sandboxed frame, markdown
// artifacts, and diagrams. These are the parts a unit test structurally cannot
// reach, because they all depend on two documents and a sandbox between them.

import { expect, test } from "@playwright/test";
import { artifactFrame, boot, PLAN_HTML, setAnnotate, targetHint, waitForArtifact, type Harness } from "./harness.ts";

// --- keyboard relay ---------------------------------------------------------

test.describe("keyboard shortcuts fired from inside the artifact", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.html", content: PLAN_HTML });
  });
  test.afterAll(async () => {
    await h.dispose();
  });
  test.beforeEach(async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    // Focus genuinely inside the frame — this is the state every shortcut used
    // to die in, because clicking the document is the first thing anyone does.
    await artifactFrame(page).locator("#idea-p").click();
  });

  test("⌘I toggles annotate", async ({ page }) => {
    const before = await page.locator("#modeToggle").isChecked();
    await artifactFrame(page).locator("body").press("Meta+i");
    await page.waitForTimeout(400);
    expect(await page.locator("#modeToggle").isChecked()).toBe(!before);
  });

  test("? opens the shortcut sheet", async ({ page }) => {
    await artifactFrame(page).locator("body").press("?");
    await expect(page.locator("#overlay")).toBeVisible();
    await expect(page.locator("#overlay")).toContainText("Toggle annotate mode");
  });

  test("⌘H opens history", async ({ page }) => {
    await artifactFrame(page).locator("body").press("Meta+h");
    await expect(page.locator("#overlay .versions")).toBeVisible({ timeout: 10_000 });
  });

  test("/ focuses the in-document find box", async ({ page }) => {
    await artifactFrame(page).locator("body").press("/");
    await page.waitForTimeout(400);
    expect(await page.evaluate(() => document.activeElement?.id)).toBe("find");
  });

  test("⌘\\ collapses the panel", async ({ page }) => {
    await artifactFrame(page).locator("body").press("Meta+\\");
    await page.waitForTimeout(400);
    await expect(page.locator("#layout")).toHaveClass(/collapsed/);
  });

  test("⌘E arms suggest mode", async ({ page }) => {
    await artifactFrame(page).locator("body").press("Meta+e");
    await page.waitForTimeout(400);
    await expect(page.locator("#suggest")).toHaveAttribute("aria-pressed", "true");
  });

  test("a bare letter typed into an artifact input does not reach the panel", async ({ page }) => {
    // An artifact can legitimately contain form fields; `j` typed into one must
    // not scroll the review list.
    await artifactFrame(page).locator("body").evaluate(() => {
      const input = document.createElement("input");
      input.id = "pe-test-input";
      document.body.appendChild(input);
      input.focus();
    });
    await artifactFrame(page).locator("#pe-test-input").press("j");
    await page.waitForTimeout(400);
    await expect(page.locator(".card.focused")).toHaveCount(0);
  });
});

// --- markdown ---------------------------------------------------------------

const PLAN_MD = `# Retry plan

We should leverage the existing queue.

## Risks

The budget is three attempts.
`;

test.describe("markdown artifacts", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "plan.md", content: PLAN_MD });
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("renders to HTML with stable ids while the file stays markdown", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    await expect(artifactFrame(page).locator("h1")).toHaveText("Retry plan");
    await expect(artifactFrame(page).locator("#risks")).toBeVisible();
    expect(await h.read()).toBe(PLAN_MD);
  });

  test("a note on a section reaches the agent as a source line range", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    await setAnnotate(page, true);
    await artifactFrame(page).locator("#risks").click();
    await page.locator("#input").fill("Explain why three.");
    await expect(page.locator("#addNote")).toBeEnabled();
    await page.locator("#addNote").click();
    await page.locator("#send").click();
    await page.waitForTimeout(600);

    const review = (await h.cli(["poll", h.file, "--timeout-ms", "500"])).json;
    const item = review.items.find((i: any) => i.request === "Explain why three.");
    expect(item.source).toMatch(/^plan\.md:\d+-\d+$/);
    expect(item.selector_hint).toBeUndefined();
  });

  test("the agent edits the markdown and the browser morphs the render", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    await h.write(PLAN_MD.replace("three attempts", "five attempts"));
    await expect(artifactFrame(page).locator("#risks")).toContainText("five attempts", { timeout: 20_000 });
    expect(await h.read()).toContain("# Retry plan");
    expect(await h.read()).not.toContain("<h1");
  });

  test("the browser cannot write rendered HTML back over the source", async () => {
    const result = await h.api("/write", { method: "POST", body: { html: "<h1>replaced</h1>" } });
    expect(result.status).toBe(409);
    expect(await h.read()).toContain("# Retry plan");
  });
});

// --- diagrams ---------------------------------------------------------------

const DIAGRAM_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Flows</title>
<style>:root[data-theme="dark"]{color-scheme:dark}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){color-scheme:dark}}</style>
</head><body>
<h1 id="title">Ingest flows</h1>
<section id="retry"><h2>Retry</h2>
<pre class="mermaid" id="retry-flow">flowchart LR
  IN[Job arrives] --&gt; TRY[Attempt]
  TRY --&gt;|error| CLASSIFY{Classify}
  CLASSIFY --&gt;|permanent| DLQ[Dead letter]</pre></section>
<section id="prose"><h2>Prose</h2><p id="prose-p">Ordinary text next to the diagram.</p></section>
</body></html>`;

test.describe("mermaid diagrams", () => {
  let h: Harness;
  test.beforeAll(async () => {
    h = await boot({ name: "flows.html", content: DIAGRAM_HTML });
  });
  test.afterAll(async () => {
    await h.dispose();
  });

  test("renders to SVG beside the source, which stays in the document", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    const frame = artifactFrame(page);
    await expect(frame.locator(".pe-diagram svg")).toBeVisible({ timeout: 30_000 });

    // The source element is still there, still id-addressable — it is what the
    // diff, the anchors and the agent all operate on.
    await expect(frame.locator("#retry-flow")).toBeAttached();
    const hidden = await frame.locator("#retry-flow").evaluate((el) => getComputedStyle(el).display === "none");
    expect(hidden).toBe(true);

    // The rendered container must be invisible to morph.
    const marked = await frame.locator(".pe-diagram").evaluate((el) => el.hasAttribute("data-pe-ui"));
    expect(marked).toBe(true);
  });

  test("a morph does not destroy the diagram, and an untouched diagram produces no diff", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    const frame = artifactFrame(page);
    await expect(frame.locator(".pe-diagram svg")).toBeVisible({ timeout: 30_000 });
    const svgBefore = await frame.locator(".pe-diagram").innerHTML();

    // Touch a completely unrelated paragraph.
    await h.write((await h.read()).replace("Ordinary text next to the diagram.", "Ordinary text, reworded."));
    await expect(frame.locator("#prose-p")).toHaveText("Ordinary text, reworded.", { timeout: 20_000 });

    await expect(frame.locator(".pe-diagram svg")).toBeVisible();
    const svgAfter = await frame.locator(".pe-diagram").innerHTML();
    expect(svgAfter).toBe(svgBefore);
  });

  test("editing the diagram source re-renders it", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    const frame = artifactFrame(page);
    await expect(frame.locator(".pe-diagram svg")).toBeVisible({ timeout: 30_000 });

    await h.write((await h.read()).replace("DLQ[Dead letter]", "DLQ[Quarantine]"));
    await expect(frame.locator(".pe-diagram")).toContainText("Quarantine", { timeout: 25_000 });
  });

  test("clicking a node anchors the note to the diagram source and names the node", async ({ page }) => {
    await page.goto(h.url);
    await waitForArtifact(page);
    const frame = artifactFrame(page);
    await expect(frame.locator(".pe-diagram svg")).toBeVisible({ timeout: 30_000 });

    await setAnnotate(page, true);
    await frame.locator(".pe-diagram svg .nodeLabel, .pe-diagram svg .node").first().click();
    await expect(targetHint(page)).toContainText("Pinned to", { timeout: 10_000 });

    await page.locator("#input").fill("This branch is wrong.");
    await expect(page.locator("#addNote")).toBeEnabled();
    await page.locator("#addNote").click();
    await page.waitForTimeout(700);

    const draft = (await h.session()).reviews.find((r: any) => r.status === "drafting");
    const item = draft.items.find((i: any) => i.body === "This branch is wrong.");
    expect(item.anchors?.[0]?.node?.label ?? "").not.toBe("");
    // The anchor still points at something that exists in the file.
    expect(item.selector).toContain("retry-flow");
  });

  test("mermaid is not fetched for an artifact with no diagram", async ({ page }) => {
    const plain = await boot({ name: "plain.html", content: PLAN_HTML });
    const requests: string[] = [];
    page.on("request", (r) => requests.push(r.url()));
    await page.goto(plain.url);
    await waitForArtifact(page);
    await page.waitForTimeout(1500);
    expect(requests.some((u) => u.includes("/mermaid.js"))).toBe(false);
    await plain.dispose();
  });
});
