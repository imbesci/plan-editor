// Talking to the detached server.
//
// Extracted because there are now two front doors — the CLI and the MCP server —
// and they must agree on every one of these behaviours. The subtle one is
// `ensureServer`: getting the restart rule wrong means a long-running detached
// process silently keeps executing stale code, and the symptom is a new feature
// appearing not to work at all rather than anything failing.

import { spawn } from "node:child_process";
import { openSync } from "node:fs";
import { mkdir, readdir, stat } from "node:fs/promises";
import path from "node:path";
import { fileURLToPath } from "node:url";

import { defaultPort, LOOPBACK, serverLogFile, stateDir } from "./paths.ts";
import { SessionStore, sessionKey } from "./store/session-store.ts";

export const PACKAGE_VERSION = process.env.PLAN_EDITOR_BUILD_VERSION ?? "0.1.0";

export class CliError extends Error {
  constructor(
    message: string,
    readonly hints: string[] = [],
  ) {
    super(message);
  }
}

/**
 * The detached server only restarts when the CLI's version differs from the
 * running one. Keying that on package.json alone means every edit to src/ is
 * silently ignored until someone bumps a version by hand — the failure is a
 * server quietly running stale code, which looks like the new code not working.
 * Folding the newest source/bundle mtime into the identity makes any change
 * restart it.
 */
export async function codeSignature(): Promise<string> {
  const roots = [fileURLToPath(new URL("./", import.meta.url)), fileURLToPath(new URL("../dist/", import.meta.url))];
  let newest = 0;
  for (const root of roots) {
    let entries: string[] = [];
    try {
      entries = await readdir(root, { recursive: true, encoding: "utf8" });
    } catch {
      continue;
    }
    for (const entry of entries) {
      const info = await stat(path.join(root, entry)).catch(() => null);
      if (info?.isFile()) newest = Math.max(newest, info.mtimeMs);
    }
  }
  return `${PACKAGE_VERSION}+${Math.round(newest)}`;
}

export function baseUrl(): string {
  return `http://${LOOPBACK}:${defaultPort()}`;
}

export async function health(): Promise<{ app?: string; version?: string } | null> {
  try {
    const response = await fetch(`${baseUrl()}/health`, { signal: AbortSignal.timeout(600) });
    if (!response.ok) return null;
    return (await response.json()) as { app?: string; version?: string };
  } catch {
    return null;
  }
}

export function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

export async function ensureServer(): Promise<string> {
  const version = await codeSignature();
  const existing = await health();
  if (existing?.app === "plan-editor" && existing.version === version) return version;
  if (existing?.app === "plan-editor") {
    await fetch(`${baseUrl()}/shutdown`, { method: "POST" }).catch(() => {});
    await delay(200);
  } else if (existing) {
    throw new CliError(`Port ${defaultPort()} is occupied by another server`, ["Set PLAN_EDITOR_PORT to a free port."]);
  }

  await mkdir(stateDir(), { recursive: true });
  const logFd = openSync(serverLogFile(), "a");
  // process.execPath is the bun binary; re-invoking the CLI source keeps the
  // detached server on exactly the runtime that spawned it.
  const child = spawn(process.execPath, [fileURLToPath(new URL("./cli.ts", import.meta.url)), "server"], {
    detached: true,
    stdio: ["ignore", logFd, logFd],
    env: process.env,
  });
  child.unref();

  for (let attempt = 0; attempt < 50; attempt += 1) {
    await delay(100);
    const probe = await health();
    if (probe?.app === "plan-editor" && probe.version === version) return version;
  }
  throw new CliError("plan-editor server did not start", [`Check ${serverLogFile()} for details.`]);
}

/**
 * The session token is the credential for every route. It is read from the
 * session file, which is only possible because the caller already has
 * filesystem access to the state directory — the same trust level as reading
 * the artifact itself.
 */
export async function tokenFor(canonical: string): Promise<{ key: string; token: string }> {
  const store = new SessionStore(stateDir());
  const key = sessionKey(canonical);
  const session = await store.read(key);
  if (!session) {
    throw new CliError(`No plan-editor session for ${canonical}`, [`Run \`plan-editor ${canonical}\` first.`]);
  }
  return { key, token: session.token };
}

/** One JSON round trip against a session-scoped route. */
export async function call(
  canonical: string,
  route: string,
  init?: { method?: string; body?: unknown },
): Promise<Record<string, unknown>> {
  const { key, token } = await tokenFor(canonical);
  const separator = route.includes("?") ? "&" : "?";
  const response = await fetch(`${baseUrl()}/api/${key}${route}${separator}t=${encodeURIComponent(token)}`, {
    method: init?.method ?? "GET",
    headers: { "content-type": "application/json" },
    ...(init?.body !== undefined ? { body: JSON.stringify(init.body) } : {}),
  });
  const text = await response.text();
  if (!response.ok) {
    let detail = text;
    try {
      detail = String((JSON.parse(text) as { error?: string }).error ?? text);
    } catch {
      // Non-JSON error bodies are rare but must not mask the real status.
    }
    throw new CliError(`${route} failed (${response.status}): ${detail}`);
  }
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    return { raw: text };
  }
}
