// The lazily-loaded mermaid bundle.
//
// Its own entrypoint so `dist/mermaid.js` can be fetched on demand: mermaid is
// ~2.6MB against the SDK's 30kb, and most artifacts contain no diagram at all.
// The SDK injects a plain <script src="/mermaid.js"> only after it has found
// one — a classic script rather than a module import, because the artifact
// frame has an opaque origin and a module fetch would need CORS the server does
// not grant.
//
// Vendored, never a CDN: an artifact has to keep rendering offline, and
// `doctor` flags remote references for exactly that reason.

import mermaid from "mermaid";

declare global {
  interface Window {
    __peMermaid?: typeof mermaid;
  }
}

window.__peMermaid = mermaid;
