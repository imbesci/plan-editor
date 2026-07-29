// Snapshots of the artifact, one per observed change.
//
// This is the keystone for undo, the diff view, and the version scrubber. It is
// deliberately dumb: whole-file copies, capped, newest-last. Artifacts are a few
// hundred KB of HTML, so storing deltas would cost more complexity than it saves
// disk, and a whole-file snapshot makes restore a single write.

import { mkdir, readFile, readdir, rm } from "node:fs/promises";
import path from "node:path";

import type { VersionMeta } from "../protocol.ts";
import { queued, writeFileAtomically } from "./atomic.ts";

export const MAX_VERSIONS = 40;

export type { VersionMeta };

interface Index {
  versions: VersionMeta[];
}

export class VersionStore {
  constructor(private readonly root: string) {}

  private dir(key: string): string {
    return path.join(this.root, "versions", key);
  }

  private indexFile(key: string): string {
    return path.join(this.dir(key), "index.json");
  }

  private async readIndex(key: string): Promise<Index> {
    try {
      return JSON.parse(await readFile(this.indexFile(key), "utf8")) as Index;
    } catch {
      return { versions: [] };
    }
  }

  async list(key: string): Promise<VersionMeta[]> {
    return (await this.readIndex(key)).versions;
  }

  async read(key: string, seq: number): Promise<string | null> {
    try {
      return await readFile(path.join(this.dir(key), `${seq}.html`), "utf8");
    } catch {
      return null;
    }
  }

  async latest(key: string): Promise<VersionMeta | null> {
    const versions = await this.list(key);
    return versions[versions.length - 1] ?? null;
  }

  /**
   * Records `html` as the next version. Identical consecutive content is
   * ignored, so a touch that does not change the file does not create a version
   * (and does not make "undo" a no-op the user has to press twice).
   */
  async snapshot(key: string, html: string, origin: VersionMeta["origin"]): Promise<VersionMeta | null> {
    return queued(`versions:${key}`, async () => {
      const dir = this.dir(key);
      await mkdir(dir, { recursive: true });
      const index = await this.readIndex(key);

      const previous = index.versions[index.versions.length - 1];
      if (previous) {
        const previousHtml = await this.read(key, previous.seq);
        if (previousHtml === html) return null;
      }

      // Never reuse a seq that already has a file on disk. `readIndex` turns any
      // unreadable index into an empty history, so without this a corrupt index
      // restarts numbering at 1 and silently overwrites 1.html.
      const onDisk = await highestSeqOnDisk(dir);
      const seq = Math.max(previous?.seq ?? 0, onDisk) + 1;
      const meta: VersionMeta = { seq, at: new Date().toISOString(), bytes: Buffer.byteLength(html), origin };
      // The payload is written atomically too. It used to be a plain writeFile
      // while only the index was atomic, so a crash mid-write left a truncated
      // snapshot that the index still claimed was a valid version — and undo
      // restoring a half-written file is worse than no undo.
      await writeFileAtomically(path.join(dir, `${seq}.html`), html);
      index.versions.push(meta);

      // Cap oldest-first. Losing deep history is fine; losing the ability to
      // undo the last few edits is not. Pinned versions are exempt: pinning is
      // the human saying "this one is the record", and aging out the version
      // someone named is the one drop that is never acceptable.
      while (index.versions.filter((entry) => !entry.pinned).length > MAX_VERSIONS) {
        const dropIndex = index.versions.findIndex((entry) => !entry.pinned);
        if (dropIndex === -1) break;
        const [dropped] = index.versions.splice(dropIndex, 1);
        await rm(path.join(dir, `${dropped!.seq}.html`), { force: true });
      }
      await writeFileAtomically(this.indexFile(key), `${JSON.stringify(index, null, 2)}\n`);
      return meta;
    });
  }

  /** Names or pins a version, so history is not a row of anonymous `v7`s. */
  async annotate(key: string, seq: number, patch: { label?: string; pinned?: boolean }): Promise<VersionMeta | null> {
    return queued(`versions:${key}`, async () => {
      const index = await this.readIndex(key);
      const meta = index.versions.find((entry) => entry.seq === seq);
      if (!meta) return null;
      if (patch.label !== undefined) {
        if (patch.label) meta.label = patch.label;
        else delete meta.label;
      }
      if (patch.pinned !== undefined) {
        if (patch.pinned) meta.pinned = true;
        else delete meta.pinned;
      }
      await writeFileAtomically(this.indexFile(key), `${JSON.stringify(index, null, 2)}\n`);
      return meta;
    });
  }

  /** The version to undo *to*: the one before the newest. */
  async previousSeq(key: string): Promise<number | null> {
    const versions = await this.list(key);
    return versions.length >= 2 ? versions[versions.length - 2]!.seq : null;
  }

  async removeAll(key: string): Promise<void> {
    await rm(this.dir(key), { recursive: true, force: true });
  }
}

async function highestSeqOnDisk(dir: string): Promise<number> {
  try {
    return (await readdir(dir)).reduce((highest, entry) => {
      const match = /^(\d+)\.html$/.exec(entry);
      return match ? Math.max(highest, Number(match[1])) : highest;
    }, 0);
  } catch {
    return 0;
  }
}

/** Where snapshots live, for tests and diagnostics. */
export function versionsDir(root: string, key: string): string {
  return path.join(root, "versions", key);
}

export async function listVersionFiles(root: string, key: string): Promise<string[]> {
  try {
    return (await readdir(versionsDir(root, key))).sort();
  } catch {
    return [];
  }
}
