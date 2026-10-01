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

// --- Signal preservation (for the signal-preserving selector) ----------------
//
// Keep head + tail, and rescue middle lines that look like a diagnostic:
// errors, exceptions, file:line refs, long hashes, paths and URLs. Deterministic
// patterns only; degenerates to head-tail when the middle carries no signal.

/** Combined signal pattern (case-insensitive). Diagnostic-shaped lines only. */
export const SIGNAL_PATTERN =
  /\b(?:error|fatal|exception|traceback|panic|failed|failure|critical|timeout|timed out|denied|not found|exit code|non-?zero|killed|segfault|syntax error|compilation failed)\b|\b[\w./-]+\.\w{1,5}:\d+(?::\d+)?|\b[0-9a-f]{40,64}\b|\b(?:https?|file):\/\/\S+|(?:^|\s)\/(?:[\w.-]+\/)+[\w.-]+/i

/** True if cutting at `i` starts a new line (the previous char is a newline). */
export function isLineCut(text: string, i: number): boolean {
  return i > 0 && i <= text.length && text[i - 1] === "\n"
}

/** Nearest line boundary at or after `target`; falls back to `target`. */
export function snapLineForward(text: string, target: number, limit: number): number {
  const ceiling = Math.min(text.length, target + limit)
  for (let i = target; i <= ceiling; i += 1) {
    if (isLineCut(text, i)) return i
  }
  return splitsSurrogate(text, target) ? target - 1 : target
}

/** Nearest line boundary at or before `target`; falls back to `target`. */
export function snapLineBackward(text: string, target: number, limit: number): number {
  const floor = Math.max(1, target - limit)
  for (let i = target; i >= floor; i -= 1) {
    if (isLineCut(text, i)) return i
  }
  return splitsSurrogate(text, target) ? target - 1 : target
}

export type SignalOptions = {
  /** Results at or below this many chars are left untouched. */
  minChars: number
  /** Char budget kept from the start (snapped to a line boundary). */
  headChars: number
  /** Char budget kept from the end (snapped to a line boundary). */
  tailChars: number
  /** Max number of rescued middle lines. */
  maxSignalLines: number
  /** Max total chars in the rescued block. */
  maxSignalChars: number
  /** Max chars kept per rescued line (longer lines are "…"-truncated). */
  maxSignalLineChars: number
  /** Max chars to scan for a line boundary before falling back. */
  snapLimit: number
}

export const SIGNAL_OPTIONS: SignalOptions = {
  minChars: MIN_CHARS,
  headChars: HEAD_CHARS,
  tailChars: TAIL_CHARS,
  maxSignalLines: 25,
  maxSignalChars: 2000,
  maxSignalLineChars: 400,
  snapLimit: 128,
}

/**
 * Rescue up to `maxSignalLines` / `maxSignalChars` of the middle's signal lines,
 * in order, each "…"-truncated to `maxSignalLineChars`.
 */
export function signalLines(middle: string, o: SignalOptions): string[] {
  const kept: string[] = []
  let chars = 0
  for (const line of middle.split("\n")) {
    if (kept.length >= o.maxSignalLines) break
    if (!SIGNAL_PATTERN.test(line)) continue
    const text =
      line.length > o.maxSignalLineChars
        ? `${line.slice(0, o.maxSignalLineChars - 1)}…`
        : line
    if (chars + text.length > o.maxSignalChars) break
    kept.push(text)
    chars += text.length
  }
  return kept
}

/**
 * Keep head + tail, rescuing bounded middle lines that match `SIGNAL_PATTERN`.
 * Degenerates to head-tail when the middle has no signal. Faithful: retained
 * text is verbatim; only `[ctx-guard: …]` markers are added.
 */
export function compressSignal(text: string, o: SignalOptions): string {
  if (text.length <= o.minChars) return text
  const headEnd = snapLineBackward(text, o.headChars, o.snapLimit)
  const tailStart = snapLineForward(text, text.length - o.tailChars, o.snapLimit)
  if (tailStart <= headEnd) return text

  const head = text.slice(0, headEnd)
  const middle = text.slice(headEnd, tailStart)
  const tail = text.slice(tailStart)
  const kept = signalLines(middle, o)

  if (kept.length === 0) return `${head}\n${omissionMarker(middle.length)}\n${tail}`

  const keptText = kept.join("\n")
  const omitted = middle.length - keptText.length
  const signalHeader = `… [ctx-guard: ${kept.length} signal line(s) from the omitted middle] …`
  const tailMarker = omitted > 0 ? `${omissionMarker(omitted)}\n` : ""
  return `${head}\n${signalHeader}\n${keptText}\n${tailMarker}${tail}`
}

// --- Extractive summarization (for the extractive selector) ------------------
//
// Rank lines by a deterministic heuristic and keep the best ones: a fixed lead +
// tail for framing, then the highest-scoring middle lines. Retained lines are
// verbatim and stay in original order (score selects, never reorders).

export type ExtractiveOptions = {
  /** Results at or below this many chars are left untouched. */
  minChars: number
  /** Total lines kept (lead + ranked middle + tail). */
  maxLines: number
  /** Lines always kept from the start. */
  leadLines: number
  /** Lines always kept from the end. */
  tailLines: number
  /** Char budget for the ranked middle. */
  maxChars: number
  /** Max chars kept per line (longer lines are "…"-truncated). */
  maxLineChars: number
  /** Position decay: larger reaches further inward from the ends. */
  leadBias: number
  /** Score bonus for a line matching `SIGNAL_PATTERN`. */
  signalWeight: number
  /** Score bonus for a line whose shape is unique (scaled by 1 / shape count). */
  noveltyWeight: number
}

export const EXTRACTIVE_OPTIONS: ExtractiveOptions = {
  minChars: MIN_CHARS,
  maxLines: 40,
  leadLines: 3,
  tailLines: 3,
  maxChars: 2000,
  maxLineChars: 400,
  leadBias: 5,
  signalWeight: 2,
  noveltyWeight: 1,
}

/** Trim a line to `max` chars, marking the cut with "…". */
export function truncateLine(line: string, max: number): string {
  return line.length > max ? `${line.slice(0, max - 1)}…` : line
}

/**
 * A line's "shape": digits masked, so lines that differ only by a number
 * (`filler 0 …` vs `filler 199 …`) collapse to one shape. Used to measure
 * novelty — how rare a line is among its peers.
 */
export function lineShape(line: string): string {
  return line.replace(/\d+/g, "#").trim()
}

/**
 * Deterministic keep-score: end-of-text position bias + length band + signal +
 * novelty. `shapeCount` is how many lines share this line's shape (1 = unique).
 */
export function scoreLine(
  line: string,
  index: number,
  total: number,
  o: ExtractiveOptions,
  shapeCount = 1,
): number {
  const fromStart = index
  const fromEnd = total - 1 - index
  const position = Math.max(
    1 / (1 + fromStart / o.leadBias),
    1 / (1 + fromEnd / o.leadBias),
  )
  const length = line.length
  const lengthScore = length < 20 ? 0.3 : length <= 200 ? 1 : 0.5
  const signal = SIGNAL_PATTERN.test(line) ? o.signalWeight : 0
  const novelty = o.noveltyWeight / Math.max(1, shapeCount)
  return position + lengthScore + signal + novelty
}

/**
 * Keep a fixed lead + tail and fill the remaining budget with the highest
 * scoring middle lines, in original order. Faithful: retained lines are
 * verbatim (or "…"-truncated); only `[ctx-guard: …]` markers are added.
 */
export function compressExtractive(text: string, o: ExtractiveOptions): string {
  if (text.length <= o.minChars) return text
  const lines = text.split("\n")
  // Few lines: nothing to select away, and lead/tail would overlap — bound by
  // chars instead (the giant-one-liner case).
  if (lines.length <= o.maxLines) return compressText(text, COMPRESSION_OPTIONS)

  const emit = (line: string): string => truncateLine(line, o.maxLineChars)
  const lead = lines.slice(0, o.leadLines)
  const tail = lines.slice(lines.length - o.tailLines)
  const middle = lines.slice(o.leadLines, lines.length - o.tailLines)

  const budget = Math.max(0, o.maxLines - lead.length - tail.length)
  const shapes = new Map<string, number>()
  const shapeOf = middle.map((line) => {
    const shape = lineShape(line)
    shapes.set(shape, (shapes.get(shape) ?? 0) + 1)
    return shape
  })
  const ranked = middle
    .map((line, index) => ({
      line,
      index,
      score: scoreLine(line, index, middle.length, o, shapes.get(shapeOf[index]) ?? 1),
    }))
    .sort((a, b) => b.score - a.score)

  const kept: Array<{ line: string; index: number }> = []
  let chars = 0
  for (const entry of ranked) {
    if (kept.length >= budget) break
    const cost = Math.min(entry.line.length, o.maxLineChars)
    if (chars + cost > o.maxChars) continue
    kept.push(entry)
    chars += cost
  }
  kept.sort((a, b) => a.index - b.index)

  const selected = kept.map((entry) => emit(entry.line))
  const header = `… [ctx-guard: kept ${selected.length} of ${middle.length} middle lines] …`
  return `${lead.map(emit).join("\n")}\n${header}\n${selected.join("\n")}\n${tail.map(emit).join("\n")}`
}

// --- Selector registry ------------------------------------------------------

/**
 * Canonical list of selector ids. Grows one entry at a time as each selector
 * lands; `SelectorName` is derived from it so the config surface and the
 * registry can never drift.
 */
export const SELECTOR_NAMES = [
  "head-tail",
  "token-budget",
  "log-compact",
  "signal-preserving",
  "extractive",
] as const

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

/**
 * Fidelity selector: head + tail plus bounded signal lines rescued from the
 * omitted middle. Degenerates to head-tail when the middle carries no signal.
 */
export const signalPreserving: CompressionSelector = {
  id: "signal-preserving",
  select: (text) => compressSignal(text, SIGNAL_OPTIONS),
}

/**
 * General fidelity selector: a fixed lead + tail plus the highest-scoring middle
 * lines (position + length + signal), in original order.
 */
export const extractive: CompressionSelector = {
  id: "extractive",
  select: (text) => compressExtractive(text, EXTRACTIVE_OPTIONS),
}

export const SELECTORS: Record<SelectorName, CompressionSelector> = {
  "head-tail": headTail,
  "token-budget": tokenBudget,
  "log-compact": logCompact,
  "signal-preserving": signalPreserving,
  extractive: extractive,
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
