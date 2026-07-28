import os from "node:os";
import path from "node:path";

export const LOOPBACK = "127.0.0.1";

export function stateDir(env = process.env): string {
  return env.PLAN_EDITOR_STATE_DIR || path.join(os.homedir(), ".plan-editor");
}

export function defaultPort(env = process.env): number {
  return Number(env.PLAN_EDITOR_PORT || 4471);
}

export function bindHost(env = process.env): string {
  return env.PLAN_EDITOR_HOST?.trim() || LOOPBACK;
}

/** Hostnames the server will answer to. Anything else is a rebinding attempt. */
export function allowedHostnames(env = process.env): Set<string> {
  const hosts = new Set([LOOPBACK, "::1", "localhost"]);
  const bind = bindHost(env);
  if (bind !== "0.0.0.0" && bind !== "::") hosts.add(bind);
  for (const extra of (env.PLAN_EDITOR_ALLOWED_HOSTS || "").split(/\s+/).filter(Boolean)) {
    hosts.add(extra);
  }
  return hosts;
}

/** Extracts the hostname from a Host header, rejecting anything malformed. */
export function hostnameFromHeader(header: string | undefined): string | null {
  if (!header) return null;
  const value = header.trim();
  if (!value) return null;
  if (value.startsWith("[")) {
    const close = value.indexOf("]");
    if (close === -1) return null;
    const rest = value.slice(close + 1);
    // Only an optional :port may follow the bracketed literal.
    if (rest && !/^:\d+$/.test(rest)) return null;
    return value.slice(1, close).toLowerCase();
  }
  const parts = value.split(":");
  if (parts.length > 2) return null; // bare IPv6 must be bracketed
  return (parts[0] ?? "").toLowerCase() || null;
}

export function serverLogFile(env = process.env): string {
  return path.join(stateDir(env), "server.log");
}
