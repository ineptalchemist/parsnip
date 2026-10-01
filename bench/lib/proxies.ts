/**
 * Fidelity proxies for the cross-selector bench: pure functions that measure how
 * much *content* of an input survives in a selector's output.
 *
 * All proxies are retention metrics — (survived in output) / (present in input) —
 * rendered as a percentage by `bench/compare.ts`, or `null` when the input has
 * none of that class. They measure content retention only, never semantic
 * safety: a kept line can still be misleading out of context. That judgment is
 * an external harness' job (see the main plan's "What fidelity is and is not").
 *
 * Faithful-subset note: selectors only ever drop or "…"-truncate, never invent,
 * so "survived" is a plain substring test. `signal-preserving` and `extractive`
 * truncate long kept lines to 400 chars, so long lines are matched by their
 * 399-char prefix — exactly the part a "…"-truncated line preserves verbatim.
 */

import { SIGNAL_PATTERN, lineShape, stripAnsi } from "../../server/lib/selectors.ts"

/** Cap that `signal-preserving` / `extractive` apply to long kept lines. */
export const RETAIN_PREFIX = 400

/**
 * Proxies operate on *visible* text: ANSI escapes are terminal formatting, not
 * content, and `log-compact` legitimately strips them (its faithful-subset
 * contract is lossless for the visible text). Without this normalization an
 * ANSI-colored diagnostic that log-compact keeps would count as dropped.
 */
const visible = (text: string): string => stripAnsi(text)

/** Identifier-ish token: word-like runs, including path/punctuation-ish chars. */
const IDENTIFIER = /[A-Za-z0-9_$.-]+/g

/** At least one real word character — excludes punctuation-only runs like ".." or "--". */
const WORD_CHAR = /[A-Za-z0-9_$]/

/** Non-blank visible lines: blank lines carry no content to retain. */
const contentLines = (text: string): string[] =>
  visible(text)
    .split("\n")
    .filter((line) => line.length > 0)

/** Lines in `text` that look like a diagnostic (reuses the selectors' pattern). */
export function signalLines(text: string): string[] {
  return contentLines(text).filter((line) => SIGNAL_PATTERN.test(line))
}

/** Distinct word-like identifiers (length >= 2), in first-seen order. */
export function identifiers(text: string): string[] {
  const seen = new Set<string>()
  for (const match of visible(text).matchAll(IDENTIFIER)) {
    if (match[0].length >= 2 && WORD_CHAR.test(match[0])) seen.add(match[0])
  }
  return [...seen]
}

/**
 * Lines whose exact content occurs fewer than `minRun` times — i.e. lines that
 * log-compact's run collapse (minRun 3) would *not* fold away. "Novel" here is
 * the inverse of collapse: dropping these drops non-redundant content.
 */
export function novelExactLines(text: string, minRun = 3): string[] {
  const lines = contentLines(text)
  const counts = new Map<string, number>()
  for (const line of lines) counts.set(line, (counts.get(line) ?? 0) + 1)
  return lines.filter((line) => (counts.get(line) ?? 0) < minRun)
}

/**
 * Lines whose digit-masked shape (`lineShape`) is unique in the input. Catches
 * "novel value buried in near-duplicate filler" — the same signal the
 * extractive selector scores with its novelty term.
 */
export function novelShapeLines(text: string): string[] {
  const lines = contentLines(text)
  const shapes = lines.map((line) => lineShape(line))
  const counts = new Map<string, number>()
  for (const shape of shapes) counts.set(shape, (counts.get(shape) ?? 0) + 1)
  return lines.filter((_, i) => (counts.get(shapes[i]) ?? 0) === 1)
}

/**
 * True when `line` survives in `output`: whole when it is within the 400-char
 * cap, or as the 399-char prefix a "…"-truncated long line preserves verbatim.
 * A line left as a fragment by a raw char cut does not count. Both sides are
 * compared as visible text, so ANSI stripping is not counted as a loss.
 */
export function retainedLine(output: string, line: string): boolean {
  if (line.length === 0) return false
  const probe = line.length > RETAIN_PREFIX ? line.slice(0, RETAIN_PREFIX - 1) : line
  return visible(output).includes(probe)
}

/** Count of `lines` that survive in `output`. */
export function retainedLines(output: string, lines: readonly string[]): number {
  let kept = 0
  for (const line of lines) if (retainedLine(output, line)) kept += 1
  return kept
}

/** Count of `ids` whose full text occurs in the output's visible text. */
export function retainedIdentifiers(output: string, ids: readonly string[]): number {
  const text = visible(output)
  let kept = 0
  for (const id of ids) if (text.includes(id)) kept += 1
  return kept
}

/** Retention as a percentage, or null when the input has none of that class. */
export function pct(kept: number, total: number): number | null {
  return total === 0 ? null : (kept / total) * 100
}

// --- Fragmentation (cut-token detection) -------------------------------------

/**
 * `[ctx-guard: …]` markers, dropped before fragment tokenizing so marker
 * vocabulary (`chars`, `omitted`, `kept`, `middle`, counts) can never be
 * mistaken for content.
 */
const MARKER = /\[ctx-guard:[^\]]*\]/g

/** True when `token` is a proper prefix or suffix of some whole input identifier. */
function isFragment(token: string, ids: Set<string>): boolean {
  if (token.length < 2 || ids.has(token)) return false
  for (const id of ids) {
    if (id.length > token.length && (id.startsWith(token) || id.endsWith(token))) return true
  }
  return false
}

/**
 * Count of identifiers a selector *cut*: maximal output runs that are a proper
 * prefix or suffix of a whole input identifier, but are not whole identifiers
 * themselves. A faithful-subset output can only cut a token at a boundary, so a
 * fragment is always a prefix (head/"…"-truncation cut) or a suffix (tail cut) —
 * never a middle substring — which is what keeps this precise.
 *
 * head-tail emits up to two (one per raw char cut); token-budget emits none
 * wherever a boundary exists to snap to. This is the proxy that shows
 * token-boundary cleanliness, which retention metrics cannot see.
 */
export function fragments(input: string, output: string): number {
  const ids = new Set(identifiers(input))
  const text = visible(output).replace(MARKER, " ")
  let count = 0
  for (const match of text.matchAll(IDENTIFIER)) {
    if (WORD_CHAR.test(match[0]) && isFragment(match[0], ids)) count += 1
  }
  return count
}
