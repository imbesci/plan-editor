import assert from "node:assert/strict";
import { describe, test } from "node:test";

import { injectSdk, stripSdk } from "../src/html-transform.ts";

describe("injectSdk", () => {
  test("appends exactly one script before </body>", () => {
    const html = "<html><body><h1>Hi</h1></body></html>";
    const out = injectSdk(html);
    assert.equal(out, '<html><body><h1>Hi</h1><script src="/sdk.js" defer></script></body></html>');
  });

  test("handles whitespace and case in the body tag", () => {
    assert.match(injectSdk("<html><BODY>x</BODY ></html>"), /<script src="\/sdk\.js" defer><\/script><\/BODY >/);
  });

  test("appends when there is no body tag at all", () => {
    assert.match(injectSdk("<h1>fragment</h1>"), /<script src="\/sdk\.js" defer><\/script>/);
  });

  test("leaves everything else byte-identical", () => {
    // The artifact must render the same opened directly from disk as it does
    // through plan-editor — one script tag is the entire difference.
    const html = `<!doctype html><html><head><style>.a{color:red}</style></head><body><p>keep &amp; me</p></body></html>`;
    assert.equal(stripSdk(injectSdk(html)), html);
  });

  test("stripSdk removes every injected tag", () => {
    const doubled = injectSdk(injectSdk("<html><body>x</body></html>"));
    assert.doesNotMatch(stripSdk(doubled), /sdk\.js/);
  });
});
