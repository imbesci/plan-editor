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

import type {
  Anchor,
  ChatMessage,
  ItemOutcome,
  Review,
  ReviewItem,
  Session,
  ThreadMessage,
} from "../protocol.ts";
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
      const session = JSON.parse(raw) as Session & { annotations?: unknown[] };
      // Records written before reviews existed carried a flat annotation list.
      if (!Array.isArray(session.reviews)) session.reviews = [];
      if ("annotations" in session) delete session.annotations;
      return session;
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
        reviews: [],
        chat: [],
        createdAt: now,
        updatedAt: now,
      };
      await this.write(session);
      return session;
    });
  }

  /** The review currently being marked up, created on demand. */
  private draftOf(session: Session): Review {
    const existing = session.reviews.find((review) => review.status === "drafting");
    if (existing) return existing;
    const review: Review = {
      id: newId(),
      note: "",
      status: "drafting",
      items: [],
      createdAt: new Date().toISOString(),
    };
    session.reviews.push(review);
    return review;
  }

  /**
   * Adds a note to the draft review. Nothing reaches the agent until the human
   * sends it — that separation is the whole point of the batch model.
   */
  async addItems(
    key: string,
    incoming: Array<{ body: string; selector: string; text: string; anchors?: Anchor[]; tag: ReviewItem["tag"] }>,
  ): Promise<ReviewItem[] | null> {
    return this.mutate(key, (session) => {
      const draft = this.draftOf(session);
      const now = new Date().toISOString();
      const created = incoming.map<ReviewItem>((entry) => ({
        ...entry,
        id: newId(),
        status: "draft",
        createdAt: now,
      }));
      draft.items.push(...created);
      return created;
    });
  }

  async removeItem(key: string, itemId: string): Promise<boolean | null> {
    return this.mutate(key, (session) => {
      const draft = session.reviews.find((review) => review.status === "drafting");
      if (!draft) return false;
      const before = draft.items.length;
      draft.items = draft.items.filter((item) => item.id !== itemId);
      return draft.items.length !== before;
    });
  }

  async setDraftNote(key: string, note: string): Promise<Review | null> {
    return this.mutate(key, (session) => {
      const draft = this.draftOf(session);
      draft.note = note;
      return draft;
    });
  }

  /** Hands the draft to the agent as one batch. */
  async sendReview(key: string): Promise<Review | null> {
    return this.mutate(key, (session) => {
      const draft = session.reviews.find((review) => review.status === "drafting");
      if (!draft || (draft.items.length === 0 && !draft.note.trim())) return null;
      const now = new Date().toISOString();
      draft.status = "sent";
      draft.sentAt = now;
      for (const item of draft.items) item.status = "sent";
      return draft;
    });
  }

  /** The review the agent should be working on, if any. */
  async pendingReview(key: string): Promise<Review | null> {
    const session = await this.read(key);
    return session?.reviews.find((review) => review.status === "sent") ?? null;
  }

  async markDelivered(key: string, reviewId: string, agentKey: string): Promise<void> {
    await this.mutate(key, (session) => {
      const review = session.reviews.find((entry) => entry.id === reviewId);
      if (!review) return;
      const seen = new Set(review.deliveredTo ?? []);
      seen.add(agentKey);
      review.deliveredTo = [...seen].slice(-20);
    });
  }

  /**
   * Records how the agent handled one item. `answered` means the agent is done
   * with it either way — the human then accepts or rejects.
   */
  async answerItem(key: string, itemId: string, outcome: ItemOutcome, agentNote?: string): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        item.status = "answered";
        item.outcome = outcome;
        item.answeredAt = new Date().toISOString();
        if (agentNote !== undefined) item.agentNote = agentNote;
        return item;
      }
      return null;
    });
  }

  /** Closes out a review with the agent's overall response. */
  async respondToReview(key: string, summary: string): Promise<Review | null> {
    return this.mutate(key, (session) => {
      const review = session.reviews.find((entry) => entry.status === "sent");
      if (!review) return null;
      const now = new Date().toISOString();
      review.summary = summary;
      review.status = "answered";
      review.answeredAt = now;
      // Anything the agent did not speak to is still answered — silence here
      // would leave items stuck with no way for the human to act on them.
      for (const item of review.items) {
        if (item.status === "sent") {
          item.status = "answered";
          item.outcome = item.outcome ?? "applied";
          item.answeredAt = now;
        }
      }
      return review;
    });
  }

  async applyMorphReport(
    key: string,
    report: { addressed: string[]; orphaned: string[] },
  ): Promise<ReviewItem[] | null> {
    return this.mutate(key, (session) => {
      const addressed = new Set(report.addressed);
      const orphaned = new Set(report.orphaned);
      const now = new Date().toISOString();
      const changed: ReviewItem[] = [];
      for (const review of session.reviews) {
        for (const item of review.items) {
          if (item.status !== "sent") continue;
          if (addressed.has(item.id)) {
            item.status = "answered";
            item.outcome = item.outcome ?? "applied";
            item.answeredAt = now;
            changed.push(item);
          } else if (orphaned.has(item.id)) {
            item.status = "orphaned";
            changed.push(item);
          }
        }
      }
      return changed;
    });
  }

  async setItemVerdict(key: string, itemId: string, verdict: "accepted" | "rejected", reason?: string): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        item.status = verdict;
        if (reason) {
          item.thread = [...(item.thread ?? []), { role: "human", text: reason, at: new Date().toISOString() }];
        }
        if (review.items.every((entry) => entry.status === "accepted" || entry.status === "rejected")) {
          review.status = "closed";
        }
        return item;
      }
      return null;
    });
  }

  /**
   * Moves rejected items into a fresh draft so they go back to the agent with
   * the next review. A rejection the agent never hears about is the worst
   * possible outcome.
   */
  async requeueRejected(key: string): Promise<number | null> {
    return this.mutate(key, (session) => {
      const draft = this.draftOf(session);
      let moved = 0;
      for (const review of session.reviews) {
        if (review === draft) continue;
        for (const item of review.items) {
          if (item.status !== "rejected" || item.requeued) continue;
          const last = item.thread?.[item.thread.length - 1]?.text;
          draft.items.push({
            id: newId(),
            body: last ? `${item.body} — previously rejected: ${last}` : item.body,
            selector: item.selector,
            text: item.text,
            ...(item.anchors ? { anchors: item.anchors } : {}),
            tag: item.tag,
            status: "draft",
            createdAt: new Date().toISOString(),
          });
          // Stays `rejected` — recording it as accepted would show the human the
          // opposite of the verdict they gave. `requeued` is what stops it being
          // carried forward twice.
          item.requeued = true;
          moved += 1;
        }
      }
      return moved;
    });
  }

  async repointItem(key: string, itemId: string, anchor: { selector: string; text: string }): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        item.selector = anchor.selector;
        item.text = anchor.text;
        delete item.anchors;
        item.status = review.status === "drafting" ? "draft" : "sent";
        return item;
      }
      return null;
    });
  }

  async replyToItem(key: string, itemId: string, role: ThreadMessage["role"], text: string): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        item.thread = [...(item.thread ?? []), { role, text, at: new Date().toISOString() }];
        return item;
      }
      return null;
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
