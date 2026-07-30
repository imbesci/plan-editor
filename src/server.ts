import { EventEmitter } from "node:events";
import { readFile, realpath, stat, writeFile } from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { fileURLToPath } from "node:url";

import chokidar, { type FSWatcher } from "chokidar";
import express, { type NextFunction, type Request, type Response } from "express";

import { canonicalDir } from "./hooks.ts";
import { sectionsOf } from "./html-slice.ts";
import { injectSdk } from "./html-transform.ts";
import { isMarkdownPath, renderMarkdown } from "./markdown.ts";
import { diffSections } from "./outline.ts";
import { allowedHostnames, bindHost, defaultPort, hostnameFromHeader, stateDir } from "./paths.ts";
import type { AgentIdentityView, SectionChurn } from "./protocol.ts";
import {
  parseAlternatives,
  parseContractText,
  parseIncomingItems,
  parseItemOutcome,
  parseLockInput,
  parseMorphReport,
  parseRepoint,
  parseReviewNote,
  parseReviewPacket,
  parseThreadText,
  parseVersionLabel,
  ValidationError,
  type AgentPresence,
  type PollResult,
  type Session,
} from "./protocol.ts";
import { buildPacket, summarizePacket } from "./packet.ts";
import { renderTranscript } from "./transcript.ts";
import { commitArtifact, diffAgainstHead, gitInfo } from "./git.ts";
import { canonicalFile, SessionStore, sessionKey } from "./store/session-store.ts";
import { VersionStore } from "./store/version-store.ts";
import { stripSdk } from "./html-transform.ts";
import { renderChrome } from "./chrome/chrome-html.ts";

// Browser bundles live in dist/ next to src/, whether the server is run from
// source (bun src/cli.ts) or from an installed package.
const DIST = fileURLToPath(new URL("../dist/", import.meta.url));
const IDLE_TIMEOUT_MS = 30 * 60_000;
const ARTIFACT_EXTENSIONS = new Set([".html", ".htm", ".md", ".markdown", ".mdx"]);
/**
 * A document the browser hands back to be written. Bounded, like every input.
 *
 * Kept under the `express.json` body limit below it: a larger value here can
 * never fire, because the parser rejects the request first — and the caller
 * gets an opaque 413 instead of the message explaining what the real limit is.
 */
const MAX_WRITE_BYTES = 1_500_000;

/**
 * Markdown artifacts stay markdown on disk — the agent edits the source, the
 * browser only ever renders it. Converting HTML back to markdown would be the
 * one operation in this tool capable of corrupting the user's file, so the
 * conversion is deliberately one-way and every read path goes through here.
 */
/**
 * A section's heading, for labelling it in the churn list. Mirrors
 * `diffDocuments`'s rule so the two never disagree about what a section is
 * called. Falls back to the id, which is always present but rarely readable.
 */
function headingOf(markup: string): string | null {
  const match = /<(h[1-4]|legend|summary)\b[^>]*>([\s\S]*?)<\/\1>/i.exec(markup);
  if (!match) return null;
  const text = match[2]!.replace(/<[^>]*>/g, " ").replace(/\s+/g, " ").trim();
  return text ? text.slice(0, 60) : null;
}

export function renderArtifact(file: string, source: string): string {
  return isMarkdownPath(file) ? renderMarkdown(source, { title: path.basename(file) }).html : source;
}

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
  /** Last time a hook reported an agent turn for this session. */
  const lastContact = new Map<string, number>();
  // A hook-connected agent never opens a poll, so presence measured only by
  // activePolls reports "no agent" forever even when one is bound and receiving
  // every edit. Contact within this window counts as connected.
  const CONTACT_WINDOW_MS = 10 * 60_000;
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
    if (workingSessions.has(key)) return "working";
    if (activePolls.has(key)) return "listening";
    const seen = lastContact.get(key);
    if (seen && Date.now() - seen < CONTACT_WINDOW_MS) return "listening";
    return "waiting";
  }

  async function agentView(key: string): Promise<AgentIdentityView> {
    const session = await store.read(key);
    const seen = lastContact.get(key);
    return {
      session: session?.authoredBy ? session.authoredBy.slice(0, 8) : null,
      lastContact: seen ? new Date(seen).toISOString() : null,
      viaHooks: Boolean(seen) && !activePolls.has(key),
    };
  }

  function broadcast(key: string, event: unknown): void {
    const clients = sseClients.get(key);
    if (!clients?.size) return;
    const payload = `data: ${JSON.stringify(event)}\n\n`;
    for (const client of clients) {
      if (!client.writableEnded) client.write(payload);
    }
  }

  /** True when at least one browser is already watching this session. */
  function hasViewer(key: string): boolean {
    return (sseClients.get(key)?.size ?? 0) > 0;
  }

  function emitPresence(key: string): void {
    void agentView(key).then((agent) => broadcast(key, { type: "presence", state: presenceOf(key), agent }));
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
    // Registered before the first await, so an edit that lands during
    // initialization is queued rather than dropped.
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

    /**
     * Wait for the watcher to actually be watching.
     *
     * `chokidar.watch` returns before its initial scan finishes, so an edit made
     * in the moments after a session opens could land while nothing was listening
     * — and the failure is the worst shape this tool has: the file changes, the
     * browser never patches, and there is no error anywhere. The window is
     * milliseconds on an idle machine and long enough to be reproducible on a
     * loaded one, which is why it read as a flake rather than a bug.
     *
     * Raced against a timeout so a platform that never emits `ready` costs a
     * bounded pause instead of hanging the request that opened the session.
     */
    await new Promise<void>((resolve) => {
      const done = setTimeout(resolve, 2_000);
      done.unref();
      watcher.once("ready", () => {
        clearTimeout(done);
        resolve();
      });
    });
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
        throw new ValidationError("only .html, .htm and .md artifacts can be opened");
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
        // Lets the CLI skip launching a browser when one is already watching.
        // Re-running `plan-editor <file>` otherwise piles up tabs, each with its
        // own SSE stream, all morphing and reporting independently.
        hasViewer: hasViewer(session.key),
        url: `http://${host === "0.0.0.0" ? "127.0.0.1" : host}:${port}/s/${session.key}?t=${session.token}`,
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Open sessions, for the in-browser switcher. Token-gated: a caller must
   * already hold a valid token for *some* session. Every session belongs to the
   * same local user and the state directory is already readable by them, so
   * returning sibling URLs grants nothing they could not read off disk — but it
   * does mean this route must never be reachable without a token.
   */
  app.get("/api/sessions", async (req, res, next) => {
    try {
      const token = String(req.query.t ?? "");
      const all = await store.list();
      const authorized = all.some((entry) => entry.token === token && token.length > 0);
      if (!authorized) {
        res.status(403).json({ error: "invalid session token" });
        return;
      }
      res.json({
        sessions: all
          .filter((entry) => entry.status === "open")
          .map((entry) => ({
            key: entry.key,
            file: entry.file,
            name: entry.file.split("/").pop() ?? entry.file,
            url: `/s/${entry.key}?t=${entry.token}`,
            open: entry.reviews.flatMap((r) => r.items).filter((i) => i.status === "draft").length,
            addressed: entry.reviews.flatMap((r) => r.items).filter((i) => i.status === "answered").length,
            viewers: sseClients.get(entry.key)?.size ?? 0,
          })),
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
      const html = renderArtifact(session.file, await readFile(session.file, "utf8"));
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
      res.type("text/plain").send(renderArtifact(session.file, await readFile(session.file, "utf8")));
    } catch (error) {
      next(error);
    }
  });

  /**
   * The markdown source behind the rendered view, with the line ranges each
   * section came from. A CSS selector is useless to an agent editing markdown;
   * "PLAN.md:42-47" is what it can act on.
   */
  app.get("/artifact/:key/source", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const source = await readFile(session.file, "utf8");
      if (!isMarkdownPath(session.file)) {
        res.json({ format: "html", blocks: [] });
        return;
      }
      res.json({ format: "markdown", blocks: renderMarkdown(source, { title: path.basename(session.file) }).blocks });
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

  // --- markup phase: nothing here reaches the agent ------------------------

  app.post("/api/:key/items", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const incoming = parseIncomingItems((req.body as Record<string, unknown>)?.items);
      const created = await store.addItems(session.key, incoming);
      await syncBrowsers(session.key);
      res.json({ status: "drafted", items: created ?? [] });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/:key/items/:id", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.removeItem(session.key, String(req.params.id));
      await syncBrowsers(session.key);
      res.json({ status: "removed" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/review/note", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.setDraftNote(session.key, parseReviewNote(req.body));
      await syncBrowsers(session.key);
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  /** The one moment anything crosses to the agent. */
  app.post("/api/:key/review/send", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      // Anchoring to the current version here is what later lets the browser
      // diff the agent's work per item, spot changes nobody asked for, and
      // revert the whole review in one step.
      const base = await versions.latest(session.key);
      const review = await store.sendReview(session.key, base?.seq);
      if (!review) {
        res.status(400).json({ error: "nothing to send" });
        return;
      }
      events.emit("feedback", session.key);
      emitPresence(session.key);
      await syncBrowsers(session.key);
      res.json({ status: "sent", review });
    } catch (error) {
      next(error);
    }
  });

  // --- agent responses ------------------------------------------------------

  app.post("/api/:key/review/respond", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const summary = String((req.body as Record<string, unknown>)?.summary ?? "");
      const review = await store.respondToReview(session.key, summary);
      workingSessions.delete(session.key);
      if (summary) await store.addChat(session.key, "agent", summary);
      broadcast(session.key, { type: "agent-reply", text: summary });
      emitPresence(session.key);
      await syncBrowsers(session.key);
      res.json({ status: review ? "answered" : "no-pending-review" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/items/:id/answer", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const item = await store.answerItem(
        session.key,
        String(req.params.id),
        parseItemOutcome(body.outcome),
        typeof body.note === "string" ? body.note : undefined,
      );
      await syncBrowsers(session.key);
      res.json({ status: item ? "answered" : "not-found" });
    } catch (error) {
      next(error);
    }
  });

  /** The browser's report of which items the agent's edit actually touched. */
  app.post("/api/:key/morph-report", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const changed = await store.applyMorphReport(session.key, parseMorphReport(req.body));
      await syncBrowsers(session.key);
      res.json({ status: "ok", changed: changed?.length ?? 0 });
    } catch (error) {
      next(error);
    }
  });

  // --- human verdicts on the agent's work -----------------------------------

  app.post("/api/:key/items/:id/accept", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.setItemVerdict(session.key, String(req.params.id), "accepted");
      await syncBrowsers(session.key);
      res.json({ status: "accepted" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/items/:id/reject", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.setItemVerdict(session.key, String(req.params.id), "rejected", parseThreadText(req.body));
      // Rejections belong in the next review, not in limbo.
      await store.requeueRejected(session.key);
      await syncBrowsers(session.key);
      res.json({ status: "requeued" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * The human's side of the conversation. `chat` was stored, synced, and
   * rendered read-only for several revisions — there was no way for the human
   * to say anything back that was not attached to a specific item.
   */
  app.post("/api/:key/chat", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.addChat(session.key, "user", parseThreadText(req.body));
      // The agent hears it the same way it hears everything else.
      events.emit("feedback", session.key);
      await syncBrowsers(session.key);
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Undoes a verdict. Accept and Reject were one-way, unconfirmed, mouse-only
   * clicks on a list that re-renders every minute — a misfire was unrecoverable
   * and, in the reject case, had already requeued the item.
   */
  app.post("/api/:key/items/:id/unverdict", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const item = await store.clearVerdict(session.key, String(req.params.id));
      await syncBrowsers(session.key);
      res.json({ status: item ? "cleared" : "not-found" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/items/:id/reply", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.replyToItem(session.key, String(req.params.id), "human", parseThreadText(req.body));
      await syncBrowsers(session.key);
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/items/:id/repoint", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.repointItem(session.key, String(req.params.id), parseRepoint(req.body));
      await syncBrowsers(session.key);
      res.json({ status: "repointed" });
    } catch (error) {
      next(error);
    }
  });

  // --- the standing contract ------------------------------------------------
  //
  // Scoped to the artifact, not to a review. Everything else here is consumed
  // by one exchange; these rules are injected ahead of every future one.

  app.get("/api/:key/contract", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      res.json({ contract: session.contract, active: store.activeContract(session) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/contract", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const rule = await store.addContractRule(session.key, parseContractText(req.body));
      await syncBrowsers(session.key);
      res.json({ status: "added", rule });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/:key/contract/:id", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.retireContractRule(session.key, String(req.params.id));
      await syncBrowsers(session.key);
      res.json({ status: "retired" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/contract/:id/restore", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.restoreContractRule(session.key, String(req.params.id));
      await syncBrowsers(session.key);
      res.json({ status: "restored" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Turns a rejection into a standing rule. Rejection reasons were the highest
   * signal in the system and the only thing done with them was requeueing the
   * item — the reason generalises, the item does not.
   */
  app.post("/api/:key/items/:id/promote", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const rule = await store.promoteRejection(
        session.key,
        String(req.params.id),
        typeof body.text === "string" ? body.text : undefined,
      );
      await syncBrowsers(session.key);
      res.json(rule ? { status: "promoted", rule } : { status: "nothing-to-promote" });
    } catch (error) {
      next(error);
    }
  });

  // --- locks ----------------------------------------------------------------

  app.post("/api/:key/locks", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const lock = await store.addLock(session.key, parseLockInput(req.body));
      await syncBrowsers(session.key);
      res.json({ status: "locked", lock });
    } catch (error) {
      next(error);
    }
  });

  app.delete("/api/:key/locks/:id", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      await store.removeLock(session.key, String(req.params.id));
      await syncBrowsers(session.key);
      res.json({ status: "unlocked" });
    } catch (error) {
      next(error);
    }
  });

  // --- the clarification round trip -----------------------------------------

  /** The agent asks. Not same-origin gated: the caller is the CLI. */
  app.post("/api/:key/items/:id/ask", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const item = await store.askOnItem(session.key, String(req.params.id), parseThreadText(req.body));
      await syncBrowsers(session.key);
      res.json({ status: item ? "asked" : "not-found" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * Parks until *this item's* question is answered.
   *
   * The obvious implementation — long-poll `/api/poll` and look at the result —
   * is wrong, and quietly so: an item can only be asked about while its review
   * is still pending, so `takeFeedback` returns that review immediately and the
   * agent unparks with `answer: null` a millisecond after asking. It then
   * proceeds to guess, which is the exact failure asking was meant to prevent.
   */
  app.get("/api/:key/items/:id/await-answer", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const itemId = String(req.params.id);

      const settledItem = async () => {
        const current = await store.read(session.key);
        const item = current?.reviews.flatMap((review) => review.items).find((entry) => entry.id === itemId);
        if (!item) return { status: "not-found" as const };
        return item.awaitingHuman ? null : { status: "answered" as const, item };
      };

      const immediate = await settledItem();
      if (immediate) {
        res.json(immediate);
        return;
      }

      const timeoutMs = req.query.timeoutMs === undefined ? 45_000 : Number(req.query.timeoutMs);
      let settled = false;
      const finish = async () => {
        if (settled || res.writableEnded) return;
        const result = await settledItem();
        if (!result) return; // a different item was answered; keep waiting
        settled = true;
        cleanup();
        res.json(result);
      };
      const onAnswered = (changed: string) => {
        if (changed === session.key) void finish();
      };
      const timer = setTimeout(() => {
        if (settled || res.writableEnded) return;
        settled = true;
        cleanup();
        res.json({ status: "waiting" });
      }, Math.max(0, timeoutMs));
      function cleanup(): void {
        clearTimeout(timer);
        events.off("answered", onAnswered);
        events.off("ended", onAnswered);
        refreshIdle();
      }
      events.on("answered", onAnswered);
      events.on("ended", onAnswered);
      req.on("close", () => {
        if (settled) return;
        settled = true;
        cleanup();
      });
    } catch (error) {
      next(error);
    }
  });

  /** The human answers, which is the event the parked agent is waiting on. */
  app.post("/api/:key/items/:id/answer-question", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const item = await store.answerQuestion(session.key, String(req.params.id), parseThreadText(req.body));
      events.emit("answered", session.key);
      // An answered question makes the review pending again, so a plain `watch`
      // picks it up too — the agent should not need a special command to hear a
      // reply it asked for.
      events.emit("feedback", session.key);
      await syncBrowsers(session.key);
      res.json({ status: item ? "answered" : "not-found" });
    } catch (error) {
      next(error);
    }
  });

  // --- alternatives ---------------------------------------------------------

  app.post("/api/:key/items/:id/alternatives", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const item = await store.setAlternatives(session.key, String(req.params.id), parseAlternatives(req.body));
      await syncBrowsers(session.key);
      res.json({ status: item ? "offered" : "not-found" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/items/:id/choose", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const item = await store.chooseAlternative(session.key, String(req.params.id), String(body.alternative ?? ""));
      events.emit("answered", session.key);
      events.emit("feedback", session.key);
      await syncBrowsers(session.key);
      res.json({ status: item ? "chosen" : "not-found" });
    } catch (error) {
      next(error);
    }
  });

  // --- writing a document the browser computed ------------------------------

  /**
   * Surgical revert and structural undo both need one *section* put back, not
   * the whole file, and the merge has to happen where a real DOM already is —
   * the same reason `diffDocuments` runs in the browser. So the browser sends
   * the finished document and the server owns the write.
   *
   * This is no more capability than `/restore` already grants a same-origin
   * caller holding the token, but it is unbounded content rather than a
   * snapshot, so it is size-capped and goes through the same atomic write and
   * snapshot as every other change.
   */
  app.post("/api/:key/write", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const html = String(body.html ?? "");
      if (!html.trim()) throw new ValidationError("html must not be empty");
      if (Buffer.byteLength(html) > MAX_WRITE_BYTES) throw new ValidationError("document is too large to write");
      if (isMarkdownPath(session.file)) {
        // The browser holds rendered HTML; writing it back over the source
        // would replace the user's markdown with the render of it.
        res.status(409).json({ error: "markdown artifacts cannot be written back from the browser" });
        return;
      }
      await writeFile(session.file, html);
      await versions.snapshot(session.key, html, "restore");
      if (typeof body.itemId === "string") await store.markReverted(session.key, body.itemId);
      await syncBrowsers(session.key);
      res.json({ status: "written" });
    } catch (error) {
      next(error);
    }
  });

  // --- history: names, pins, churn ------------------------------------------

  app.post("/api/:key/versions/:seq/label", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const meta = await versions.annotate(session.key, Number(req.params.seq), parseVersionLabel(req.body));
      broadcast(session.key, { type: "versions", list: await versions.list(session.key) });
      res.json(meta ? { status: "ok", version: meta } : { status: "not-found" });
    } catch (error) {
      next(error);
    }
  });

  /**
   * What changed between a version and the artifact as it stands.
   *
   * The browser has had this since attribution existed; the agent has not, so it
   * applies a review, reports a summary, and never finds out whether it changed
   * more than it meant to. Computed here because this is where the version store
   * lives, and by id rather than by line for the reason `diffDocuments` is: one
   * reflowed paragraph rewrites a 400-character line.
   */
  app.get("/api/:key/diff", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const list = await versions.list(session.key);
      const fallback = list[list.length - 2]?.seq ?? list[list.length - 1]?.seq;
      const from = req.query.from === undefined ? fallback : Number(req.query.from);
      if (from === undefined || !Number.isFinite(from)) {
        res.status(400).json({ error: "no earlier version to compare against" });
        return;
      }
      const before = await versions.read(session.key, from);
      if (before === null) {
        res.status(404).json({ error: `version ${from} is not in history` });
        return;
      }
      const after = await readFile(session.file, "utf8");
      // Rendered on both sides for a markdown artifact, exactly as churn does:
      // the ids the agent and the human both talk about are the renderer's.
      res.json({
        from,
        changes: diffSections(renderArtifact(session.file, before), renderArtifact(session.file, after)),
      });
    } catch (error) {
      next(error);
    }
  });

  /**
   * How often each section has been rewritten. A section rewritten six times is
   * one the human and the agent still disagree about — the tool held every
   * snapshot needed to say so and never said it.
   */
  app.get("/api/:key/churn", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const list = await versions.list(session.key);
      const counts = new Map<string, { label: string; rewrites: number; lastAt: string }>();
      let previous: Map<string, string> | null = null;
      for (const meta of list) {
        const source = await versions.read(session.key, meta.seq);
        if (source === null) continue;
        const current = sectionsOf(renderArtifact(session.file, source));
        if (previous) {
          for (const [id, markup] of current) {
            if (!previous.has(id) || previous.get(id) === markup) continue;
            const entry = counts.get(id) ?? { label: headingOf(markup) ?? id, rewrites: 0, lastAt: meta.at };
            entry.rewrites += 1;
            entry.lastAt = meta.at;
            // Relabel from the newest markup seen: a section whose heading was
            // rewritten should be listed under what it is called now.
            entry.label = headingOf(markup) ?? entry.label;
            counts.set(id, entry);
          }
        }
        previous = current;
      }
      const churn: SectionChurn[] = [...counts.entries()]
        .map(([id, entry]) => ({ id, ...entry }))
        .sort((a, b) => b.rewrites - a.rewrites);
      res.json({ churn });
    } catch (error) {
      next(error);
    }
  });

  // --- the record: transcript, packets, git ---------------------------------

  app.get("/api/:key/transcript", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const markdown = renderTranscript(session, { versions: await versions.list(session.key) });
      res
        .type("text/markdown")
        .set("Content-Disposition", 'attachment; filename="review-transcript.md"')
        .send(markdown);
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/packet/:reviewId", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const review = session.reviews.find((entry) => entry.id === String(req.params.reviewId));
      if (!review) {
        res.status(404).json({ error: "review not found" });
        return;
      }
      const packet = buildPacket(session, review, await readFile(session.file, "utf8"));
      res
        .type("application/json")
        .set("Content-Disposition", 'attachment; filename="review.packet.json"')
        .send(JSON.stringify(packet, null, 2));
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/packet/import", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const packet = parseReviewPacket(body.packet);
      const summary = summarizePacket(packet, await readFile(session.file, "utf8"));
      const from = typeof body.from === "string" && body.from.trim() ? body.from.slice(0, 80) : "an imported review";
      const imported = await store.importPacket(session.key, packet, from);
      await syncBrowsers(session.key);
      // Imported items land in the draft, never as a sent review: the artifact's
      // owner decides what crosses to their agent, exactly as with their own
      // markup.
      res.json({ status: "imported", items: imported ?? 0, drift: summary.drift, note: summary.note });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/git", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      res.json({ git: await gitInfo(session.file), diff: await diffAgainstHead(session.file) });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/git/commit", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const message = String(body.message ?? "").trim();
      if (!message) throw new ValidationError("a commit message is required");
      res.json(await commitArtifact(session.file, message.slice(0, 2_000)));
    } catch (error) {
      next(error);
    }
  });

  // --- review sets ----------------------------------------------------------

  /**
   * Artifacts reviewed together. A note like "these three disagree about the
   * retry budget" is not expressible against a single file, and the agent
   * cannot answer it without being told the set.
   */
  app.post("/api/:key/companions", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const body = (req.body ?? {}) as Record<string, unknown>;
      const raw = Array.isArray(body.files) ? body.files : [];
      const files: string[] = [];
      for (const entry of raw.slice(0, 20)) {
        if (typeof entry !== "string") continue;
        // Resolve server-side for the same reason session creation does: a
        // client-supplied path must never become a path the server trusts.
        const canonical = await canonicalFile(entry).catch(() => null);
        if (!canonical || !ARTIFACT_EXTENSIONS.has(path.extname(canonical).toLowerCase())) continue;
        const info = await stat(canonical).catch(() => null);
        if (info?.isFile()) files.push(canonical);
      }
      const saved = await store.setCompanions(session.key, files);
      await syncBrowsers(session.key);
      res.json({ status: "ok", companions: saved ?? [] });
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
  // Heartbeat from any hook: proof an agent turn is happening for this session.
  app.post("/api/:key/agent-contact", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      lastContact.set(session.key, Date.now());
      emitPresence(session.key);
      res.json({ status: "ok" });
    } catch (error) {
      next(error);
    }
  });

  app.post("/api/:key/agent-activity", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      lastContact.set(session.key, Date.now());
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
      const source = await versions.read(session.key, Number(req.params.seq));
      if (source === null) {
        res.status(404).json({ error: "version not found" });
        return;
      }
      // Snapshots hold the source, so a markdown history renders on the way out
      // and restores as markdown on the way back in. Storing the rendered form
      // instead would make restore write HTML over the user's .md.
      res.type("text/plain").send(renderArtifact(session.file, source));
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

  /** Puts the artifact back to how it looked before a review was sent. */
  app.post("/api/:key/review/:id/revert", requireSameOrigin, async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      const review = session.reviews.find((entry) => entry.id === String(req.params.id));
      if (!review?.baseVersion) {
        res.status(400).json({ error: "this review has no recorded starting point" });
        return;
      }
      const html = await versions.read(session.key, review.baseVersion);
      if (html === null) {
        res.status(410).json({ error: "the starting version has aged out of history" });
        return;
      }
      await writeFile(session.file, html);
      await versions.snapshot(session.key, html, "restore");
      res.json({ status: "reverted", seq: review.baseVersion });
    } catch (error) {
      next(error);
    }
  });

  app.get("/api/:key/export", async (req, res, next) => {
    try {
      const session = await loadAuthorized(req, res);
      if (!session) return;
      // Markdown is rendered, not copied: an export is a standalone readable
      // copy, and the source would open as a wall of unformatted text.
      const source = await readFile(session.file, "utf8");
      const html = isMarkdownPath(session.file) ? renderArtifact(session.file, source) : stripSdk(source);
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

      res.write(
        `data: ${JSON.stringify({
          type: "sync",
          reviews: session.reviews,
          chat: session.chat,
          contract: session.contract,
          locks: session.locks,
          companions: session.companions,
        })}\n\n`,
      );
      res.write(
        `data: ${JSON.stringify({ type: "presence", state: presenceOf(session.key), agent: await agentView(session.key) })}\n\n`,
      );
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

      // Optional: a CLI outside a Claude Code session has no id to send. Absent
      // it, nothing is stamped and every delivery is treated as a first one —
      // costlier, never wrong.
      const agentKey = String(req.query.agent ?? "").slice(0, 64) || undefined;

      const immediate = await takeFeedback(key, agentKey);
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
        res.json(await takeFeedback(key, agentKey));
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

  /**
   * Where each id'd block of a markdown artifact lives in the source.
   *
   * Computed at poll time rather than stored: the file moves under the review,
   * and a line number recorded when the note was written would point at the
   * wrong line by the time the agent read it.
   */
  async function sourceLinesFor(session: Session): Promise<Record<string, { line: number; endLine: number }> | null> {
    if (!isMarkdownPath(session.file)) return null;
    const source = await readFile(session.file, "utf8").catch(() => null);
    if (source === null) return null;
    const map: Record<string, { line: number; endLine: number }> = {};
    for (const block of renderMarkdown(source, { title: path.basename(session.file) }).blocks) {
      map[block.id] = { line: block.line, endLine: block.endLine };
    }
    return map;
  }

  /**
   * `agentKey` is how a repeat delivery is recognised.
   *
   * Tracked per agent session for the same reason hook delivery is: with one
   * global stamp, whichever agent polled first would consume the full text and
   * every other session — including the one that wrote the plan — would get the
   * compacted form of a review it had never seen.
   */
  async function takeFeedback(key: string, agentKey?: string): Promise<PollResult> {
    const session = await store.read(key);
    if (!session) return { status: "waiting" };
    // Only a *sent* review crosses to the agent. A draft is the human's private
    // workspace, however many notes are in it.
    const review = session.reviews.find((entry) => entry.status === "sent");
    if (!review) {
      return session.status === "ended" ? { status: "ended", endedBy: session.endedBy ?? "agent" } : { status: "waiting" };
    }
    const repeat = Boolean(agentKey && (review.deliveredTo ?? []).includes(agentKey));
    if (agentKey && !repeat) await store.markDelivered(key, review.id, agentKey);
    const sourceLines = await sourceLinesFor(session);
    return {
      status: "review",
      review,
      ...(repeat ? { repeat: true } : {}),
      // The standing contract rides along with every review, never instead of
      // one. The rules are what stop round four repeating round one's
      // correction, and an agent that only ever sees this review cannot know
      // them.
      ...(store.activeContract(session).length ? { contract: store.activeContract(session) } : {}),
      ...(session.locks.length ? { locks: session.locks } : {}),
      ...(session.companions.length ? { companions: session.companions } : {}),
      ...(sourceLines ? { sourceLines } : {}),
      ...(session.status === "ended" ? { sessionEnded: true, endedBy: session.endedBy ?? "user" } : {}),
    };
  }

  async function syncBrowsers(key: string): Promise<void> {
    const session = await store.read(key);
    if (!session) return;
    broadcast(key, {
      type: "sync",
      reviews: session.reviews,
      chat: session.chat,
      contract: session.contract,
      locks: session.locks,
      companions: session.companions,
    });
  }

  // Static browser bundles. `no-cache` means "revalidate every time", not "never
  // store" — without it these URLs are unversioned and the browser may serve a
  // heuristically-cached copy, so a tab keeps running old SDK code after a
  // rebuild and the fix appears not to have worked.
  const bundle = (file: string, type: string) => (_req: Request, res: Response) => {
    res.type(type).set("Cache-Control", "no-cache").sendFile(path.join(DIST, file));
  };
  app.get("/sdk.js", bundle("sdk.js", "application/javascript"));
  // Fetched by the SDK only when the artifact actually contains a diagram.
  app.get("/mermaid.js", bundle("mermaid.js", "application/javascript"));
  app.get("/chrome.js", bundle("chrome.js", "application/javascript"));
  app.get("/chrome.css", bundle("chrome.css", "text/css"));

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

  /**
   * Resolves once the server has actually stopped, so the detached process can
   * exit rather than linger.
   *
   * It used to have no way to know: `shutdown()` closed the HTTP server and the
   * CLI parked forever on a promise that never settled, so every restart left
   * the old process alive holding ~9MB. Because the server's identity folds in
   * a code signature, *every* edit to src/ triggers a restart — so this leaked
   * one process per edit, invisibly, and 48 of them were found running.
   */
  let markClosed: () => void;
  const closed = new Promise<void>((resolve) => {
    markClosed = resolve;
  });

  async function shutdown(): Promise<void> {
    if (idleTimer) clearTimeout(idleTimer);
    for (const watcher of watchers.values()) await watcher.close();
    watchers.clear();
    for (const clients of sseClients.values()) {
      for (const client of clients) client.end();
    }
    server.closeAllConnections();
    await new Promise<void>((resolve) => server.close(() => resolve()));
    markClosed();
  }

  return {
    port: (server.address() as { port: number }).port,
    store,
    shutdown,
    closed,
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

