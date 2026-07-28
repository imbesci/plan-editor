// The only modification made to an artifact: one script tag appended to <body>.
// Nothing else is injected — no design system, no styles — so the saved file
// renders identically whether it is opened through plan-editor or straight from
// disk.

const SDK_TAG = '<script src="/sdk.js" defer></script>';

export function injectSdk(html: string): string {
  const marker = /<\/body\s*>/i;
  if (marker.test(html)) {
    return html.replace(marker, (match) => `${SDK_TAG}${match}`);
  }
  return `${html}\n${SDK_TAG}\n`;
}

/** Removes the injected tag, so a morph payload never re-adds a second SDK. */
export function stripSdk(html: string): string {
  return html.replace(/<script src="\/sdk\.js"[^>]*><\/script>/gi, "");
}
