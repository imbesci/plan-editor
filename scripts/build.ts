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

// Mermaid is its own bundle, and deliberately not part of sdk.js.
//
// It is ~2.6MB against the SDK's 30kb — roughly ninety times the size of
// everything else the artifact loads. Bundling it in would make every artifact
// pay for a feature most of them do not use, so the SDK fetches this only after
// it has found a diagram in the document.
//
// Vendored rather than pulled from a CDN: artifacts must keep working offline,
// and `doctor` flags remote references for the same reason.
const mermaid = await Bun.build({
  entrypoints: ["src/sdk/mermaid-entry.ts"],
  outdir: "dist",
  target: "browser",
  format: "iife",
  minify: true,
  naming: "mermaid.js",
});

for (const result of [sdk, chrome, mermaid]) {
  if (!result.success) {
    for (const message of result.logs) console.error(message);
    process.exit(1);
  }
}

await Bun.write("dist/chrome.css", Bun.file("src/chrome/chrome.css"));

const sizes = await Promise.all(
  ["dist/sdk.js", "dist/chrome.js", "dist/chrome.css", "dist/mermaid.js"].map(async (file) => {
    const bytes = (await Bun.file(file).arrayBuffer()).byteLength;
    return `${file} ${(bytes / 1024).toFixed(1)}kb`;
  }),
);
console.log(`built ${sizes.join(", ")}`);
