/**
 * Compression selectors: pluggable, faithful text compactors.
 *
 * A selector maps a text string to a compaction of it. The **faithful
 * contract**: the output is a verbatim subset of the input's words/lines,
 * optionally joined by delimited `[parsnip: …]` markers that carry only
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

/**
 * The head/tail budget implied by a threshold: 40% from the front, 30% from the
 * back. At the default `MIN_CHARS` (4000) this is exactly the historical
 * HEAD_CHARS/TAIL_CHARS pair, so a selector with no override is byte-identical to
 * its behaviour before this existed.
 *
 * Deriving the budget from the threshold is what makes a lowered threshold do
 * anything at all. Before this the budget was frozen at 2800 while the gate sat
 * at 4000 - and since a selector only omits text once the input exceeds
 * head+tail, the FROZEN BUDGET was the binding constraint: every result between
 * 2800 and 4000 came back verbatim no matter where minChars sat. Measured, not
 * assumed.
 *
 * Derived, the budget is always 0.7 x the threshold, which is strictly below the
 * threshold itself, so the GATE becomes the binding constraint and the effective
 * floor is the threshold: at 4000 nothing under 4000 compacts (as before), and
 * at 1500 the floor moves down to 1500 instead of staying stuck at 2800.
 * Verified by bisection, not inferred from the formula.
 */
export function budgetFor(minChars: number): { headChars: number; tailChars: number } {
  return { headChars: Math.round(minChars * 0.4), tailChars: Math.round(minChars * 0.3) }
}

/**
 * A threshold override is honoured only when it is a finite number that clears
 * the floor. Anything else (absent, NaN, 0, negative, absurdly small) falls back
 * to the selector's own defaults rather than producing a degenerate budget.
 */
function validThreshold(minChars: number | undefined): minChars is number {
  return typeof minChars === "number" && Number.isFinite(minChars) && minChars >= 200
}

export function omissionMarker(omittedChars: number): string {
  return `… [parsnip: ${omittedChars} chars omitted] …`
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
// delimiter.
//
// `CHARS_PER_TOKEN` mirrors the `chars / 4` heuristic in `quality.ts`. It is NOT
// a claim about real token counts — it only expresses this selector's budget in
// token-shaped units so the option table reads naturally. It has no effect on
// fidelity: the retained characters are verbatim either way, and the
// `head-tail` budget it mirrors is identical in *chars*. (The plugin's actual
// token measurement is the `session.usage.updated` ledger in `storage.ts`.)
//
// Kept local so this module stays a leaf with no import from `quality.ts`.

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
// verbatim line plus a `[parsnip: ×N]` count marker. Distinct lines pass
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
  return `[parsnip: ×${count}]`
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
 * text is verbatim; only `[parsnip: …]` count markers are added.
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
 * text is verbatim; only `[parsnip: …]` markers are added.
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
  const signalHeader = `… [parsnip: ${kept.length} signal line(s) from the omitted middle] …`
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
  /**
   * Head-tail bound applied when the result has too few lines to rank away (the
   * giant-one-liner case). Carried in the options rather than referenced from the
   * module constant so a threshold override reaches it too.
   */
  fallback: CompressOptions
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
  fallback: COMPRESSION_OPTIONS,
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
 *
 * The four terms, and why each is weighted the way it is:
 *
 *  - `position` — the closer a line is to either end, the higher it scores
 *    (`1 / (1 + distance / leadBias)`). The ends of a log or diff carry the
 *    framing; the exact middle is the likeliest place for noise. Taking the max
 *    of the two ends means "near *either* end" scores well, not just the head.
 *  - `lengthScore` — a band, not a monotonic bonus. Very short lines are often
 *    separators or `}` noise (0.3); a normal-sized line is the useful default
 *    (1); a very long line is usually a minified blob or a stack dump (0.5).
 *  - `signal` — flat bonus for matching `SIGNAL_PATTERN` (errors, file:line,
 *    hashes). Same bonus as `signal-preserving` uses to rescue lines outright.
 *  - `novelty` — `noveltyWeight / shapeCount`, so a shape appearing once scores
 *    the full weight and a shape repeated 50 times scores 1/50 of it. This is
 *    the term that lets the selector find content with no shallow signal, and
 *    also the one that makes the known-answer eval circular on the
 *    `shape-novel` class: it wins that class by construction (see the README's
 *    salience section). Do not read its eval score as evidence of general
 *    value-preservation.
 *
 * Scores only *select*; output order is always original order.
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
  // Near either end scores high; the middle decays.
  const position = Math.max(
    1 / (1 + fromStart / o.leadBias),
    1 / (1 + fromEnd / o.leadBias),
  )
  const length = line.length
  // Too short = separator noise; normal = default; too long = blob.
  const lengthScore = length < 20 ? 0.3 : length <= 200 ? 1 : 0.5
  const signal = SIGNAL_PATTERN.test(line) ? o.signalWeight : 0
  // Rare shapes score high; ubiquitous shapes are pushed toward zero.
  const novelty = o.noveltyWeight / Math.max(1, shapeCount)
  return position + lengthScore + signal + novelty
}

/**
 * Keep a fixed lead + tail and fill the remaining budget with the highest
 * scoring middle lines, in original order. Faithful: retained lines are
 * verbatim (or "…"-truncated); only `[parsnip: …]` markers are added.
 */
export function compressExtractive(text: string, o: ExtractiveOptions): string {
  if (text.length <= o.minChars) return text
  const lines = text.split("\n")
  // Few lines: nothing to select away, and lead/tail would overlap — bound by
  // chars instead (the giant-one-liner case).
  if (lines.length <= o.maxLines) return compressText(text, o.fallback)

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
  const header = `… [parsnip: kept ${selected.length} of ${middle.length} middle lines] …`
  return `${lead.map(emit).join("\n")}\n${header}\n${selected.join("\n")}\n${tail.map(emit).join("\n")}`
}

// --- Selector registry ------------------------------------------------------

/**
 * Canonical list of selector ids. `SelectorName` is derived from it, and
 * `SELECTORS` is keyed by the same names, so adding an id here without
 * registering an implementation is a type error rather than a runtime lookup
 * failure.
 */
export const SELECTOR_NAMES = [
  "head-tail",
  "token-budget",
  "log-compact",
  "signal-preserving",
  "extractive",
] as const

export type SelectorName = (typeof SELECTOR_NAMES)[number]

/**
 * A faithful compactor: output is a verbatim subset of the input, never generated.
 *
 * `minChars` is an optional per-call threshold override. When omitted — or
 * rejected by `validThreshold` — the selector uses its own defaults, so every
 * existing single-argument call site behaves exactly as before.
 */
export type CompressionSelector = {
  id: SelectorName
  select: (text: string, minChars?: number) => string
}

/** Head-tail options for this call: derived from the override, or the defaults. */
function headTailAt(minChars: number | undefined): CompressOptions {
  if (!validThreshold(minChars)) return COMPRESSION_OPTIONS
  return { minChars, ...budgetFor(minChars) }
}

/** Positional head + tail with a counted omission marker. The baseline selector. */
export const headTail: CompressionSelector = {
  id: "head-tail",
  select: (text, minChars) => compressText(text, headTailAt(minChars)),
}

/**
 * Token-boundary-aware head + tail. Keeps the same budget as `head-tail` but
 * cuts between tokens (after whitespace or a delimiter) instead of at a raw
 * char index, so identifiers, numbers and words are never split.
 */
export const tokenBudget: CompressionSelector = {
  id: "token-budget",
  // Expresses the same derived budget in tokens: the char budget ÷ CHARS_PER_TOKEN.
  select: (text, minChars) => {
    if (!validThreshold(minChars)) return compressTokenBudget(text, TOKEN_BUDGET_OPTIONS)
    const { headChars, tailChars } = budgetFor(minChars)
    return compressTokenBudget(text, {
      ...TOKEN_BUDGET_OPTIONS,
      minTokens: Math.round(minChars / CHARS_PER_TOKEN),
      headTokens: Math.round(headChars / CHARS_PER_TOKEN),
      tailTokens: Math.round(tailChars / CHARS_PER_TOKEN),
    })
  },
}

/**
 * Structural log compaction: ANSI strip + identical-consecutive-line collapse,
 * bounded by head-tail. The highest ratio of the current selectors on
 * repetitive shell output.
 */
export const logCompact: CompressionSelector = {
  id: "log-compact",
  select: (text, minChars) => {
    if (!validThreshold(minChars)) return compressLog(text, LOG_COMPACT_OPTIONS)
    // The head-tail fallback shares the override, so the post-compaction bound
    // moves with the gate rather than staying frozen at 2800.
    return compressLog(text, { ...LOG_COMPACT_OPTIONS, minChars, fallback: headTailAt(minChars) })
  },
}

/**
 * Fidelity selector: head + tail plus bounded signal lines rescued from the
 * omitted middle. Degenerates to head-tail when the middle carries no signal.
 */
export const signalPreserving: CompressionSelector = {
  id: "signal-preserving",
  select: (text, minChars) =>
    compressSignal(text, validThreshold(minChars) ? { ...SIGNAL_OPTIONS, minChars, ...budgetFor(minChars) } : SIGNAL_OPTIONS),
}

/**
 * General fidelity selector: a fixed lead + tail plus the highest-scoring middle
 * lines (position + length + signal), in original order.
 */
export const extractive: CompressionSelector = {
  id: "extractive",
  select: (text, minChars) => {
    if (!validThreshold(minChars)) return compressExtractive(text, EXTRACTIVE_OPTIONS)
    // `maxChars` is the ranked-middle budget, half the threshold — matching
    // the historical 2000 at the default 4000. The lead/tail line counts stay
    // fixed: they are structural, not size-derived.
    return compressExtractive(text, {
      ...EXTRACTIVE_OPTIONS,
      minChars,
      maxChars: Math.round(minChars * 0.5),
      fallback: headTailAt(minChars),
    })
  },
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

/**
 * Resolve + apply in one call, for the hook's one-liner.
 *
 * `minChars` is forwarded to the selector as a threshold override; omit it to get
 * that selector's built-in defaults.
 */
export function selectWith(name: string, text: string, minChars?: number): string {
  return resolveSelector(name).select(text, minChars)
}
