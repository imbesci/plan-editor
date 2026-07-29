// Runs each test file in its own process.
//
// `bun test` runs files concurrently, and its `node:test` compatibility layer
// keeps "am I inside a test right now" in global state — so a top-level
// `describe()` in one file can land while another file's test is running and
// fail with "describe() inside another test()". The same command would report
// 107 pass, then 3 fail, then 107 pass again on identical code.
//
// A suite that cannot be trusted is worse than no suite, and the tests
// themselves are fine: run file by file and it has never once flaked.

import { Glob } from "bun";

const only = process.argv.slice(2).filter((arg) => !arg.startsWith("-"));
const files = only.length
  ? only
  : (await Array.fromAsync(new Glob("*.test.ts").scan({ cwd: "test" }))).sort().map((name) => `test/${name}`);

let passed = 0;
let failed = 0;
const broken: string[] = [];

for (const file of files) {
  const proc = Bun.spawn(["bun", "test", file], { stdout: "pipe", stderr: "pipe" });
  const [out, err] = await Promise.all([new Response(proc.stdout).text(), new Response(proc.stderr).text()]);
  await proc.exited;

  const report = `${out}\n${err}`;
  const pass = Number(report.match(/(\d+) pass/)?.[1] ?? 0);
  const fail = Number(report.match(/(\d+) fail/)?.[1] ?? 0);
  passed += pass;
  failed += fail;

  const name = file.replace(/^test\//, "").replace(/\.test\.ts$/, "");
  if (fail > 0 || proc.exitCode !== 0) {
    broken.push(file);
    console.log(`✖ ${name.padEnd(18)} ${pass} pass, ${fail} fail`);
    console.log(
      report
        .split("\n")
        .filter((line) => /\(fail\)|AssertionError|error:|Expected|Received|actual:|expected:/.test(line))
        .slice(0, 12)
        .map((line) => `    ${line.trim()}`)
        .join("\n"),
    );
  } else {
    console.log(`✔ ${name.padEnd(18)} ${pass} pass`);
  }
}

console.log(`\n${passed} pass, ${failed} fail across ${files.length} files`);
if (broken.length) {
  console.log(`failing: ${broken.join(", ")}`);
  process.exit(1);
}
