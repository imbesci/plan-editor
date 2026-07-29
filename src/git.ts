// Git, for artifacts that live in a repo.
//
// Version history here is a parallel universe to the one the file actually
// lives in: snapshots under the state directory know nothing about the branch
// the plan was written on, and the commit that shipped the plan knows nothing
// about the review that produced it. These four calls are the bridge — enough
// to say where the artifact sits, to commit an accepted review, and to diff
// against HEAD.
//
// **Every function degrades to null/false.** Artifacts are frequently untracked
// scratch files, `git` is frequently absent, and a review must never fail
// because of either. There is no error path out of this module for that reason;
// an unavailable git is indistinguishable from a file outside a repo, and both
// mean "no git integration", not "something is wrong".
//
// Nothing here builds a command line. `execFile` with an argument array and an
// explicit cwd means a commit message containing `;` or a path containing a
// space is data, never syntax — a shell string here would be a code-execution
// hole reachable from a text field in the browser.

import { execFile } from "node:child_process";
import path from "node:path";
import { promisify } from "node:util";

const run = promisify(execFile);

export interface GitInfo {
  repoRoot: string;
  branch: string;
  tracked: boolean;
  /** The file differs from what git has recorded — modified, staged, or untracked. */
  dirty: boolean;
}

/**
 * Git can block forever waiting on a credential prompt or an index lock, and a
 * parked `git` would park the review with it. A bounded, prompt-free child is
 * the only shape allowed here. `maxBuffer` is raised because `git show` and
 * `git diff` return whole artifacts, and Node's 1MB default truncates them into
 * an error instead of a document.
 */
const OPTIONS = {
  timeout: 10_000,
  maxBuffer: 32 * 1024 * 1024,
  env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_OPTIONAL_LOCKS: "0" },
} as const;

/** Runs git in the artifact's own directory. Returns null on any failure at all. */
async function git(cwd: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await run("git", args, { cwd, ...OPTIONS });
    return stdout;
  } catch {
    // Not a repo, no git binary, a non-zero exit, a timeout — all the same
    // answer to the caller, which is "there is no git here".
    return null;
  }
}

function where(file: string): { cwd: string; abs: string } {
  const abs = path.resolve(file);
  return { cwd: path.dirname(abs), abs };
}

export async function gitInfo(file: string): Promise<GitInfo | null> {
  const { cwd, abs } = where(file);
  const root = await git(cwd, ["rev-parse", "--show-toplevel"]);
  if (root === null) return null;

  // `--show-current` rather than `rev-parse --abbrev-ref HEAD`: the latter
  // fails outright on a repo with no commits yet, which is exactly the state a
  // fresh project is in when the first plan gets written.
  const branch = (await git(cwd, ["branch", "--show-current"]))?.trim() || "HEAD";
  const listed = await git(cwd, ["ls-files", "--", abs]);
  const status = await git(cwd, ["status", "--porcelain", "--", abs]);
  return {
    repoRoot: root.trim(),
    branch,
    tracked: Boolean(listed?.trim()),
    dirty: Boolean(status?.trim()),
  };
}

/**
 * Commits the artifact and nothing else.
 *
 * Path-limited on both sides: `git add -- <file>` stages only this file, and
 * the commit carries the same pathspec so unrelated work the human already had
 * staged cannot be swept into a commit whose message says it is about the plan.
 */
export async function commitArtifact(
  file: string,
  message: string,
): Promise<{ committed: boolean; sha?: string; reason?: string }> {
  const { cwd, abs } = where(file);
  const info = await gitInfo(file);
  if (!info) return { committed: false, reason: "not inside a git repository" };

  if ((await git(cwd, ["add", "--", abs])) === null) {
    return { committed: false, reason: "could not stage the artifact (is it ignored?)" };
  }

  // `git diff --cached --quiet` exits 1 when something is staged, so a null
  // here means there *is* something to commit. Refusing when there is not is
  // the point: `git commit` with nothing staged exits non-zero with a message
  // nobody sees, and the caller would report a commit that never happened.
  if ((await git(cwd, ["diff", "--cached", "--quiet", "--", abs])) !== null) {
    return { committed: false, reason: "nothing to commit — the artifact matches what git already has" };
  }

  if ((await git(cwd, ["commit", "-m", message, "--", abs])) === null) {
    return { committed: false, reason: "git refused the commit (hook, identity, or signing)" };
  }
  const sha = (await git(cwd, ["rev-parse", "HEAD"]))?.trim();
  return sha ? { committed: true, sha } : { committed: true };
}

/**
 * The artifact's working-tree changes against HEAD, or null when there is no
 * HEAD to diff against. An empty string is a real answer — committed and clean
 * — and is deliberately distinct from null.
 */
export async function diffAgainstHead(file: string): Promise<string | null> {
  const { cwd, abs } = where(file);
  return await git(cwd, ["diff", "HEAD", "--", abs]);
}

/** The committed content of the artifact, for diffing a review against what shipped. */
export async function showAtHead(file: string): Promise<string | null> {
  const { cwd, abs } = where(file);
  // `HEAD:./name` is the cwd-relative form, so this never has to compute a
  // repo-root-relative path — which would go wrong the moment the repo root
  // and the file's path disagree about symlinks.
  return await git(cwd, ["show", `HEAD:./${path.basename(abs)}`]);
}
