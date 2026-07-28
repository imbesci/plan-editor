// Bundles three targets. The browser bundles are real esbuild output rather than
// functions serialized with `.toString()` — that trick couples the server to
// plain JS and silently breaks the moment a compiler emits scope-local helpers.

import { copyFile, mkdir, readFile } from "node:fs/promises";

import * as esbuild from "esbuild";

const packageJson = JSON.parse(await readFile(new URL("../package.json", import.meta.url), "utf8"));

await mkdir("dist", { recursive: true });

// CLI + server. Dependencies stay external so the bundle is small and the
// install tree is the source of truth for native/optional deps.
await esbuild.build({
  entryPoints: ["src/cli.ts"],
  outfile: "dist/cli.mjs",
  bundle: true,
  packages: "external",
  platform: "node",
  format: "esm",
  target: "node22",
  define: {
    "process.env.PLAN_EDITOR_BUILD_VERSION": JSON.stringify(packageJson.version),
  },
});

// Injected into the artifact iframe. IIFE so it never pollutes the artifact's
// module scope; idiomorph is bundled in because the frame has no network access.
await esbuild.build({
  entryPoints: ["src/sdk/sdk.ts"],
  outfile: "dist/sdk.js",
  bundle: true,
  format: "iife",
  platform: "browser",
  target: "es2022",
  minify: true,
});

await esbuild.build({
  entryPoints: ["src/chrome/chrome-client.ts"],
  outfile: "dist/chrome.js",
  bundle: true,
  format: "esm",
  platform: "browser",
  target: "es2022",
  minify: true,
});

await copyFile("src/chrome/chrome.css", "dist/chrome.css");

console.log("built dist/cli.mjs, dist/sdk.js, dist/chrome.js, dist/chrome.css");
