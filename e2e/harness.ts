// Boots a real plan-editor for a test: real detached server, real session,
// real browser. Nothing here is stubbed — the point of this suite is to catch
// the things the node:test suite structurally cannot, which is everything that
// depends on two documents, a sandbox boundary, and a human's hands.

import { execFile } from "node:child_process";
import { existsSync } from "node:fs";
import { mkdtemp, readFile, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { promisify } from "node:util";
import type { FrameLocator, Page } from "@playwright/test";

const run = promisify(execFile);
const REPO = path.resolve(import.meta.dirname, "..");
const BIN = path.join(REPO, "bin/plan-editor.js");
/**
 * Bun, not whatever is running the tests.
 *
 * Playwright runs under Node and the CLI imports TypeScript directly, so a
 * `process.execPath` child dies on the first `import "./cli.ts"`.
 */
function resolveBun(): string {
  if (process.env.PE_BUN) return process.env.PE_BUN;
  for (const dir of (process.env.PATH ?? "").split(path.delimiter)) {
    const candidate = path.join(dir, "bun");
    if (dir && existsSync(candidate)) return candidate;
  }
  return "bun";
}
const BUN = resolveBun();

let nextPort = 4600;

export interface Harness {
  dir: string;
  stateDir: string;
  file: string;
  port: number;
  key: string;
  token: string;
  url: string;
  /** Runs the CLI exactly as an agent would, against this harness's server. */
  cli: (args: string[]) => Promise<{ stdout: string; stderr: string; json: any }>;
  api: (route: string, init?: { method?: string; body?: unknown }) => Promise<any>;
  read: () => Promise<string>;
  write: (content: string) => Promise<void>;
  session: () => Promise<any>;
  dispose: () => Promise<void>;
}

export async function boot(artifact: { name: string; content: string }): Promise<Harness> {
  // realpath because the CLI canonicalizes, and on macOS mkdtemp hands back
  // /var/... while the session records /private/var/... — comparing the two
  // is the same trap `canonicalDir` exists for in the hook routing.
  const dir = await realpath(await mkdtemp(path.join(os.tmpdir(), "pe-e2e-")));
  const stateDir = path.join(dir, "state");
  const file = path.join(dir, artifact.name);
  const port = nextPort++;
  await writeFile(file, artifact.content);

  const env = { ...process.env, PLAN_EDITOR_STATE_DIR: stateDir, PLAN_EDITOR_PORT: String(port) };

  const cli = async (args: string[]) => {
    const { stdout, stderr } = await run(BUN, [BIN, ...args], { env, cwd: dir, maxBuffer: 64 * 1024 * 1024 });
    let json: any = null;
    try {
      json = JSON.parse(stdout);
    } catch {
      // Not every command prints JSON; callers that care will assert on stdout.
    }
    return { stdout, stderr, json };
  };

  const opened = await cli([file, "--no-open"]);
  const url: string = opened.json.session.url;
  const key = url.match(/\/s\/([a-f0-9]+)/)![1]!;
  const token = new URL(url).searchParams.get("t")!;

  const api = async (route: string, init?: { method?: string; body?: unknown }) => {
    const separator = route.includes("?") ? "&" : "?";
    const response = await fetch(`http://127.0.0.1:${port}/api/${key}${route}${separator}t=${token}`, {
      method: init?.method ?? "GET",
      headers: { "content-type": "application/json", origin: `http://127.0.0.1:${port}` },
      ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
    });
    const text = await response.text();
    try {
      return { status: response.status, body: JSON.parse(text) };
    } catch {
      return { status: response.status, body: text };
    }
  };

  return {
    dir,
    stateDir,
    file,
    port,
    key,
    token,
    url,
    cli,
    api,
    read: () => readFile(file, "utf8"),
    write: (content: string) => writeFile(file, content),
    session: async () => JSON.parse(await readFile(path.join(stateDir, "sessions", `${key}.json`), "utf8")),
    dispose: async () => {
      await cli(["stop"]).catch(() => {});
      await rm(dir, { recursive: true, force: true });
    },
  };
}

/**
 * The artifact frame.
 *
 * It is sandboxed without `allow-same-origin`, so it is an out-of-process frame
 * with an opaque origin. Playwright reaches it anyway; a hand-rolled CDP client
 * has to auto-attach to it as a separate target, which is most of why this suite
 * exists rather than more of those scripts.
 */
export function artifactFrame(page: Page): FrameLocator {
  return page.frameLocator("#artifact");
}

/** Waits until the SDK has booted inside the artifact frame. */
export async function waitForArtifact(page: Page): Promise<void> {
  await page.waitForSelector("#artifact");
  await artifactFrame(page).locator("body").waitFor({ state: "attached" });
  // The SDK announces itself by installing its stylesheet.
  await page.waitForFunction(
    () => {
      const frame = document.querySelector<HTMLIFrameElement>("#artifact");
      return Boolean(frame?.contentWindow);
    },
    undefined,
    { timeout: 15_000 },
  );
  await page.waitForTimeout(700);
}

/**
 * Turns annotate mode on or off through the real toolbar control.
 *
 * The checkbox itself is visually hidden behind a styled switch, so the click
 * has to land on the label — which is also what a human clicks.
 */
export async function setAnnotate(page: Page, on: boolean): Promise<void> {
  const checked = await page.locator("#modeToggle").isChecked();
  if (checked !== on) {
    await page.locator('label.toggle[for="modeToggle"]').click();
    await page.waitForFunction((want) => {
      const box = document.getElementById("modeToggle") as HTMLInputElement | null;
      return Boolean(box) && box!.checked === want;
    }, on);
  }
  await page.waitForTimeout(250);
}

/** The armed-target hint text in the composer. */
export function targetHint(page: Page) {
  return page.locator("#targetHint");
}

export const PLAN_HTML = `<!doctype html>
<html lang="en"><head><meta charset="utf-8"><title>Ingest plan</title>
<style>:root{--fg:#111;--bg:#fff}:root[data-theme="dark"]{--fg:#eee;--bg:#111}
@media (prefers-color-scheme: dark){:root:not([data-theme="light"]){--fg:#eee;--bg:#111}}
body{background:var(--bg);color:var(--fg);font-family:system-ui;max-width:52rem;margin:2rem auto}</style>
</head><body>
<h1 id="title">Ingest retry plan</h1>
<section id="idea"><h2>The idea</h2>
<p id="idea-p">Ingest jobs fail for two unrelated reasons and we currently treat them the same.</p></section>
<section id="scope"><h2>Scope</h2>
<p id="scope-p">We should leverage the existing queue rather than building a second one.</p></section>
<section id="budget"><h2>Budget</h2>
<p id="budget-p">The budget is three attempts, and that number is fixed.</p></section>
<section id="risks"><h2>Risks</h2>
<p id="risks-p">The classifier is the whole design. If it mislabels a transient failure we drop work silently.</p></section>
<section id="milestones"><h2>Milestones</h2>
<p id="milestones-p">Ship the classifier first, then the split budget.</p></section>
<section id="detail"><h2>Detail</h2>
${Array.from({ length: 40 }, (_, i) => `<p id="filler-${i}">Filler paragraph ${i} — the document has to be taller than the viewport for "scroll to this section" to mean anything.</p>`).join("")}
</section>
<section id="last"><h2>Last section</h2><p id="last-p">The end of the document.</p></section>
</body></html>`;
