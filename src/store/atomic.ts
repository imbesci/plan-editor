// Two primitives the session store is built on, both of which lavish-axi's
// SessionStore lacked and its whiteboard store had:
//
//   1. queued()  - serializes read-modify-write per key. `await read` ... `await
//      write` is NOT atomic in Node: the event loop runs other handlers at both
//      suspension points, so two concurrent handlers can read the same snapshot
//      and the second write silently discards the first.
//   2. writeFileAtomically() - tmp + rename. A plain writeFile truncates in
//      place, so a crash or SIGTERM mid-write leaves a half-written file that
//      fails to parse forever.

import { rename, rm, writeFile } from "node:fs/promises";

const tails = new Map<string, Promise<unknown>>();
let temporaryFileId = 0;

/**
 * Runs `operation` after every previously queued operation for `key` has
 * settled. Failures do not poison the chain for later callers.
 */
export function queued<T>(key: string, operation: () => Promise<T>): Promise<T> {
  const prior = tails.get(key) ?? Promise.resolve();
  const result = prior.then(operation, operation);
  const tail = result.then(
    () => undefined,
    () => undefined,
  );
  tails.set(key, tail);
  void tail.then(() => {
    if (tails.get(key) === tail) tails.delete(key);
  });
  return result;
}

export async function writeFileAtomically(file: string, content: string): Promise<void> {
  const temporary = `${file}.${process.pid}.${++temporaryFileId}.tmp`;
  try {
    await writeFile(temporary, content);
    await rename(temporary, file);
  } catch (error) {
    await rm(temporary, { force: true }).catch(() => {});
    throw error;
  }
}

/** Test seam: true when no operations are in flight. */
export function pendingKeyCount(): number {
  return tails.size;
}
