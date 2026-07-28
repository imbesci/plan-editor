import { EventEmitter } from "node:events";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chokidar, { type FSWatcher } from "chokidar";
import express, { type NextFunction, type Request, type Response } from "express";

import { canonicalDir } from "./hooks.ts";
import { injectSdk } from "./html-transform.ts";
import { allowedHostnames, bindHost, defaultPort, hostnameFromHeader, stateDir } from "./paths.ts";
import {
  parseIncomingAnnotations,
  parseMorphReport,
  parseRepoint,
  parseThreadText,
  ValidationError,
  type AgentPresence,
  type Annotation,
  type PollResult,
  type Session,
} from "./protocol.ts";
import { canonicalFile, SessionStore, sessionKey } from "./store/session-store.ts";
import { VersionStore } from "./store/version-store.ts";
import { stripSdk } from "./html-transform.ts";
import { renderChrome } from "./chrome/chrome-html.ts";

// Browser bundles live in dist/ next to src/, whether the server is run from
// source (bun src/cli.ts) or from an installed package.
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const IDLE_TIMEOUT_MS = 30 * 60_000;
const ARTIFACT_EXTENSIONS = new Set([".html", ".htm"]);

interface ServeOptions {
  port?: number;
  host?: string;
  stateDirectory?: string;
  version?: string;
  idleTimeoutMs?: number;
  onLog?: (message: string) => void;
}

export async function serve(options: ServeOptions = {}) {
  const port = options.port ?? defaultPort();
  const host = options.host ?? bindHost();
  const directory = options.stateDirectory ?? stateDir();
  const version = options.version ?? "0.0.0";
  const idleTimeoutMs = options.idleTimeoutMs ?? IDLE_TIMEOUT_MS;
  const log = options.onLog ?? (() => {});

  const store = new SessionStore(directory);
  await store.init();
  const versions = new VersionStore(directory);

  const app = express();
  const events = new EventEmitter();
  events.setMaxListeners(0);

  const watchers = new Map<string, FSWatcher>();
  const sseClients = new Map<string, Set<Response>>();
  const activePolls = new Set<string>();
  const workingSessions = new Set<string>();
  let idleTimer: NodeJS.Timeout | null = null;

  // --- guards ---------------------------------------------------------------

  // DNS-rebinding defense. A rebound page sends its hostile hostname in BOTH
  // Origin and Host, so an origin check alone does not stop it — the Host must
  // be one this server actually answers to.
  const hostnames = allowedHostnames();
  app.use((req, res, next) => {
    const hostname = hostnameFromHeader(req.headers.host);
    if (!hostname || !hostnames.has(hostname)) {
      res.status(403).send("Forbidden host");
      return;
    }
    next();
  });

  app.use(express.json({ limit: "2mb" }));

  function isSameOrigin(req: Request): boolean {
    const origin = req.headers.origin;
    if (!origin) return true; // non-browser caller (CLI, hook)
    try {
      const hostname = new URL(origin).hostname;
      return hostnames.has(hostname.toLowerCase());
    } catch {
      return false;
    }
  }

  function requireSameOrigin(req: Request, res: Response, next: NextFunction): void {
    if (!isSameOrigin(req)) {
      res.status(403).json({ error: "cross-origin request refused" });
      return;
    }
    next();
  }

  /**
   * The session key is a hash of a guessable path, so it is an identifier, not a
   * credential. Every session-scoped route requires the random token minted at
   * open time. This is what stops a local process from registering a path and
   * reading the file back out.
   */
  async function loadAuthorized(req: Request, res: Response): Promise<Session | null> {
    const key = String(req.params.key ?? "");
    const token = String(req.query.t ?? req.get("x-plan-editor-token") ?? "");
    const session = await store.read(key);
    if (!session) {
      res.status(404).json({ error: "session not found" });
      return null;
    }
    if (!token || token.length !== session.token.length || token !== session.token) {
      res.status(403).json({ error: "invalid or missing session token" });
      return null;
    }
    return session;
  }

  // --- presence & lifecycle -------------------------------------------------

  function presenceOf(key: string): AgentPresence {
    if (activePolls.has(key)) return "listening";
    if (workingSessions.has(key)) return "working";
    return "waiting";
  }

  function broadcast(key: string, event: unknown): void {
    const clients = sseClients.get(key);
    if (!clients?.size) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (!client.writableEnded) client.write(payload);
    }
  }

  function emitPresence(key: string): void {
    broadcast(key, { type: "presence", state: presenceOf(key) });
  }

  function refreshIdle(): void {
    if (idleTimer) clearTimeout(idleTimer);
    idleTimer = null;
    const live = activePolls.size > 0 || [...sseClients.values()].some((set) => set.size > 0);
    if (live) return;
    idleTimer = setTimeout(() => void shutdown(), idleTimeoutMs);
    idleTimer.unref();
  }

  async function watch(session: Session): Promise<void> {
    if (watchers.has(session.key)) return;
    // Watch the file itself, not its directory: recursive watching of a parent
    // saturates the event loop when artifacts live inside large trees.
    const watcher = chokidar.watch(session.file, { ignoreInitial: true });
    let debounce: NodeJS.Timeout | null = null;
    watcher.on("all", () => {
      if (debounce) clearTimeout(debounce);
      // The agent's write lands semi-atomically; settle before morphing so we
      // never patch against a half-written file.
      debounce = setTimeout(() => {
        void (async () => {
          log(`artifact changed key=${session.key}`);
          const html = await readFile(session.file, "utf8").catch(() => null);
          // Snapshot before telling the browser, so an undo issued the instant
          // the patch lands already has the version it needs.
          if (html !== null) await versions.snapshot(session.key, html, "edit");
          workingSessions.delete(session.key);
          broadcast(session.key, { type: "patch", reason: "file-changed" });
          broadcast(session.key, { type: "versions", list: await versions.list(session.key) });
          emitPresence(session.key);
        })();
      }, 120);
    });
    watchers.set(session.key, watcher);
  }

  // --- routes ---------------------------------------------------------------

  app.get("/health", (_req, res) => {
    res.json({ ok: true, app: "plan-editor", version });
  });

  app.post("/shutdown", requireSameOrigin, (_req, res) => {
    res.json({ status: "shutting-down" });
    setImmediate(() => void shutdown());
  });

  // Creating a session is a local-caller operation (the CLI). It validates the
  // path server-side — lavish-axi checked the extension only in the CLI, which
  // let any local process register /etc/passwd and read it back.
  app.post("/api/sessions", async (req, res, next) => {
    try {
      const raw = String((req.body as Record<string, unknown>)?.file ?? "");
      if (!raw) throw new ValidationError("file is required");
      if (!ARTIFACT_EXTENSIONS.has(path.extname(raw).toLowerCase())) {
        throw new ValidationError("only .html and .htm artifacts can be opened");
      }
      const canonical = await canonicalFile(raw);
      const info = await stat(canonical);
      if (!info.isFile()) throw new ValidationError("artifact must be a regular file");

      const body = (req.body ?? {}) as Record<string, unknown>;
      const session = await store.open(canonical, {
        authoredBy: typeof body.authoredBy === "string" ? body.authoredBy.slice(0, 64) : undefined,
        authoredIn: typeof body.authoredIn === "string" ? canonicalDir(body.authoredIn.slice(0, 1024)) : undefined,
      });
      await watch(session);
      await versions.snapshot(session.key, await readFile(canonical, "utf8"), "open");
      log(`session opened key=${session.key} file=${session.file}`);
      res.json({
        key: session.key,
        token: session.token,
        file: session.file,
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/s/${session.key}?t=${session.token}`,
      });
    } catch (error) {
      next(error);
    }
  });

  app.get("/s/:key", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await watch(session);
      res.type("html").send(renderChrome(session));
    } catch (error) {
      next(error);
    }
  });

  app.get("/artifact/:key/index.html", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const html = await readFile(session.file, "utf8");
      res.type("html").send(injectSdk(html));
    } catch (error) {
      next(error);
    }
  });

  // Raw artifact HTML for morphing. Same auth, no SDK injection — the SDK is
  // already live in the frame and must not be duplicated.
  app.get("/artifact/:key/raw", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      res.type("text/plain").send(await readFile(session.file, "utf8"));
    } catch (error) {
      next(error);
    }
  });

  app.get(/^\/artifact\/([^/]+)\/(.+)$/, async (req, res, next) => {
    try {
      const key = String(req.params[0]);
      const assetPath = String(req.params[1]);
      const token = String(req.query.t ?? "");
      const session = await store.read(key);
      if (!session) {
        res.status(404).send("Session not found");
        return;
      }
      if (token !== session.token) {
        res.status(403).send("Forbidden");
        return;
      }
      const file = await resolveAsset(path.dirname(session.file), assetPath);
      if (!file) {
        res.status(403).send("Forbidden");
        return;
      }
      res.sendFile(file);
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/annotations", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const incoming = parseIncomingAnnotations((req.body as Record<string, unknown>)?.annotations);
      const created = await store.addAnnotations(session.key, incoming);
      if (!created) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      workingSessions.add(session.key);
      events.emit("feedback", session.key);
      emitPresence(session.key);
      await syncBrowsers(session.key);
      res.json({ status: "queued", annotations: created });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/morph-report", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const report = parseMorphReport(req.body);
      const changed = await store.applyMorphReport(session.key, report);
      await syncBrowsers(session.key);
      res.json({ status: "ok", changed: changed?.length ?? 0 });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/end", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.end(session.key, "user");
      events.emit("ended", session.key);
      await syncBrowsers(session.key);
      res.json({ status: "ended" });
    } catch (error) {
      next(error);
    }
  });

  // Called by the PostToolUse hook (via `plan-editor notify-edit`) the moment
  // the agent touches the artifact — before the write lands — so the pending
  // element starts pulsing immediately instead of after the round trip.
  app.post("/api/:key/agent-activity", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      workingSessions.add(session.key);
      broadcast(session.key, { type: "agent-activity", active: true });
      emitPresence(session.key);
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-reply", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const text = String((req.body as Record<string, unknown>)?.text ?? "");
      await store.addChat(session.key, "agent", text);
      workingSessions.delete(session.key);
      broadcast(session.key, { type: "agent-reply", text });
      emitPresence(session.key);
      await syncBrowsers(session.key);
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/versions", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      res.json({ versions: await versions.list(session.key) });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/versions/:seq", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const html = await versions.read(session.key, Number(req.params.seq));
      if (html === null) {
        res.status(404).json({ error: "version not found" });
        return;
      }
      res.type("text/plain").send(html);
    } catch (error) {
      next(error);
    }
  });

  // Undo. Writing an old snapshot back to the artifact is the whole mechanism —
  // the existing watcher turns it into a patch, so undo animates in place exactly
  // like an agent edit, and is itself undoable because the write snapshots too.
  app.post("/api/:key/restore", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const seq = Number(body.seq ?? (await versions.previousSeq(session.key)));
      if (!Number.isFinite(seq)) {
        res.status(400).json({ error: "nothing to restore" });
        return;
      }
      const html = await versions.read(session.key, seq);
      if (html === null) {
        res.status(404).json({ error: "version not found" });
        return;
      }
      await writeFile(session.file, html);
      await versions.snapshot(session.key, html, "restore");
      res.json({ status: "restored", seq });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/annotations/:id/accept", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const updated = await store.acceptAnnotation(session.key, String(req.params.id));
      await syncBrowsers(session.key);
      res.json({ status: updated ? "resolved" : "unchanged" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/annotations/:id/reject", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const reason = parseThreadText(req.body);
      await store.rejectAnnotation(session.key, String(req.params.id), reason);
      // Reopened, so the agent must hear about it again.
      events.emit("feedback", session.key);
      await syncBrowsers(session.key);
      res.json({ status: "reopened" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/annotations/:id/reply", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.replyToAnnotation(session.key, String(req.params.id), "human", parseThreadText(req.body));
      events.emit("feedback", session.key);
      await syncBrowsers(session.key);
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/annotations/:id/repoint", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.repointAnnotation(session.key, String(req.params.id), parseRepoint(req.body));
      events.emit("feedback", session.key);
      await syncBrowsers(session.key);
      res.json({ status: "repointed" });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/export", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const html = stripSdk(await readFile(session.file, "utf8"));
      res.type("html").set("Content-Disposition", 'attachment; filename="artifact.export.html"').send(html);
    } catch (error) {
      next(error);
    }
  });

  app.get("/events/:key", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      res.writeHead(200, {
        "Content-Type": "text/event-stream",
        "Cache-Control": "no-cache",
        Connection: "keep-alive",
      });
      const clients = sseClients.get(session.key) ?? new Set<Response>();
      clients.add(res);
      sseClients.set(session.key, clients);
      refreshIdle();

      res.write(`data: ${JSON.stringify({ type: "sync", annotations: session.annotations, chat: session.chat })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "presence", state: presenceOf(session.key) })}\n\n`);
      res.write(`data: ${JSON.stringify({ type: "versions", list: await versions.list(session.key) })}\n\n`);

      const heartbeat = setInterval(() => {
        if (!res.writableEnded) res.write(": ping\n\n");
      }, 25_000);
      heartbeat.unref();

      req.on("close", () => {
        clearInterval(heartbeat);
        clients.delete(res);
        refreshIdle();
      });
    } catch (error) {
      next(error);
    }
  });

  // Agent long-poll. Token-gated like everything else; the CLI reads the token
  // from the session file it has filesystem access to anyway.
  app.get("/api/poll", async (req, res, next) => {
    try {
      const file = await canonicalFile(String(req.query.file ?? ""));
      const key = sessionKey(file);
      const session = await store.read(key);
      if (!session) {
        res.status(404).json({ error: "session not found" });
        return;
      }
      if (String(req.query.t ?? "") !== session.token) {
        res.status(403).json({ error: "invalid session token" });
        return;
      }

      const immediate = await takeFeedback(key);
      if (immediate.status !== "waiting") {
        res.json(immediate);
        refreshIdle();
        return;
      }

      const timeoutMs = req.query.timeoutMs === undefined ? null : Number(req.query.timeoutMs);
      activePolls.add(key);
      emitPresence(key);
      refreshIdle();

      let settled = false;
      const finish = async () => {
        if (settled || res.writableEnded) return;
        settled = true;
        cleanup();
        res.json(await takeFeedback(key));
      };
      const onEvent = (changed: string) => {
        if (changed === key) void finish();
      };
      const timer = timeoutMs === null ? null : setTimeout(() => void finish(), Math.max(0, timeoutMs));
      function cleanup(): void {
        if (timer) clearTimeout(timer);
        events.off("feedback", onEvent);
        events.off("ended", onEvent);
        activePolls.delete(key);
        emitPresence(key);
        refreshIdle();
      }
      events.on("feedback", onEvent);
      events.on("ended", onEvent);
      req.on("close", () => {
        if (settled) return;
        settled = true;
        cleanup();
      });
    } catch (error) {
      next(error);
    }
  });

  async function takeFeedback(key: string): Promise<PollResult> {
    const session = await store.read(key);
    if (!session) return { status: "waiting" };
    const open = session.annotations.filter((entry) => entry.status === "submitted");
    if (open.length === 0) {
      return session.status === "ended" ? { status: "ended", endedBy: session.endedBy ?? "agent" } : { status: "waiting" };
    }
    // Annotations are NOT deleted on delivery. They stay as durable records and
    // transition to `addressed` when the agent's edit actually touches them.
    return {
      status: "feedback",
      annotations: open,
      ...(session.status === "ended" ? { sessionEnded: true, endedBy: session.endedBy ?? "user" } : {}),
    };
  }

  async function syncBrowsers(key: string): Promise<void> {
    const session = await store.read(key);
    if (!session) return;
    broadcast(key, { type: "sync", annotations: session.annotations, chat: session.chat });
  }

  // Static browser bundles.
  app.get("/sdk.js", (_req, res) => {
    res.type("application/javascript").sendFile(path.join(DIST, "sdk.js"));
  });
  app.get("/chrome.js", (_req, res) => {
    res.type("application/javascript").sendFile(path.join(DIST, "chrome.js"));
  });
  app.get("/chrome.css", (_req, res) => {
    res.type("text/css").sendFile(path.join(DIST, "chrome.css"));
  });

  app.use((error: unknown, _req: Request, res: Response, _next: NextFunction) => {
    if (error instanceof ValidationError) {
      res.status(400).json({ error: error.message });
      return;
    }
    const code = (error as NodeJS.ErrnoException)?.code;
    if (code === "ENOENT") {
      res.status(404).json({ error: "not found" });
      return;
    }
    log(`error ${String(error)}`);
    res.status(500).json({ error: "internal error" });
  });

  const server = http.createServer(app);
  await new Promise<void>((resolve, reject) => {
    server.once("error", reject);
    server.listen(port, host, resolve);
  });
  refreshIdle();
  log(`plan-editor server listening on ${host}:${port}`);

  async function shutdown(): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    for (const watcher of watchers.values()) await watcher.close();
    watchers.clear();
    for (const clients of sseClients.values()) {
      for (const client of clients) client.end();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
  }

  return {
    port: (server.address() as { port: number }).port,
    store,
    shutdown,
  };
}

/**
 * Confines an asset to the artifact's directory both lexically and by real path.
 * The realpath check is the half lavish-axi omitted on this route (its export
 * path had it), so a symlink inside the artifact directory could serve any file.
 */
export async function resolveAsset(root: string, assetPath: string): Promise<string | null> {
  const candidate = path.resolve(root, assetPath);
  const relative = path.relative(root, candidate);
  if (relative.startsWith("..") || path.isAbsolute(relative)) return null;
  try {
    const [realRoot, realFile] = await Promise.all([realpath(root), realpath(candidate)]);
    const realRelative = path.relative(realRoot, realFile);
    if (realRelative.startsWith("..") || path.isAbsolute(realRelative)) return null;
    return realFile;
  } catch {
    return null;
  }
}

export type { Annotation };
