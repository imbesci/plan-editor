// Parking: the two ways an agent waits on a human.
//
// Shared by the CLI and the MCP server, which had drifted into two copies of
// the slicing logic. That matters more than ordinary duplication would: the
// slicing exists because a single long request trips whichever timeout the
// runtime applies first, and it surfaced as an unhandled TimeoutError that
// killed the command mid-wait, in front of the user. A second copy is a second
// chance to reintroduce that.

import { baseUrl, call, delay, tokenFor } from "./client.ts";
import type { PollResult, ReviewItem } from "./protocol.ts";

/**
 * Short enough that no client, proxy, or runtime default has an opinion about
 * it, and a dropped connection costs one slice instead of the whole wait.
 */
export const POLL_SLICE_MS = 45_000;

/** Waits for the human to send a review. */
export async function longPoll(canonical: string, token: string, deadline: number): Promise<PollResult> {
  while (Date.now() < deadline) {
    const slice = Math.max(1_000, Math.min(POLL_SLICE_MS, deadline - Date.now()));
    const url =
      `${baseUrl()}/api/poll?file=${encodeURIComponent(canonical)}&t=${encodeURIComponent(token)}` +
      `&timeoutMs=${slice}`;
    let result: PollResult | null = null;
    try {
      const response = await fetch(url, { signal: AbortSignal.timeout(slice + 15_000) });
      if (response.ok) result = (await response.json()) as PollResult;
    } catch {
      // Transient: the server restarted, or a slice timed out. Try the next one.
      await delay(500);
      continue;
    }
    if (result && result.status !== "waiting") return result;
  }
  return { status: "waiting" };
}

/**
 * Waits for the human to answer a question about ONE item.
 *
 * Not expressible as a `longPoll`: a question can only be asked while its
 * review is still pending, so polling the review returns that same review
 * immediately and the agent unparks with no answer — then guesses, which is
 * precisely what asking was supposed to prevent.
 */
export async function awaitAnswer(canonical: string, itemId: string, deadline: number): Promise<ReviewItem | null> {
  while (Date.now() < deadline) {
    const slice = Math.max(1_000, Math.min(POLL_SLICE_MS, deadline - Date.now()));
    let result: { status?: string; item?: ReviewItem };
    try {
      result = (await call(canonical, `/items/${itemId}/await-answer?timeoutMs=${slice}`)) as {
        status?: string;
        item?: ReviewItem;
      };
    } catch {
      await delay(500);
      continue;
    }
    if (result.status === "answered" && result.item) return result.item;
    // The item was deleted or the review was reverted out from under the
    // question. Returning null beats waiting out a deadline for an answer that
    // can never arrive.
    if (result.status === "not-found") return null;
  }
  return null;
}
