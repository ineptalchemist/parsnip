/**
 * Tool-hook logic: oversized bash/shell output compression + duplicate
 * suppression.
 *
 * Why this is cache-safe: `execute.after` rewrites a result that is *about to be
 * committed as new content*. It never touches anything already in the
 * transcript, so the provider's cached prefix stays intact. (The other
 * content-writing surface is `session.hook("compaction")`.)
 *
 * Everything here is pure and unit-testable under `node --test`. The storage
 * helpers at the bottom take the storage domain as a parameter, and the type
 * import is erased by Node's type stripper, so this module adds no runtime
 * dependency.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"

export type CompressOptions = {
  /** Results shorter than this are left completely untouched. */
  minChars: number
  /** Characters kept from the start of an oversized result. */
  headChars: number
  /** Characters kept from the end of an oversized result. */
  tailChars: number
}

/** Loosely-typed view of `Tool.Result` (which has readonly fields). */
export type ToolResultLike = {
  readonly content?: unknown
  readonly output?: unknown
  readonly metadata?: unknown
}

// --- Defaults (flip off with the *_ENABLED flags) ---------------------------
//
// COMPRESSION_ENABLED is currently OFF (2026-09-30) while the tool-output
// quality harness is built (see README "Measuring effects"); DEDUP stays ON.
// Flip back to `true` to re-enable head+tail truncation.
export const COMPRESSION_ENABLED = false
export const MIN_CHARS = 4000
export const HEAD_CHARS = 1600
export const TAIL_CHARS = 1200

export const DEDUP_ENABLED = true
export const DEDUP_MIN_CHARS = 1000
export const DEDUP_MEMORY = 16

/** Confirmed live on 2.0.19 in step 2.1: the shell tool is `shell`. */
export const TARGET_TOOLS: readonly string[] = ["bash", "shell"]

export const COMPRESSION_OPTIONS: CompressOptions = {
  minChars: MIN_CHARS,
  headChars: HEAD_CHARS,
  tailChars: TAIL_CHARS,
}

export const DEDUP_MARKER =
  "[ctx-guard: duplicate output suppressed — same command ran recently]"

/** Longest command snippet kept as continuity state. */
export const MAX_COMMAND_CHARS = 200

export function omissionMarker(omittedChars: number): string {
  return `… [ctx-guard: ${omittedChars} chars omitted] …`
}

// --- Savings ledger ---------------------------------------------------------
//
// Pure tally of what compression + dedup actually removed, per session. This is
// the measurement surface: the "chars omitted" numbers are exact, because the
// hook rewrites a result *about to be committed*, so the pre-rewrite text length
// is exactly what would otherwise have entered the transcript.

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
}

export const emptySavings = (): SavingsLedger => ({
  compressions: 0,
  charsOmitted: 0,
  dedups: 0,
  charsDeduped: 0,
})

/**
 * Fold a compression event into the ledger. The omitted chars are the
 * difference between the pre- and post-compression text lengths (the omission
 * marker is already part of the compressed result, so the delta is exact).
 */
export function addCompression(
  ledger: SavingsLedger,
  originalLen: number,
  compressedLen: number,
): SavingsLedger {
  const omitted = Math.max(0, originalLen - compressedLen)
  if (omitted === 0) return ledger
  return {
    ...ledger,
    compressions: ledger.compressions + 1,
    charsOmitted: ledger.charsOmitted + omitted,
  }
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
 * Compress the text content of a tool result. Returns the input unchanged when
 * there is nothing to compress (structured `output`-only results, small
 * results). Never touches `output` or `metadata`; `{ type: "file" }` parts pass
 * through untouched.
 *
 * Immutable: a changed result is a copy, so the caller's object is never
 * mutated (the hook assigns the returned value).
 */
export function compressResult<T extends ToolResultLike>(
  result: T,
  o: CompressOptions = COMPRESSION_OPTIONS,
): T {
  if (result == null || typeof result !== "object") return result
  const content = result.content

  if (typeof content === "string") {
    const compressed = compressText(content, o)
    return compressed === content ? result : ({ ...result, content: compressed } as T)
  }

  if (!Array.isArray(content)) return result

  let changed = false
  const parts = content.map((part) => {
    const text = textOfPart(part)
    if (text === undefined) return part
    const compressed = compressText(text, o)
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
