// Re-anchoring: finding the element a note was written about, after the agent
// has rewritten it.
//
// THE DEFECT THIS EXISTS TO FIX. `resolveAnchor` fell back to *exact equality*
// of whitespace-collapsed `textContent`, over a snippet that sdk.ts had already
// truncated to 300 characters. Both halves of that are wrong in the same
// direction:
//
//   - Exact equality can only ever re-find an element whose text did not
//     change — which is precisely the complement of the set the agent just
//     edited. The one annotation guaranteed not to re-anchor is the one the
//     agent acted on, so "waiting for agent" stuck forever on exactly the work
//     that got done.
//   - With truncation on top, a paragraph longer than 300 characters could
//     never re-anchor at all, even completely untouched, because the stored
//     needle was a prefix and the haystack was the whole thing.
//
// The visible symptom was the human being asked to re-point by hand — a manual
// repair for a mechanically fixable failure, on every reload.
//
// So: score candidates instead of demanding equality. This module is pure and
// DOM-free (candidates arrive as `{ item, text }` records) so it can be tested
// under `node:test` with no jsdom, and so the browser bundle stays small — it
// hand-rolls its hash rather than importing `node:crypto`, which does not exist
// in the sandboxed iframe.

/**
 * The bar for "this is the same element". Tuned against the two shapes that
 * actually occur: a paragraph with a word or two rewritten lands around
 * 0.80–0.90, and a stored snippet truncated to a prefix of its full text lands
 * around 0.80 once the prefix boost applies. Two unrelated paragraphs of
 * ordinary prose share only stopwords and land below 0.15.
 *
 * 0.72 sits in that gap with room on both sides. Lower and duplicated
 * boilerplate ("Last updated: …" repeated per section) starts winning matches
 * it has no claim to; higher and a single rewritten sentence orphans the note.
 */
export const CONFIDENT = 0.72;

/** Word n-gram width. Trigrams: long enough to be specific, short enough that
 *  one rewritten word only invalidates three of them. */
const DEFAULT_SHINGLE = 3;

/** Matches the `anchors[].shingles` cap in protocol.ts, so what we compute here
 *  is exactly what survives a round trip through the store. */
const MAX_SHINGLES = 120;

/**
 * Below this a prefix/containment relationship is coincidence, not evidence:
 * every list item in a document starts with "The", and boosting on that would
 * hand every short anchor to whichever element happened to come first.
 */
const MIN_AFFIX_CHARS = 24;

/** Collapses whitespace, trims, lowercases. Matching is case-insensitive
 *  because "Risks" becoming "risks" is a formatting change, not a new element. */
export function normalizeText(text: string): string {
  return (text ?? "").replace(/\s+/g, " ").trim().toLowerCase();
}

/**
 * Short stable hex digest of the *normalized* text.
 *
 * FNV-1a by hand, twice with different offset bases, for 64 bits of hex. Two
 * reasons it is not `node:crypto` and not `crypto.subtle`: this runs inside the
 * artifact iframe, which has no Node builtins, and `crypto.subtle.digest` is
 * async — an async hash would force every call site on the resolution path to
 * become async for a value that must be computed synchronously while the click
 * handler still holds the element.
 *
 * Returns "" for empty input. A digest of the empty string would compare equal
 * across every empty element on the page and score them all a perfect match.
 */
export function hashText(text: string): string {
  const normalized = normalizeText(text);
  if (!normalized) return "";
  return `${fnv1a(normalized, 0x811c9dc5)}${fnv1a(normalized, 0x01000193)}`;
}

function fnv1a(text: string, seed: number): string {
  let hash = seed >>> 0;
  for (let index = 0; index < text.length; index += 1) {
    hash ^= text.charCodeAt(index);
    // `Math.imul` because a plain `*` on a 32-bit value loses the low bits to
    // float rounding well before the string ends, which quietly collapses the
    // digest space for anything longer than a few words.
    hash = Math.imul(hash, 0x01000193) >>> 0;
  }
  hash ^= text.length;
  return (hash >>> 0).toString(16).padStart(8, "0");
}

function words(text: string): string[] {
  const normalized = normalizeText(text);
  return normalized ? normalized.split(" ") : [];
}

/**
 * Deduped word n-grams, capped.
 *
 * Capped from the *start* of the text rather than sampled across it, which is
 * deliberate: a stored snippet is a prefix of the full text, so taking the
 * first N shingles on both sides means a truncated anchor and its untruncated
 * element still describe the same opening and overlap heavily. Sampling evenly
 * would put them in disjoint regions and score them as strangers.
 */
export function shingles(text: string, size: number = DEFAULT_SHINGLE): string[] {
  const list = words(text);
  if (list.length === 0) return [];
  // A two-word anchor must still produce something to match on, so the width
  // collapses to the available length rather than returning nothing.
  const width = Math.max(1, Math.min(size, list.length));
  const grams: string[] = [];
  const seen = new Set<string>();
  for (let index = 0; index + width <= list.length; index += 1) {
    const gram = list.slice(index, index + width).join(" ");
    if (seen.has(gram)) continue;
    seen.add(gram);
    grams.push(gram);
    if (grams.length >= MAX_SHINGLES) break;
  }
  return grams;
}

export interface AnchorLike {
  /** Full-text digest captured at annotation time; survives truncation. */
  hash?: string;
  /** Full-text shingles captured at annotation time; survive truncation. */
  shingles?: string[];
  /** The stored snippet, which may be truncated. */
  text: string;
}

function intersectionSize(a: Set<string>, b: Set<string>): number {
  let count = 0;
  for (const value of a) if (b.has(value)) count += 1;
  return count;
}

/** Unique words behind a set of shingles.
 *
 *  Derived from the shingles rather than from `text` on purpose: when the
 *  snippet was truncated, the shingles are the only record of the full text's
 *  vocabulary, and throwing that away is what made long paragraphs unmatchable. */
function vocabulary(grams: string[]): Set<string> {
  const set = new Set<string>();
  for (const gram of grams) for (const word of gram.split(" ")) if (word) set.add(word);
  return set;
}

/**
 * Characters shared by the two strings at the start plus at the end.
 *
 * This is the shape of an ordinary edit that strict prefix matching misses
 * entirely: the agent rewrites the last sentence of a paragraph, so neither
 * text is a prefix or a substring of the other, but they still open and close
 * identically. Without this the paragraph scored 0.67 and orphaned its note —
 * i.e. the note was dropped precisely because the agent did what it asked.
 */
function sharedAffixLength(a: string, b: string): number {
  const max = Math.min(a.length, b.length);
  let lead = 0;
  while (lead < max && a.charCodeAt(lead) === b.charCodeAt(lead)) lead += 1;
  let trail = 0;
  // Bounded by `max - lead` so a repetitive string cannot count the same
  // characters as both its opening and its closing and score over 1.
  while (trail < max - lead && a.charCodeAt(a.length - 1 - trail) === b.charCodeAt(b.length - 1 - trail)) {
    trail += 1;
  }
  return lead + trail;
}

/**
 * 0..1 similarity between a stored anchor and a candidate element's text.
 *
 * Exact normalized equality — or a matching full-text hash, which is the same
 * statement made through a truncated snippet — is 1. Everything else is a
 * blend of shingle overlap and word overlap, boosted when one text is a prefix
 * or substring of the other or when the two share a long opening and closing,
 * and penalised when their lengths diverge with no such relationship at all.
 *
 * The word-overlap term is not redundant with the shingle term: a single
 * rewritten word invalidates three trigrams but only one word, so shingles
 * alone put a one-word edit uncomfortably close to the threshold. The blend
 * keeps it clearly above while unrelated prose stays near zero, because
 * unrelated prose shares stopwords (high-ish word overlap) but almost no
 * trigrams.
 */
export function similarity(a: AnchorLike, candidateText: string): number {
  const stored = normalizeText(a.text);
  const candidate = normalizeText(candidateText);
  const anchorGrams = a.shingles?.length ? a.shingles : shingles(stored);

  // Nothing on either side to compare. Returning 0 rather than 1 matters: an
  // empty anchor that scored a perfect match would claim every empty element
  // on the page.
  if (!candidate || anchorGrams.length === 0) return 0;

  if (stored && stored === candidate) return 1;
  if (a.hash && a.hash === hashText(candidate)) return 1;

  const candidateGrams = shingles(candidate);
  if (candidateGrams.length === 0) return 0;

  const left = new Set(anchorGrams);
  const right = new Set(candidateGrams);
  const shared = intersectionSize(left, right);
  const union = left.size + right.size - shared;
  const shingleJaccard = union === 0 ? 0 : shared / union;

  const leftWords = vocabulary(anchorGrams);
  const rightWords = vocabulary(candidateGrams);
  const sharedWords = intersectionSize(leftWords, rightWords);
  const wordUnion = leftWords.size + rightWords.size - sharedWords;
  const wordJaccard = wordUnion === 0 ? 0 : sharedWords / wordUnion;

  let score = 0.65 * shingleJaccard + 0.35 * wordJaccard;

  const shorter = stored.length <= candidate.length ? stored : candidate;
  const longer = shorter === stored ? candidate : stored;
  const isPrefix = shorter.length >= MIN_AFFIX_CHARS && longer.startsWith(shorter);
  const isContained = !isPrefix && shorter.length >= MIN_AFFIX_CHARS && longer.includes(shorter);

  if (isPrefix || isContained) {
    // Containment coefficient: how much of the *smaller* side is accounted for.
    // Jaccard alone is hostile to truncation — a 300-character snippet of a
    // 1200-character paragraph tops out near 0.25 no matter how perfectly it
    // matches, because three quarters of the union can never be shared.
    const containment = shared / Math.min(left.size, right.size);
    // A prefix is much stronger evidence than a substring: an edited paragraph
    // usually keeps its opening, whereas a substring hit is also what you get
    // when one section quotes another.
    score += (containment - score) * (isPrefix ? 0.75 : 0.45);
  } else {
    if (shorter.length > 0) {
      // Sharp length divergence with no affix relationship means the shared
      // vocabulary is coincidence — a one-line heading matching the section
      // that contains it. sqrt so a modest divergence costs little and a
      // tenfold one costs most of the score.
      score *= Math.sqrt(shorter.length / longer.length);
    }
    const affix = sharedAffixLength(stored, candidate);
    const affixRatio = longer.length === 0 ? 0 : Math.min(1, affix / longer.length);
    // Requires an absolute run as well as a ratio: two short list items both
    // starting "The " share a high proportion of nothing.
    if (affix >= MIN_AFFIX_CHARS && affixRatio > score) {
      // Weaker than the containment blend (0.75) because a shared opening and
      // closing can also describe two sibling rows of a table — but strong
      // enough that a rewritten sentence keeps its note attached.
      score += (affixRatio - score) * 0.6;
    }
  }

  return score > 1 ? 1 : score > 0 ? score : 0;
}

export interface ScoredCandidate<T> {
  item: T;
  score: number;
}

/**
 * Highest-scoring candidate, or null when nothing scores at all.
 *
 * `selector` is part of the anchor but deliberately unused here: it is a hint
 * that dies the moment the agent reorders a list, and callers try it directly
 * before falling back to scoring. It stays in the signature so call sites can
 * pass the stored anchor through unmodified.
 *
 * Ties break toward the *earlier* candidate (strict `>`), and callers pass
 * candidates in document order. The code this replaces returned the first
 * document-order exact match with no arbitration at all, so a document with
 * repeated boilerplate re-anchored notes onto whichever copy came first with
 * no way to tell that a choice had even been made. Determinism does not make
 * that choice right, but it makes it stable across reloads, which is what stops
 * a note from wandering between two identical blocks on every patch.
 */
export function bestMatch<T>(
  anchor: { selector: string; text: string; hash?: string; shingles?: string[] },
  candidates: Array<{ item: T; text: string }>,
): ScoredCandidate<T> | null {
  let best: ScoredCandidate<T> | null = null;
  for (const candidate of candidates) {
    const score = similarity(anchor, candidate.text);
    if (score <= 0) continue;
    if (!best || score > best.score) best = { item: candidate.item, score };
  }
  return best;
}
