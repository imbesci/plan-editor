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
  Alternative,
  ChatMessage,
  ContractRule,
  IncomingItem,
  ItemOutcome,
  Lock,
  Review,
  ReviewItem,
  ReviewPacket,
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
      // Records written before the standing contract, locks, and review sets.
      // Defaulting on read rather than migrating on write means an old session
      // opens without a rewrite pass and a downgrade loses nothing.
      if (!Array.isArray(session.contract)) session.contract = [];
      if (!Array.isArray(session.locks)) session.locks = [];
      if (!Array.isArray(session.companions)) session.companions = [];
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
        contract: [],
        locks: [],
        companions: [],
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
  async addItems(key: string, incoming: IncomingItem[]): Promise<ReviewItem[] | null> {
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
  async sendReview(key: string, baseVersion?: number): Promise<Review | null> {
    return this.mutate(key, (session) => {
      const draft = session.reviews.find((review) => review.status === "drafting");
      if (!draft || (draft.items.length === 0 && !draft.note.trim())) return null;
      const now = new Date().toISOString();
      draft.status = "sent";
      draft.sentAt = now;
      if (baseVersion !== undefined) draft.baseVersion = baseVersion;
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
   * Puts an item back to `answered`, undoing an accept or reject.
   *
   * A rejection that was already requeued leaves its copy in the draft; that
   * copy is the human's to delete. Silently hunting it down and removing it
   * would mean an undo that also deletes something the human may have since
   * edited.
   */
  async clearVerdict(key: string, itemId: string): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        if (item.status !== "accepted" && item.status !== "rejected") return null;
        item.status = "answered";
        delete item.revertedAt;
        if (review.status === "closed") review.status = "answered";
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

  // --- the standing contract -----------------------------------------------
  //
  // Everything above is scoped to one review. A contract rule is not: it is
  // injected ahead of every review from now on, which is the only thing that
  // stops the same correction being made in round four that was made in round
  // one. Repeat corrections are the tax that makes iterating with an agent feel
  // slower than writing it yourself.

  async addContractRule(key: string, text: string, fromItemId?: string): Promise<ContractRule | null> {
    return this.mutate(key, (session) => {
      const normalized = text.trim();
      // Same rule twice is noise in every future injection, so dedupe on text.
      const existing = session.contract.find(
        (rule) => !rule.retiredAt && rule.text.toLowerCase() === normalized.toLowerCase(),
      );
      if (existing) return existing;
      const rule: ContractRule = {
        id: newId(),
        text: normalized,
        createdAt: new Date().toISOString(),
        ...(fromItemId ? { fromItemId } : {}),
      };
      session.contract.push(rule);
      return rule;
    });
  }

  /** Retires rather than deletes: the rule explains past reviews. */
  async retireContractRule(key: string, ruleId: string): Promise<boolean | null> {
    return this.mutate(key, (session) => {
      const rule = session.contract.find((entry) => entry.id === ruleId);
      if (!rule) return false;
      rule.retiredAt = new Date().toISOString();
      return true;
    });
  }

  async restoreContractRule(key: string, ruleId: string): Promise<boolean | null> {
    return this.mutate(key, (session) => {
      const rule = session.contract.find((entry) => entry.id === ruleId);
      if (!rule) return false;
      delete rule.retiredAt;
      return true;
    });
  }

  /**
   * Turns a rejection into a standing rule.
   *
   * Rejection reasons are the highest-signal data the system holds and until
   * now it did nothing with them but requeue. The reason is what generalises —
   * the item body is about one paragraph, the reason is about the document.
   */
  async promoteRejection(key: string, itemId: string, override?: string): Promise<ContractRule | null> {
    const session = await this.read(key);
    if (!session) return null;
    let text = override?.trim();
    if (!text) {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        const lastHuman = [...(item.thread ?? [])].reverse().find((message) => message.role === "human");
        text = (lastHuman?.text ?? item.body).trim();
        break;
      }
    }
    if (!text) return null;
    return this.addContractRule(key, text, itemId);
  }

  /** Rules the agent should actually be told about. */
  activeContract(session: Session): ContractRule[] {
    return session.contract.filter((rule) => !rule.retiredAt);
  }

  // --- locks ----------------------------------------------------------------

  async addLock(key: string, input: { selector: string; text: string; label?: string }): Promise<Lock | null> {
    return this.mutate(key, (session) => {
      const existing = session.locks.find((lock) => lock.selector === input.selector);
      if (existing) return existing;
      const lock: Lock = { id: newId(), createdAt: new Date().toISOString(), ...input };
      session.locks.push(lock);
      return lock;
    });
  }

  async removeLock(key: string, lockId: string): Promise<boolean | null> {
    return this.mutate(key, (session) => {
      const before = session.locks.length;
      session.locks = session.locks.filter((lock) => lock.id !== lockId);
      return session.locks.length !== before;
    });
  }

  // --- clarification round trip ---------------------------------------------

  /**
   * The agent asks and parks. Before this, `needs-call` was a dead end: the
   * agent could flag an ambiguity and had no way to hear the answer short of
   * waiting for the human to send a whole new review.
   */
  async askOnItem(key: string, itemId: string, question: string): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        item.thread = [...(item.thread ?? []), { role: "agent", text: question, at: new Date().toISOString() }];
        item.awaitingHuman = true;
        item.outcome = item.outcome ?? "needs-call";
        return item;
      }
      return null;
    });
  }

  /** The human answers, which is what unparks the agent. */
  async answerQuestion(key: string, itemId: string, text: string): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        item.thread = [...(item.thread ?? []), { role: "human", text, at: new Date().toISOString() }];
        delete item.awaitingHuman;
        // An answered question puts the item back in front of the agent. A
        // question the agent asked and then never acted on is worse than one it
        // never asked.
        if (item.status === "answered") {
          item.status = "sent";
          delete item.answeredAt;
        }
        if (review.status === "answered") {
          review.status = "sent";
          delete review.deliveredTo;
        }
        return item;
      }
      return null;
    });
  }

  /** Items with an unanswered agent question. */
  pendingQuestions(session: Session): ReviewItem[] {
    return session.reviews.flatMap((review) => review.items).filter((item) => item.awaitingHuman);
  }

  // --- alternatives ---------------------------------------------------------

  async setAlternatives(key: string, itemId: string, alternatives: Alternative[]): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        item.alternatives = alternatives;
        delete item.chosenAlternative;
        item.outcome = "needs-call";
        item.awaitingHuman = true;
        return item;
      }
      return null;
    });
  }

  async chooseAlternative(key: string, itemId: string, alternativeId: string): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        if (!item.alternatives?.some((alt) => alt.id === alternativeId)) return null;
        item.chosenAlternative = alternativeId;
        delete item.awaitingHuman;
        item.thread = [
          ...(item.thread ?? []),
          {
            role: "human",
            text: `Chose: ${item.alternatives.find((alt) => alt.id === alternativeId)?.label ?? alternativeId}`,
            at: new Date().toISOString(),
          },
        ];
        return item;
      }
      return null;
    });
  }

  // --- surgical revert ------------------------------------------------------

  /**
   * Records that rejecting this item also undid the agent's change to it.
   *
   * Rejecting used to record a verdict and requeue, which left the unwanted
   * change sitting in the document until the next round — the human said "no"
   * and the text stayed.
   */
  async markReverted(key: string, itemId: string): Promise<ReviewItem | null> {
    return this.mutate(key, (session) => {
      for (const review of session.reviews) {
        const item = review.items.find((entry) => entry.id === itemId);
        if (!item) continue;
        item.revertedAt = new Date().toISOString();
        return item;
      }
      return null;
    });
  }

  // --- review sets ----------------------------------------------------------

  async setCompanions(key: string, files: string[]): Promise<string[] | null> {
    return this.mutate(key, (session) => {
      session.companions = [...new Set(files)].slice(0, 20);
      return session.companions;
    });
  }

  // --- packets --------------------------------------------------------------

  /**
   * Imports a review someone else wrote against their own copy. Items land in
   * the draft rather than as a sent review: the owner of the artifact decides
   * what crosses to their agent, which is the same rule the local markup phase
   * follows.
   */
  async importPacket(key: string, packet: ReviewPacket, from: string): Promise<number | null> {
    return this.mutate(key, (session) => {
      const draft = this.draftOf(session);
      const now = new Date().toISOString();
      for (const item of packet.review.items) {
        draft.items.push({
          ...item,
          id: newId(),
          body: `${item.body} — from ${from}`,
          status: "draft",
          createdAt: now,
        });
      }
      if (packet.review.note) {
        draft.note = draft.note ? `${draft.note}\n\n${from}: ${packet.review.note}` : `${from}: ${packet.review.note}`;
      }
      return packet.review.items.length;
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
