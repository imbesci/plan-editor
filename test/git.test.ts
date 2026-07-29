import assert from "node:assert/strict";
import { execFile } from "node:child_process";
import { mkdtemp, realpath, rm, writeFile } from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import { after, before, describe, test } from "node:test";
import { promisify } from "node:util";

import { commitArtifact, diffAgainstHead, gitInfo, showAtHead } from "../src/git.ts";

const run = promisify(execFile);

let root: string;

before(async () => {
  root = await mkdtemp(path.join(os.tmpdir(), "plan-editor-git-"));
});

after(async () => {
  await rm(root, { recursive: true, force: true });
});

/**
 * A repo that commits on a machine with no global git identity, and that no
 * signing or hook config in the developer's own `~/.gitconfig` can break.
 */
async function freshRepo(): Promise<string> {
  // realpath because git reports the resolved root, and on macOS os.tmpdir()
  // is /var/... behind a symlink to /private/var/... — comparing the two
  // unresolved is the same class of bug `canonicalDir` exists to prevent.
  const dir = await realpath(await mkdtemp(path.join(root, "repo-")));
  await run("git", ["init"], { cwd: dir });
  await run("git", ["config", "user.email", "test@example.com"], { cwd: dir });
  await run("git", ["config", "user.name", "Test"], { cwd: dir });
  await run("git", ["config", "commit.gpgsign", "false"], { cwd: dir });
  return dir;
}

describe("git integration degrades instead of failing", () => {
  test("everything returns null or false outside a repository", async () => {
    // Artifacts are frequently untracked scratch files. A review must never
    // fail because the plan happens to live outside a repo.
    const plain = await mkdtemp(path.join(root, "plain-"));
    const file = path.join(plain, "plan.html");
    await writeFile(file, "<p>hi</p>");

    assert.equal(await gitInfo(file), null);
    assert.equal(await diffAgainstHead(file), null);
    assert.equal(await showAtHead(file), null);
    const result = await commitArtifact(file, "record the review");
    assert.equal(result.committed, false);
    assert.match(result.reason ?? "", /not inside a git repository/);
  });

  test("a missing directory is answered, not thrown", async () => {
    const missing = path.join(root, "nowhere", "plan.html");
    assert.equal(await gitInfo(missing), null);
    assert.equal(await diffAgainstHead(missing), null);
  });
});

describe("gitInfo", () => {
  test("reports the root, the branch, and an untracked artifact", async () => {
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>");

    const info = await gitInfo(file);
    assert.ok(info);
    assert.equal(info.repoRoot, dir);
    // `branch --show-current` rather than `rev-parse --abbrev-ref HEAD`, which
    // fails outright on a repo with no commits — the state a fresh project is
    // in when the first plan gets written.
    assert.ok(info.branch.length > 0, "an unborn branch still has a name");
    assert.equal(info.tracked, false);
    assert.equal(info.dirty, true, "an untracked file is not what git has recorded");
  });

  test("a committed, unmodified artifact is tracked and clean", async () => {
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>");
    await commitArtifact(file, "add the plan");

    const info = await gitInfo(file);
    assert.deepEqual({ tracked: info?.tracked, dirty: info?.dirty }, { tracked: true, dirty: false });

    await writeFile(file, "<p>two</p>");
    const after = await gitInfo(file);
    assert.deepEqual({ tracked: after?.tracked, dirty: after?.dirty }, { tracked: true, dirty: true });
  });

  test("an unrelated dirty file in the same repo does not make the artifact dirty", async () => {
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>");
    await commitArtifact(file, "add the plan");
    await writeFile(path.join(dir, "notes.md"), "unrelated work");

    assert.equal((await gitInfo(file))?.dirty, false);
  });
});

describe("commitArtifact", () => {
  test("commits the artifact and returns the sha", async () => {
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>");

    const result = await commitArtifact(file, "record the accepted review");
    assert.equal(result.committed, true);
    assert.match(result.sha ?? "", /^[0-9a-f]{40}$/);

    const { stdout } = await run("git", ["log", "-1", "--format=%s"], { cwd: dir });
    assert.equal(stdout.trim(), "record the accepted review");
  });

  test("refuses rather than reporting a commit that never happened", async () => {
    // `git commit` with nothing staged exits non-zero with a message nobody
    // sees; without this check the caller reports success for no commit.
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>");
    await commitArtifact(file, "first");

    const second = await commitArtifact(file, "second");
    assert.equal(second.committed, false);
    assert.match(second.reason ?? "", /nothing to commit/);
    const { stdout } = await run("git", ["rev-list", "--count", "HEAD"], { cwd: dir });
    assert.equal(stdout.trim(), "1");
  });

  test("commits only the artifact, never someone else's staged work", async () => {
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>");
    await writeFile(path.join(dir, "secret.txt"), "half-finished work");
    await run("git", ["add", "secret.txt"], { cwd: dir });

    await commitArtifact(file, "record the review");
    const { stdout } = await run("git", ["show", "--name-only", "--format=", "HEAD"], { cwd: dir });
    assert.deepEqual(stdout.trim().split("\n"), ["plan.html"]);
  });

  test("a message full of shell metacharacters is data, not syntax", async () => {
    // The message comes from a text field in the browser. Built into a shell
    // string it would be a code-execution hole; as an argv element it is prose.
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>");
    const message = 'review: "cut by a third"; $(touch pwned) && rm -rf . | tee `x`';

    assert.equal((await commitArtifact(file, message)).committed, true);
    const { stdout } = await run("git", ["log", "-1", "--format=%s"], { cwd: dir });
    assert.equal(stdout.trim(), message);
    assert.equal((await gitInfo(path.join(dir, "pwned")))?.tracked, false);
    const { stdout: listed } = await run("git", ["ls-files", "--others", "--exclude-standard"], { cwd: dir });
    assert.doesNotMatch(listed, /pwned/, "nothing was executed");
  });

  test("a path with spaces and quotes commits normally", async () => {
    const dir = await freshRepo();
    const file = path.join(dir, "my plan (v2) 'final'.html");
    await writeFile(file, "<p>one</p>");
    assert.equal((await commitArtifact(file, "add it")).committed, true);
    assert.equal(await showAtHead(file), "<p>one</p>");
  });
});

describe("diffAgainstHead and showAtHead", () => {
  test("null before there is a HEAD, then the committed content", async () => {
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>");

    assert.equal(await showAtHead(file), null, "nothing is committed yet");
    assert.equal(await diffAgainstHead(file), null);

    await commitArtifact(file, "add the plan");
    assert.equal(await showAtHead(file), "<p>one</p>");
    // An empty diff is a real answer — committed and clean — and is
    // deliberately distinct from null.
    assert.equal(await diffAgainstHead(file), "");
  });

  test("the working-tree diff shows what the agent changed since the commit", async () => {
    const dir = await freshRepo();
    const file = path.join(dir, "plan.html");
    await writeFile(file, "<p>one</p>\n");
    await commitArtifact(file, "add the plan");
    await writeFile(file, "<p>two</p>\n");

    const diff = await diffAgainstHead(file);
    assert.match(diff ?? "", /^-<p>one<\/p>$/m);
    assert.match(diff ?? "", /^\+<p>two<\/p>$/m);
    assert.equal(await showAtHead(file), "<p>one</p>\n", "HEAD still holds the committed version");
  });

  test("an untracked artifact in a repo has no HEAD copy to show", async () => {
    const dir = await freshRepo();
    await writeFile(path.join(dir, "committed.html"), "<p>x</p>");
    await commitArtifact(path.join(dir, "committed.html"), "seed");

    const untracked = path.join(dir, "plan.html");
    await writeFile(untracked, "<p>one</p>");
    assert.equal(await showAtHead(untracked), null);
  });
});
