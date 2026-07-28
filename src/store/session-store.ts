// One file per session, never a single global document.
//
// lavish-axi kept every session for every project in one state.json and
// rewrote the whole thing on every mutation, so (a) two projects clobbered each
// other, and (b) every sibling-asset request re-parsed the entire file. Sessions
// here are independent files under <stateDir>/sessions/<key>.json, so a write
// touches one session and a read parses one small document.

import crypto from "node:crypto";
import { mkdir, readFile, readdir, realpath, rm } from "node:fs/promises";
import path from "node:path";

import type { Annotation, ChatMessage, Session, ThreadMessage } from "../protocol.ts";
import { queued, writeFileAtomically } from "./atomic.ts";

export function sessionKey(canonicalPath: string): string {
  return crypto.createHash("sha256").update(canonicalPath).digest("hex").slice(0, 16);
}

/**
 * The capability token is the actual credential. The key is a hash of a path an
 * attacker can guess, so it must never be sufficient on its own to read an
 * artifact — see server.ts's requireToken.
 */
function mintToken(): string {
  return crypto.randomBytes(24).toString("base64url");
}

function newId(): string {
  return crypto.randomBytes(9).toString("base64url");
}

export async function canonicalFile(file: string): Promise<string> {
  return realpath(path.resolve(file));
}

export class SessionStore {
  readonly dir: string;

  constructor(stateDir: string) {
    this.dir = path.join(stateDir, "sessions");
  }

  async init(): Promise<void> {
    await mkdir(this.dir, { recursive: true });
  }

  private file(key: string): string {
    return path.join(this.dir, `${key}.json`);
  }

  async read(key: string): Promise<Session | null> {
    try {
      const raw = await readFile(this.file(key), "utf8");
      return JSON.parse(raw) as Session;
    } catch (error) {
      if ((error as NodeJS.ErrnoException).code === "ENOENT") return null;
      throw error;
    }
  }

  private async write(session: Session): Promise<void> {
    session.updatedAt = new Date().toISOString();
    await writeFileAtomically(this.file(session.key), `${JSON.stringify(session, null, 2)}\n`);
  }

  /**
   * The only mutation path. Every caller runs inside the per-key queue, so a
   * read-modify-write can never interleave with another mutation of the same
   * session.
   */
  private mutate<T>(key: string, fn: (session: Session) => T | Promise<T>): Promise<T | null> {
    return queued(key, async () => {
      const session = await this.read(key);
      if (!session) return null;
      const result = await fn(session);
      await this.write(session);
      return result;
    });
  }

  async list(): Promise<Session[]> {
    let entries: string[];
    try {
      entries = await readdir(this.dir);
    } catch {
      return [];
    }
    const sessions: Session[] = [];
    for (const entry of entries) {
      if (!entry.endsWith(".json")) continue;
      const session = await this.read(entry.slice(0, -".json".length));
      if (session) sessions.push(session);
    }
    return sessions.sort((a, b) => a.file.localeCompare(b.file));
  }

  async open(canonicalPath: string, origin: { authoredBy?: string; authoredIn?: string } = {}): Promise<Session> {
    const key = sessionKey(canonicalPath);
    return queued(key, async () => {
      const existing = await this.read(key);
      if (existing) {
        // Reopening from a different agent session re-points ownership: the
        // agent that just opened it is the one now working on it.
        if (origin.authoredBy) existing.authoredBy = origin.authoredBy;
        if (origin.authoredIn) existing.authoredIn = origin.authoredIn;
        // Reopening keeps the token stable so an already-open browser tab does
        // not lose access, and keeps annotations so an in-flight review survives
        // a server restart.
        existing.status = "open";
        delete existing.endedBy;
        await this.write(existing);
        return existing;
      }
      const now = new Date().toISOString();
      const session: Session = {
        key,
        token: mintToken(),
        file: canonicalPath,
        status: "open",
        ...(origin.authoredBy ? { authoredBy: origin.authoredBy } : {}),
        ...(origin.authoredIn ? { authoredIn: origin.authoredIn } : {}),
        annotations: [],
        chat: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.write(session);
      return session;
    });
  }

  async addAnnotations(
    key: string,
    incoming: Array<Omit<Annotation, "id" | "status" | "createdAt">>,
  ): Promise<Annotation[] | null> {
    return this.mutate(key, (session) => {
      const now = new Date().toISOString();
      const created = incoming.map<Annotation>((entry) => ({
        ...entry,
        id: newId(),
        status: "submitted",
        createdAt: now,
        submittedAt: now,
      }));
      session.annotations.push(...created);
      for (const annotation of created) {
        if (annotation.tag === "message") {
          session.chat.push({ role: "user", text: annotation.body, at: now });
        }
      }
      return created;
    });
  }

  /** Returns the annotations the agent has not seen resolved yet. */
  async openAnnotations(key: string): Promise<Annotation[]> {
    const session = await this.read(key);
    if (!session) return [];
    return session.annotations.filter((annotation) => annotation.status === "submitted");
  }

  /**
   * Applies the browser's post-morph report. `addressed` means the agent's edit
   * actually touched the anchored element; `orphaned` means the element is gone.
   */
  async applyMorphReport(
    key: string,
    report: { addressed: string[]; orphaned: string[] },
  ): Promise<Annotation[] | null> {
    return this.mutate(key, (session) => {
      const addressed = new Set(report.addressed);
      const orphaned = new Set(report.orphaned);
      const now = new Date().toISOString();
      const changed: Annotation[] = [];
      for (const annotation of session.annotations) {
        if (annotation.status !== "submitted") continue;
        if (addressed.has(annotation.id)) {
          annotation.status = "addressed";
          annotation.addressedAt = now;
          changed.push(annotation);
        } else if (orphaned.has(annotation.id)) {
          annotation.status = "orphaned";
          changed.push(annotation);
        }
      }
      return changed;
    });
  }

  /** Records that these edits' full text reached a particular agent session. */
  async markDelivered(key: string, ids: string[], agentKey: string): Promise<void> {
    const wanted = new Set(ids);
    await this.mutate(key, (session) => {
      for (const annotation of session.annotations) {
        if (!wanted.has(annotation.id)) continue;
        const seen = new Set(annotation.deliveredTo ?? []);
        seen.add(agentKey);
        annotation.deliveredTo = [...seen].slice(-20);
      }
    });
  }

  /**
   * Human accepts the agent's change. Terminal — the edit is done with.
   */
  async acceptAnnotation(key: string, id: string): Promise<Annotation | null> {
    return this.mutate(key, (session) => {
      const annotation = session.annotations.find((entry) => entry.id === id);
      if (!annotation || annotation.status !== "addressed") return null;
      annotation.status = "resolved";
      return annotation;
    });
  }

  /**
   * Human rejects the agent's change. This reopens the edit rather than closing
   * it, and clears the delivery record so the agent gets the full text again —
   * a rejection the agent never hears about is the worst possible outcome.
   */
  async rejectAnnotation(key: string, id: string, reason: string): Promise<Annotation | null> {
    return this.mutate(key, (session) => {
      const annotation = session.annotations.find((entry) => entry.id === id);
      if (!annotation) return null;
      annotation.status = "submitted";
      annotation.deliveredTo = [];
      delete annotation.addressedAt;
      annotation.thread = [
        ...(annotation.thread ?? []),
        { role: "human", text: `Rejected: ${reason}`, at: new Date().toISOString() },
      ];
      return annotation;
    });
  }

  async replyToAnnotation(
    key: string,
    id: string,
    role: ThreadMessage["role"],
    text: string,
  ): Promise<Annotation | null> {
    return this.mutate(key, (session) => {
      const annotation = session.annotations.find((entry) => entry.id === id);
      if (!annotation) return null;
      annotation.thread = [...(annotation.thread ?? []), { role, text, at: new Date().toISOString() }];
      // A human reply on a settled edit reopens it; otherwise the agent never
      // sees the follow-up.
      if (role === "human" && annotation.status !== "submitted") {
        annotation.status = "submitted";
        annotation.deliveredTo = [];
      }
      return annotation;
    });
  }

  /** Re-anchors an orphaned edit onto a new element the human picked. */
  async repointAnnotation(key: string, id: string, anchor: { selector: string; text: string }): Promise<Annotation | null> {
    return this.mutate(key, (session) => {
      const annotation = session.annotations.find((entry) => entry.id === id);
      if (!annotation) return null;
      annotation.selector = anchor.selector;
      annotation.text = anchor.text;
      annotation.status = "submitted";
      annotation.deliveredTo = [];
      return annotation;
    });
  }

  async setAnnotationStatus(
    key: string,
    id: string,
    status: Annotation["status"],
    agentNote?: string,
  ): Promise<Annotation | null> {
    return this.mutate(key, (session) => {
      const annotation = session.annotations.find((entry) => entry.id === id);
      if (!annotation) return null;
      annotation.status = status;
      if (agentNote !== undefined) annotation.agentNote = agentNote;
      if (status === "addressed") annotation.addressedAt = new Date().toISOString();
      return annotation;
    });
  }

  async addChat(key: string, role: ChatMessage["role"], text: string): Promise<ChatMessage | null> {
    return this.mutate(key, (session) => {
      const message: ChatMessage = { role, text, at: new Date().toISOString() };
      session.chat.push(message);
      // Unbounded chat was a real growth driver in lavish-axi; cap it here.
      if (session.chat.length > 500) session.chat.splice(0, session.chat.length - 500);
      return message;
    });
  }

  async end(key: string, endedBy: "user" | "agent"): Promise<Session | null> {
    return queued(key, async () => {
      const session = await this.read(key);
      if (!session) return null;
      session.status = "ended";
      session.endedBy = session.endedBy === "user" ? "user" : endedBy;
      await this.write(session);
      return session;
    });
  }

  async remove(key: string): Promise<void> {
    await queued(key, async () => {
      await rm(this.file(key), { force: true });
    });
  }

  /** Drops ended sessions older than `maxAgeMs`. Nothing pruned itself in lavish-axi. */
  async prune(maxAgeMs: number, now = Date.now()): Promise<number> {
    const sessions = await this.list();
    let removed = 0;
    for (const session of sessions) {
      if (session.status !== "ended") continue;
      if (now - Date.parse(session.updatedAt) < maxAgeMs) continue;
      await this.remove(session.key);
      removed += 1;
    }
    return removed;
  }
}
