/**
 * Compression selectors: pluggable, faithful text compactors.
 *
 * A selector maps a text string to a compaction of it. The **faithful
 * contract**: the output is a verbatim subset of the input's words/lines,
 * optionally joined by delimited `[ctx-guard: …]` markers that carry only
 * counts; a selector never invents content. Selectors are pure and synchronous.
 *
 * This is a **leaf module**: it imports nothing from the rest of the server, so
 * `toolhooks.ts` can depend on it without a cycle. Only a type reference to the
 * SDK would be allowed here, and there is none — nothing external is resolved at
 * runtime, so the plugin keeps zero runtime dependencies.
 *
 * Adding a selector: implement `{ id, select }`, add its id to `SELECTOR_NAMES`,
 * and register it in `SELECTORS`. Existing stored config values keep working:
 * `resolveSelector` falls back to `head-tail` for any unknown name.
 */

export type CompressOptions = {
  /** Results shorter than this are left completely untouched. */
  minChars: number
  /** Characters kept from the start of an oversized result. */
  headChars: number
  /** Characters kept from the end of an oversized result. */
  tailChars: number
}

// --- Defaults ---------------------------------------------------------------
//
// These are the *head-tail* selector's shape/bound parameters. Whether
// compression runs at all is runtime-configurable (see `server/lib/config.ts`);
// which selector runs is also runtime-configurable.
export const MIN_CHARS = 4000
export const HEAD_CHARS = 1600
export const TAIL_CHARS = 1200

export const COMPRESSION_OPTIONS: CompressOptions = {
  minChars: MIN_CHARS,
  headChars: HEAD_CHARS,
  tailChars: TAIL_CHARS,
}

export function omissionMarker(omittedChars: number): string {
  return `… [ctx-guard: ${omittedChars} chars omitted] …`
}

export function shouldCompress(text: string, o: CompressOptions): boolean {
  return text.length > o.minChars
}

/**
 * Keep the head and the tail of an oversized string, replacing the middle with
 * an omission marker. Anything that would not actually shrink is returned
 * verbatim.
 */
export function compressText(text: string, o: CompressOptions): string {
  if (!shouldCompress(text, o)) return text
  const omitted = text.length - o.headChars - o.tailChars
  if (omitted <= 0 || o.headChars < 0 || o.tailChars < 0) return text
  return `${text.slice(0, o.headChars)}\n${omissionMarker(omitted)}\n${text.slice(text.length - o.tailChars)}`
}

// --- Token-boundary helpers (for the token-budget selector) ------------------
//
// A cut is "safe" when it falls between tokens: after whitespace or a common
// delimiter. `CHARS_PER_TOKEN` mirrors the uncalibrated `estimateTokens`
// heuristic in `quality.ts` (chars / 4); it is only used to express the budget
// in tokens, and is kept local so this module stays a leaf.

const CHARS_PER_TOKEN = 4

/** Characters a safe cut may follow: whitespace or a common delimiter. */
const BOUNDARY = /[\s,{}\[\]:;"']/

/** True if cutting at index `i` would split a UTF-16 surrogate pair. */
function splitsSurrogate(text: string, i: number): boolean {
  if (i <= 0 || i >= text.length) return false
  const prev = text.charCodeAt(i - 1)
  const next = text.charCodeAt(i)
  return prev >= 0xd800 && prev <= 0xdbff && next >= 0xdc00 && next <= 0xdfff
}

/** True if `i` is a safe cut: not the start, right after a boundary char. */
function isBoundaryCut(text: string, i: number): boolean {
  return i > 0 && i <= text.length && BOUNDARY.test(text[i - 1])
}

/** Nearest safe cut at or before `target`; falls back to `target`. */
function snapHead(text: string, target: number, limit: number): number {
  const floor = Math.max(1, target - limit)
  for (let i = target; i >= floor; i -= 1) {
    if (isBoundaryCut(text, i)) return i
  }
  return splitsSurrogate(text, target) ? target - 1 : target
}

/** Nearest safe cut at or after `target`; falls back to `target`. */
function snapTail(text: string, target: number, limit: number): number {
  const ceiling = Math.min(text.length, target + limit)
  for (let i = target; i <= ceiling; i += 1) {
    if (isBoundaryCut(text, i)) return i
  }
  return splitsSurrogate(text, target) ? target - 1 : target
}

export type TokenBudgetOptions = {
  /** Results at or below this many tokens are left untouched. */
  minTokens: number
  /** Token budget kept from the start of an oversized result. */
  headTokens: number
  /** Token budget kept from the end of an oversized result. */
  tailTokens: number
  /** Max chars to scan for a boundary before falling back to the raw cut. */
  snapLimit: number
}

/** Same effective budget as `head-tail` (tokens × CHARS_PER_TOKEN). */
export const TOKEN_BUDGET_OPTIONS: TokenBudgetOptions = {
  minTokens: 1000, // ≈4000 chars
  headTokens: 400, // ≈1600 chars
  tailTokens: 300, // ≈1200 chars
  snapLimit: 128,
}

/**
 * Head + tail sized by a token budget, cut on token boundaries. Faithful: the
 * output is a verbatim prefix + marker + verbatim suffix. Anything that would
 * not shrink is returned verbatim.
 */
export function compressTokenBudget(text: string, o: TokenBudgetOptions): string {
  if (text.length <= o.minTokens * CHARS_PER_TOKEN) return text
  const head = snapHead(text, o.headTokens * CHARS_PER_TOKEN, o.snapLimit)
  const tail = snapTail(text, text.length - o.tailTokens * CHARS_PER_TOKEN, o.snapLimit)
  if (tail <= head) return text
  return `${text.slice(0, head)}\n${omissionMarker(tail - head)}\n${text.slice(tail)}`
}

// --- Log compaction (for the log-compact selector) ---------------------------
//
// Structural compaction of shell output before any positional cut: strip ANSI
// escapes (lossless) and collapse runs of identical consecutive lines to one
// verbatim line plus a `[ctx-guard: ×N]` count marker. Distinct lines pass
// through untouched.

/** SGR/CSI escape sequences: colors, cursor moves. */
const ANSI_CSI = /\x1b\[[0-9;?]*[A-Za-z]/g
/** OSC sequences (hyperlinks, window titles), terminated by BEL or ST. */
const ANSI_OSC = /\x1b\][^\x1b\x07]*(?:\x07|\x1b\\)/g

/** Remove terminal escape sequences. Lossless for the visible text. */
export function stripAnsi(text: string): string {
  return text.replace(ANSI_OSC, "").replace(ANSI_CSI, "")
}

/** Count marker for a run of identical lines. */
export function runMarker(count: number): string {
  return `[ctx-guard: ×${count}]`
}

/**
 * Collapse a run of `>= minRun` identical consecutive lines to one verbatim line
 * plus a count marker. Shorter runs (and all distinct lines) are left as-is.
 */
export function collapseRuns(text: string, minRun: number): string {
  const lines = text.split("\n")
  const out: string[] = []
  let i = 0
  while (i < lines.length) {
    const line = lines[i]
    let run = 1
    while (i + run < lines.length && lines[i + run] === line) run += 1
    if (run >= minRun) out.push(`${line}  ${runMarker(run)}`)
    else for (let k = 0; k < run; k += 1) out.push(line)
    i += run
  }
  return out.join("\n")
}

export type LogCompactOptions = {
  /** Results at or below this many chars are left untouched. */
  minChars: number
  /** Minimum run length of identical consecutive lines to collapse. */
  minRun: number
  /** Head-tail bound applied when the compacted result is still oversized. */
  fallback: CompressOptions
}

export const LOG_COMPACT_OPTIONS: LogCompactOptions = {
  minChars: MIN_CHARS, // 4000 — same gate as head-tail
  minRun: 3,
  fallback: COMPRESSION_OPTIONS,
}

/**
 * Strip ANSI escapes and collapse identical consecutive-line runs, then bound
 * the result with head-tail when it is still oversized. Faithful: the retained
 * text is verbatim; only `[ctx-guard: …]` count markers are added.
 */
export function compressLog(text: string, o: LogCompactOptions): string {
  if (text.length <= o.minChars) return text
  const compacted = collapseRuns(stripAnsi(text), o.minRun)
  const bound = o.fallback.headChars + o.fallback.tailChars
  if (compacted.length > bound) return compressText(compacted, o.fallback)
  return compacted === text ? text : compacted
}

// --- Selector registry ------------------------------------------------------

/**
 * Canonical list of selector ids. Grows one entry at a time as each selector
 * lands; `SelectorName` is derived from it so the config surface and the
 * registry can never drift.
 */
export const SELECTOR_NAMES = ["head-tail", "token-budget", "log-compact"] as const

export type SelectorName = (typeof SELECTOR_NAMES)[number]

/** A faithful compactor: output is a verbatim subset of the input, never generated. */
export type CompressionSelector = {
  id: SelectorName
  select: (text: string) => string
}

/** Positional head + tail with a counted omission marker. The baseline selector. */
export const headTail: CompressionSelector = {
  id: "head-tail",
  select: (text) => compressText(text, COMPRESSION_OPTIONS),
}

/**
 * Token-boundary-aware head + tail. Keeps the same budget as `head-tail` but
 * cuts between tokens (after whitespace or a delimiter) instead of at a raw
 * char index, so identifiers, numbers and words are never split.
 */
export const tokenBudget: CompressionSelector = {
  id: "token-budget",
  select: (text) => compressTokenBudget(text, TOKEN_BUDGET_OPTIONS),
}

/**
 * Structural log compaction: ANSI strip + identical-consecutive-line collapse,
 * bounded by head-tail. The highest ratio of the current selectors on
 * repetitive shell output.
 */
export const logCompact: CompressionSelector = {
  id: "log-compact",
  select: (text) => compressLog(text, LOG_COMPACT_OPTIONS),
}

export const SELECTORS: Record<SelectorName, CompressionSelector> = {
  "head-tail": headTail,
  "token-budget": tokenBudget,
  "log-compact": logCompact,
}

export function isSelectorName(value: unknown): value is SelectorName {
  return typeof value === "string" && (SELECTOR_NAMES as readonly string[]).includes(value)
}

/**
 * Resolve a selector by name, falling back to `head-tail` for anything unknown
 * (a renamed/removed selector stored in an old config value must not throw).
 */
export function resolveSelector(name: string): CompressionSelector {
  return isSelectorName(name) ? SELECTORS[name] : headTail
}

/** Resolve + apply in one call, for the hook's one-liner. */
export function selectWith(name: string, text: string): string {
  return resolveSelector(name).select(text)
}
