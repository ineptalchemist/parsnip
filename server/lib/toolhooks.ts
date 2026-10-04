/**
 * Tool-hook logic: oversized bash/shell output compression + duplicate
 * suppression.
 *
 * Why this is cache-safe: `execute.after` rewrites a result that is *about to be
 * committed as new content*. It never touches anything already in the
 * transcript, so the provider's cached prefix stays intact. (The other
 * content-writing surface is `session.hook("compaction")`.)
 *
 * Compression is applied through a pluggable *selector* (see `./selectors.ts`);
 * this module owns the result-level handling (string vs. text parts, file /
 * output / metadata passthrough) and dedup.
 *
 * Everything here is pure and unit-testable under `node --test`. The storage
 * helpers at the bottom take the storage domain as a parameter, and the type
 * import is erased by Node's type stripper, so this module adds no runtime
 * dependency.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"

// Compression primitives + the selector registry live in `./selectors.ts` (a
// leaf module). Re-exported here so existing imports keep resolving.
export {
  COMPRESSION_OPTIONS,
  HEAD_CHARS,
  MIN_CHARS,
  TAIL_CHARS,
  compressText,
  omissionMarker,
  shouldCompress,
} from "./selectors.ts"
export type { CompressOptions, CompressionSelector, SelectorName } from "./selectors.ts"

/** Loosely-typed view of `Tool.Result` (which has readonly fields). */
export type ToolResultLike = {
  readonly content?: unknown
  readonly output?: unknown
  readonly metadata?: unknown
}

// --- Defaults ---------------------------------------------------------------
//
// Whether compression/dedup actually run is runtime-configurable via
// `server/lib/config.ts` (a persisted switch, default compression OFF / dedup
// ON). The compression *shape/bound* defaults live in `./selectors.ts`.
export const DEDUP_MIN_CHARS = 1000
export const DEDUP_MEMORY = 16

/** Confirmed live on 2.0.19 in step 2.1: the shell tool is `shell`. */
export const SHELL_TOOLS: readonly string[] = ["bash", "shell"]

/**
 * Search / retrieval tools whose large results are subject to dedup (and, when
 * compression is enabled, compression). Matched as case-insensitive substrings,
 * so MCP prefixes/namespaces still match (`parallel_web_search`,
 * `firecrawl.firecrawl_search`, …). Content-hash keying (see `dedupSignature`)
 * makes collapsing their repeats safe: a re-fetch whose content changed simply
 * does not match.
 */
export const SEARCH_TOOLS: readonly string[] = [
  "websearch",
  "web_search",
  "web_fetch",
  "firecrawl_search",
  "firecrawl_scrape",
]

/** Every tool whose result the plugin may rewrite in `execute.after`. */
export const TARGET_TOOLS: readonly string[] = [...SHELL_TOOLS, ...SEARCH_TOOLS]

export const DEDUP_MARKER =
  "[parsnip: duplicate output suppressed — same command ran recently]"

/**
 * Longest command snippet kept as continuity state.
 *
 * This is the *recording* bound: `commandOf` truncates to it in `execute.before`
 * before the value is written to `session:<id>`.
 *
 * `compaction.ts` has a same-valued constant of its own for the *rendering*
 * bound (truncating again when building the continuity block). They are
 * deliberately separate, not accidental duplicates: the value in storage is
 * already at most this long, so the second truncation is normally a no-op and
 * only bites if something wrote a longer value by hand. Kept as two constants
 * because `compaction.ts` must stay a leaf module with no import from here.
 */
export const MAX_COMMAND_CHARS = 200

// --- Savings ledger ---------------------------------------------------------
//
// Pure tally of what compression + dedup actually removed, per session. This is
// the measurement surface: the "chars omitted" numbers are exact, because the
// hook rewrites a result *about to be committed*, so the pre-rewrite text length
// is exactly what would otherwise have entered the transcript.

/** Per-method breakdown: what one compression selector removed, and kept. */
export type SelectorTally = {
  /** Number of results compressed by this selector. */
  compressions: number
  /** Total chars this selector dropped. */
  charsOmitted: number
  /** Total chars that survived (output length, markers included). */
  charsKept: number
}

/** Per-session tally of what compression + dedup removed (in chars). */
export type SavingsLedger = {
  /** Number of results compressed (head + tail + omission marker). */
  compressions: number
  /** Total chars dropped by compression across the session. */
  charsOmitted: number
  /** Number of repeated large results collapsed to a marker. */
  dedups: number
  /** Total chars replaced by the dedup marker across the session. */
  charsDeduped: number
  /** The same compression events, broken down by selector id (fidelity signal). */
  bySelector: Record<string, SelectorTally>
}

export const emptySavings = (): SavingsLedger => ({
  compressions: 0,
  charsOmitted: 0,
  dedups: 0,
  charsDeduped: 0,
  bySelector: {},
})

/**
 * Fold a compression event into the ledger, globally and per selector. The
 * omitted chars are the difference between the pre- and post-compression text
 * lengths (the omission marker is already part of the compressed result, so the
 * delta is exact).
 */
export function addCompression(
  ledger: SavingsLedger,
  selector: string,
  originalLen: number,
  compressedLen: number,
): SavingsLedger {
  const omitted = Math.max(0, originalLen - compressedLen)
  if (omitted === 0) return ledger
  const prev = ledger.bySelector[selector] ?? { compressions: 0, charsOmitted: 0, charsKept: 0 }
  return {
    ...ledger,
    compressions: ledger.compressions + 1,
    charsOmitted: ledger.charsOmitted + omitted,
    bySelector: {
      ...ledger.bySelector,
      [selector]: {
        compressions: prev.compressions + 1,
        charsOmitted: prev.charsOmitted + omitted,
        charsKept: prev.charsKept + Math.max(0, compressedLen),
      },
    },
  }
}

/** Coerce to a finite number, else 0 (storage may hold anything). */
function finiteOrZero(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Narrow stored JSON to a selector breakdown, dropping malformed entries. */
export function asBySelector(value: unknown): Record<string, SelectorTally> {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const out: Record<string, SelectorTally> = {}
  for (const [selector, tally] of Object.entries(value as Record<string, unknown>)) {
    if (!tally || typeof tally !== "object" || Array.isArray(tally)) continue
    const t = tally as Record<string, unknown>
    out[selector] = {
      compressions: finiteOrZero(t.compressions),
      charsOmitted: finiteOrZero(t.charsOmitted),
      charsKept: finiteOrZero(t.charsKept),
    }
  }
  return out
}

/** Fold a dedup event: the replaced text minus the marker length is the saving. */
export function addDedup(
  ledger: SavingsLedger,
  originalLen: number,
  markerLen: number = DEDUP_MARKER.length,
): SavingsLedger {
  const saved = Math.max(0, originalLen - markerLen)
  if (saved === 0) return ledger
  return {
    ...ledger,
    dedups: ledger.dedups + 1,
    charsDeduped: ledger.charsDeduped + saved,
  }
}

// --- Target selection -------------------------------------------------------

/** `shell`/`bash`, case-insensitively, or any tool name containing one of them. */
export function isTargetTool(
  tool: string,
  targets: readonly string[] = TARGET_TOOLS,
): boolean {
  const name = tool.toLowerCase()
  return targets.some((target) => name.includes(target.toLowerCase()))
}

// --- Compression ------------------------------------------------------------

/** Total length of the text content of a result (string or text parts only). */
export function textLengthOf(result: unknown): number {
  if (result == null || typeof result !== "object") return 0
  const content = (result as ToolResultLike).content
  if (typeof content === "string") return content.length
  if (!Array.isArray(content)) return 0

  let total = 0
  for (const part of content) {
    const text = textOfPart(part)
    if (text !== undefined) total += text.length
  }
  return total
}

/**
 * Concatenate a result's text parts (no separator), so
 * `resultTextOf(r).length === textLengthOf(r)`. Used by the fidelity ledger to
 * diff the pre- and post-compression text.
 */
export function resultTextOf(result: unknown): string {
  if (result == null || typeof result !== "object") return ""
  const content = (result as ToolResultLike).content
  if (typeof content === "string") return content
  if (!Array.isArray(content)) return ""

  let text = ""
  for (const part of content) {
    const piece = textOfPart(part)
    if (piece !== undefined) text += piece
  }
  return text
}

/**
 * Compress the text content of a tool result with a selector. Returns the input
 * unchanged when the selector leaves every text part untouched (structured
 * `output`-only results, small results). Never touches `output` or `metadata`;
 * `{ type: "file" }` parts pass through untouched.
 *
 * Immutable: a changed result is a copy, so the caller's object is never
 * mutated (the hook assigns the returned value).
 */
export function compressResult<T extends ToolResultLike>(
  result: T,
  select: (text: string) => string,
): T {
  if (result == null || typeof result !== "object") return result
  const content = result.content

  if (typeof content === "string") {
    const compressed = select(content)
    return compressed === content ? result : ({ ...result, content: compressed } as T)
  }

  if (!Array.isArray(content)) return result

  let changed = false
  const parts = content.map((part) => {
    const text = textOfPart(part)
    if (text === undefined) return part
    const compressed = select(text)
    if (compressed === text) return part
    changed = true
    return { ...(part as Record<string, unknown>), text: compressed }
  })

  return changed ? ({ ...result, content: parts } as T) : result
}

/**
 * Replace every text part (or a string content) with `marker`, leaving file
 * parts and structured `output`/`metadata` alone. Used for dedup suppression.
 */
export function replaceResultText<T extends ToolResultLike>(result: T, marker: string): T {
  if (result == null || typeof result !== "object") return result
  const content = result.content

  if (typeof content === "string") return { ...result, content: marker } as T
  if (!Array.isArray(content)) return result

  let changed = false
  const parts = content.map((part) => {
    if (textOfPart(part) === undefined) return part
    changed = true
    return { ...(part as Record<string, unknown>), text: marker }
  })

  return changed ? ({ ...result, content: parts } as T) : result
}

function textOfPart(part: unknown): string | undefined {
  if (part == null || typeof part !== "object") return undefined
  const p = part as Record<string, unknown>
  return typeof p.text === "string" ? p.text : undefined
}

// --- Dedup signatures -------------------------------------------------------

/** Stable signature for a (tool, input) pair; key order cannot cause a miss. */
export function signatureOf(tool: string, input: unknown): string {
  return `${tool}:${stableJson(input)}`
}

/**
 * Content-addressed dedup signature: the args-keyed `signatureOf` plus a
 * fingerprint of the *output* text. Folding the content in means a re-run whose
 * output changed never matches, so only byte-identical repeats collapse. The
 * args-only form would hide a changed result (a re-read of a file that changed,
 * a re-run whose log differs), which is exactly the freshness hazard.
 */
export function dedupSignature(tool: string, input: unknown, text: string): string {
  return `${signatureOf(tool, input)}:${fnv1a(text)}`
}

const MAX_SIGNATURE_DEPTH = 6

/** JSON with object keys sorted, so equivalent inputs hash identically. */
export function stableJson(value: unknown, depth = 0): string {
  if (value === undefined) return "undefined"
  if (value === null) return "null"

  const kind = typeof value
  if (kind === "number" || kind === "boolean" || kind === "bigint") return String(value)
  if (kind === "string") return JSON.stringify(value)
  if (kind === "function" || kind === "symbol") return JSON.stringify(String(value))

  if (depth >= MAX_SIGNATURE_DEPTH) return JSON.stringify("[deep]")

  if (Array.isArray(value)) {
    return `[${value.map((item) => stableJson(item, depth + 1)).join(",")}]`
  }

  const record = value as Record<string, unknown>
  const keys = Object.keys(record).sort()
  const body = keys
    .map((key) => `${JSON.stringify(key)}:${stableJson(record[key], depth + 1)}`)
    .join(",")
  return `{${body}}`
}

/** Best-effort command string from a shell tool input (`{ command }`). */
export function commandOf(input: unknown, maxChars = MAX_COMMAND_CHARS): string {
  if (input == null || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  const candidate =
    typeof record.command === "string"
      ? record.command
      : typeof record.cmd === "string"
        ? record.cmd
        : ""
  const command = candidate.trim()
  if (!command) return ""
  return command.length > maxChars ? `${command.slice(0, maxChars - 1).trimEnd()}…` : command
}

// --- Session-scoped dedup memory (ctx.storage) ------------------------------

export const toolHistoryKey = (sessionID: string): string => `session:${sessionID}:toolHistory`

/** Narrow stored JSON to a bounded list of signature strings. */
export function asSignatures(value: unknown, max = DEDUP_MEMORY): string[] {
  if (!Array.isArray(value)) return []
  const signatures = value.filter((entry): entry is string => typeof entry === "string")
  return signatures.slice(-max)
}

export async function loadRecentSignatures(
  storage: StorageDomain,
  sessionID: string,
): Promise<string[]> {
  return asSignatures(await storage.get(toolHistoryKey(sessionID)))
}

/** Append a signature, keeping only the most recent `max` entries. */
export async function saveRecentSignatures(
  storage: StorageDomain,
  sessionID: string,
  signatures: readonly string[],
  max = DEDUP_MEMORY,
): Promise<void> {
  const bounded = signatures.slice(-max)
  await storage.set(
    toolHistoryKey(sessionID),
    bounded as unknown as Parameters<StorageDomain["set"]>[1],
  )
}

// --- Fidelity ledger (per-session compression events) -----------------------
//
// One bounded fingerprint per compression, so an external eval can attribute
// context loss to a specific selector: `omittedHash` identifies exactly what a
// method dropped. Records only — the plugin does not judge quality itself.

/** Cap on retained events per session (a ring; newest kept). */
export const COMPRESSION_EVENT_MEMORY = 64

/** Chars of the dropped region kept verbatim for inspection. */
export const OMITTED_SAMPLE_CHARS = 120

/** 32-bit FNV-1a, 8-char hex. A correlation fingerprint, not a security hash. */
export function fnv1a(text: string): string {
  let hash = 0x811c9dc5
  for (let i = 0; i < text.length; i += 1) {
    hash ^= text.charCodeAt(i)
    hash = Math.imul(hash, 0x01000193)
  }
  return (hash >>> 0).toString(16).padStart(8, "0")
}

/**
 * The bytes between the longest common prefix and suffix of `input`/`output`.
 * Exact for prefix+suffix selectors (`head-tail`); best-effort for selectors
 * that reorder (they may over-report the dropped region).
 */
export function omittedRegion(input: string, output: string): string {
  const minLen = Math.min(input.length, output.length)
  let prefix = 0
  while (prefix < minLen && input[prefix] === output[prefix]) prefix += 1
  let suffix = 0
  while (
    suffix < minLen - prefix &&
    input[input.length - 1 - suffix] === output[output.length - 1 - suffix]
  ) {
    suffix += 1
  }
  return input.slice(prefix, input.length - suffix)
}

/** One compression event: what a selector dropped, and the identity of both ends. */
export type CompressionEvent = {
  selector: string
  tool: string
  at: number
  inputChars: number
  outputChars: number
  /** Net chars removed: `inputChars - outputChars`. */
  omittedChars: number
  /** FNV-1a of the pre-compression text. */
  inputHash: string
  /** FNV-1a of the post-compression text. */
  outputHash: string
  /** FNV-1a of the dropped region (best-effort; exact for head-tail). */
  omittedHash: string
  /** First `OMITTED_SAMPLE_CHARS` of the dropped region, for inspection. */
  omittedSample: string
}

/** Pure: build the fidelity event for one compression. */
export function compressionEvent(args: {
  selector: string
  tool: string
  input: string
  output: string
  now?: number
}): CompressionEvent {
  const { selector, tool, input, output } = args
  const region = omittedRegion(input, output)
  return {
    selector,
    tool,
    at: args.now ?? Date.now(),
    inputChars: input.length,
    outputChars: output.length,
    omittedChars: Math.max(0, input.length - output.length),
    inputHash: fnv1a(input),
    outputHash: fnv1a(output),
    omittedHash: fnv1a(region),
    omittedSample: region.slice(0, OMITTED_SAMPLE_CHARS),
  }
}

export const compressionsKey = (sessionID: string): string => `session:${sessionID}:compressions`

/** Narrow stored JSON to a bounded list of plausible events. */
export function asCompressionEvents(
  value: unknown,
  max = COMPRESSION_EVENT_MEMORY,
): CompressionEvent[] {
  if (!Array.isArray(value)) return []
  const events = value.filter((entry): entry is CompressionEvent => {
    if (!entry || typeof entry !== "object") return false
    const e = entry as Record<string, unknown>
    return typeof e.selector === "string" && typeof e.at === "number"
  })
  return events.slice(-max)
}

export async function loadRecentCompressions(
  storage: StorageDomain,
  sessionID: string,
): Promise<CompressionEvent[]> {
  return asCompressionEvents(await storage.get(compressionsKey(sessionID)))
}

/** Append an event, keeping only the most recent `COMPRESSION_EVENT_MEMORY`. */
export async function saveRecentCompressions(
  storage: StorageDomain,
  sessionID: string,
  events: readonly CompressionEvent[],
): Promise<void> {
  const bounded = events.slice(-COMPRESSION_EVENT_MEMORY)
  await storage.set(
    compressionsKey(sessionID),
    bounded as unknown as Parameters<StorageDomain["set"]>[1],
  )
}

// --- Recall cache (per-session dropped-text store) ---------------------------
//
// Compression is lossy to the *prompt* but must be lossless to the *system*:
// every byte parsnip drops is kept here, keyed by a short recall id surfaced in
// the omission marker, so the agent (via the `parsnip_recall` tool) or a human
// (via `/parsnip recall`) can get the full text back. Bounded by total bytes and
// entry count; oldest evicted first. This is the backstop for the fact that no
// selector — literal or model — can know a priori what matters.

/** Max bytes of dropped text retained per session. */
export const RECALL_BYTE_LIMIT = 1024 * 1024
/** Max recall entries retained per session. */
export const RECALL_MEMORY = 128

export type RecallEntry = {
  /** Short handle surfaced in the omission marker (`recall-<n>`). */
  id: string
  tool: string
  at: number
  inputChars: number
  /** FNV-1a of the full text, for correlation with the fidelity ledger. */
  inputHash: string
  /** First `OMITTED_SAMPLE_CHARS` of the dropped region, for the marker. */
  sample: string
  /** The FULL pre-compression text — lossless by construction. */
  text: string
}

/** The whole store: a monotonic counter (ids never reused) + the bounded ring. */
export type RecallState = { seq: number; entries: RecallEntry[] }

export const recallKey = (sessionID: string): string => `session:${sessionID}:recall`

/** Narrow untrusted stored JSON to a `RecallState`. */
export function asRecallState(value: unknown): RecallState {
  if (value == null || typeof value !== "object") return { seq: 0, entries: [] }
  const record = value as Record<string, unknown>
  const seq = typeof record.seq === "number" && record.seq >= 0 ? Math.floor(record.seq) : 0
  const raw = Array.isArray(record.entries) ? record.entries : []
  const entries = raw.filter((entry): entry is RecallEntry => {
    if (!entry || typeof entry !== "object") return false
    const e = entry as Record<string, unknown>
    return typeof e.id === "string" && typeof e.text === "string"
  })
  return { seq, entries }
}

export async function loadRecall(storage: StorageDomain, sessionID: string): Promise<RecallState> {
  return asRecallState(await storage.get(recallKey(sessionID)))
}

/**
 * Max entries listed by `formatRecallIndex`. The listing is a convenience, not
 * the data: anything beyond this is still retrievable by id, so the count of
 * unlisted rows is stated rather than silently dropped — same rule the
 * selectors follow when they omit a region.
 */
export const RECALL_INDEX_LIMIT = 50

/** `HH:MM:SSZ`. UTC so the output is identical on every host. */
function clockOf(at: number): string {
  if (!Number.isFinite(at)) return "--:--:--Z"
  return `${new Date(at).toISOString().slice(11, 19)}Z`
}

/**
 * Render the session's recall index: what was dropped, by which tool, how big,
 * and when — without including any of the dropped text.
 *
 * This is what makes dropped output reachable *after* a compaction. Before
 * compaction the agent can read an omission marker in context; a compaction
 * replaces the history, taking the markers with it, while this store survives
 * in `ctx.storage`. Without a way to enumerate it, recoverable text becomes
 * unreachable in practice.
 *
 * Honest about its own limits: `seq` counts every drop ever made in the session
 * while `entries` is the bounded ring, so `seq - entries.length` is exactly how
 * many were evicted. Saying so is the difference between an index and a promise.
 */
export function formatRecallIndex(state: RecallState, limit = RECALL_INDEX_LIMIT): string {
  const retained = state.entries.length
  const evicted = Math.max(0, state.seq - retained)

  if (retained === 0) {
    return state.seq === 0
      ? "parsnip: nothing has been dropped in this session yet — no recall entries."
      : `parsnip: no dropped text is retained. All ${state.seq} drop(s) from this ` +
          `session were evicted by the ${RECALL_MEMORY}-entry / ${RECALL_BYTE_LIMIT}-byte bound.`
  }

  const newestFirst = [...state.entries].reverse()
  const shown = newestFirst.slice(0, limit)
  const unlisted = newestFirst.length - shown.length

  const header =
    `parsnip recall index — ${retained} of ${state.seq} drop(s) retained` +
    (evicted > 0 ? `, ${evicted} evicted by the ${RECALL_MEMORY}-entry / 1 MB bound` : "") +
    ".\nNewest first. Pass an id to retrieve the full text."

  const lines = shown.map((entry) => {
    const tool = entry.tool.padEnd(14).slice(0, 14)
    return `  ${entry.id.padEnd(12)} ${tool} ${String(entry.inputChars).padStart(7)} chars  ${clockOf(entry.at)}`
  })

  const tail = unlisted > 0 ? `\n... and ${unlisted} older entr${unlisted === 1 ? "y" : "ies"} not listed; still retrievable by id.` : ""

  return [header, "", ...lines].join("\n") + tail
}

/** Trim to the byte/entry bounds (oldest first) and persist; `seq` is preserved. */
export async function saveRecall(
  storage: StorageDomain,
  sessionID: string,
  state: RecallState,
): Promise<void> {
  let entries = state.entries.slice(-RECALL_MEMORY)
  let bytes = entries.reduce((n, e) => n + e.text.length, 0)
  while (entries.length > 0 && bytes > RECALL_BYTE_LIMIT) {
    bytes -= entries[0].text.length
    entries = entries.slice(1)
  }
  const bounded: RecallState = { seq: state.seq, entries }
  await storage.set(
    recallKey(sessionID),
    bounded as unknown as Parameters<StorageDomain["set"]>[1],
  )
}

/** The marker appended to a compressed result so its dropped text is recoverable. */
export function recallNote(id: string, sample: string): string {
  return `[parsnip: full text dropped — recall parsnip_recall("${id}") — dropped region starts: "${sample}"]`
}

/**
 * Append `suffix` to the *last* text part (or a string content), leaving file
 * parts and structured `output`/`metadata` alone. Used to hang the recall note
 * off a compressed result without touching the selectors' own markers.
 */
export function appendResultText<T extends ToolResultLike>(result: T, suffix: string): T {
  if (result == null || typeof result !== "object") return result
  const content = result.content

  if (typeof content === "string") return { ...result, content: content + suffix } as T
  if (!Array.isArray(content)) return result

  let last = -1
  content.forEach((part, i) => {
    if (textOfPart(part) !== undefined) last = i
  })
  if (last < 0) return result

  const parts = content.slice()
  const text = textOfPart(content[last]) as string
  parts[last] = { ...(content[last] as Record<string, unknown>), text: text + suffix }
  return { ...result, content: parts } as T
}

// --- Per-session storage cleanup --------------------------------------------
//
// `ctx.storage` (OpenCode's `kv` table) has NO session foreign key / cascade, so
// a plugin's `session:<id>:*` keys are orphaned forever when a session is
// deleted. `pruneSession` removes them; the plugin calls it on `session.deleted`
// so per-session storage is bounded by session lifetime.

/** Remove every `session:<id>:*` key; returns how many were removed. */
export async function pruneSession(storage: StorageDomain, sessionID: string): Promise<number> {
  const { entries } = await storage.scan({ prefix: `session:${sessionID}:` })
  for (const entry of entries) await storage.remove(entry.key)
  return entries.length
}
