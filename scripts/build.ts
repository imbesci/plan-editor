// Only the browser bundles need building — Bun runs the CLI and server TypeScript
// directly, so there is no server-side build step at all.
//
// These are real bundles rather than functions serialized with `.toString()`.
// That trick couples the server to plain JS and breaks silently the moment a
// compiler emits scope-local helpers into the serialized body.

import { rm } from "node:fs/promises";

await rm("dist", { recursive: true, force: true });

// Injected into the artifact iframe. IIFE so it never leaks into the artifact's
// module scope; idiomorph is bundled in because the sandboxed frame has an
// opaque origin and cannot fetch anything itself.
const sdk = await Bun.build({
  entrypoints: ["src/sdk/sdk.ts"],
  outdir: "dist",
  target: "browser",
  format: "iife",
  minify: true,
  naming: "sdk.js",
});

const chrome = await Bun.build({
  entrypoints: ["src/chrome/chrome-client.ts"],
  outdir: "dist",
  target: "browser",
  format: "esm",
  minify: true,
  naming: "chrome.js",
});

for (const result of [sdk, chrome]) {
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    process.exit(1);
  }
}

await Bun.write("dist/chrome.css", Bun.file("src/chrome/chrome.css"));

const sizes = await Promise.all(
  ["dist/sdk.js", "dist/chrome.js", "dist/chrome.css"].map(async (file) => {
    const bytes = (await Bun.file(file).arrayBuffer()).byteLength;
    return `${file} ${(bytes / 1024).toFixed(1)}kb`;
  }),
);
console.log(`built ${sizes.join(", ")}`);
