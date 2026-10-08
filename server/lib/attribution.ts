/**
 * Per-tool context attribution — pure bookkeeping for the `parsnip_context`
 * report.
 *
 * What this answers: *what is filling the window*. The `/context` TUI plugin
 * (`opencode-context-usage`) reports accounting totals; nothing reports
 * attribution — how much of the session's context came from each tool —
 * because OpenCode delivers request usage as a single aggregate. This module
 * is the pure half: fold counters, narrow stored JSON, build the request
 * snapshot, format the report. Capture and wiring live in `index.ts`.
 *
 * The honesty split (see NOTES.md "Context attribution"):
 *
 *  - Every character count is EXACT as observed by the plugin: result text
 *    sizes at `execute.after` (already after OpenCode's native `tool_output`
 *    limits, hence "observed", not "raw") and the category sizes of the
 *    current-request snapshot.
 *  - Every token figure is an ESTIMATE — chars divided by a chars-per-token
 *    ratio (the session's own measurement when available, else the
 *    install-measured 3.5 fallback) — and must render with `~`.
 *  - Provider usage (`session.usage.updated`, `TokenUsageState`) is the only
 *    authoritative token data and is never mixed into the estimates.
 *
 * Counters only — no tool text is stored anywhere here. Helpers take the
 * storage domain as a parameter and the value imports are sibling modules
 * (`quality.ts`, `storage.ts`), so the whole surface is unit-testable under
 * `node --test` with no external dependency.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { safeJson } from "./quality.ts"
import type { TokenUsageState } from "./storage.ts"

// --- Bounds and labels -------------------------------------------------------

/** Tools kept per session; the smallest by observed chars are evicted first. */
export const ATTRIBUTION_TOOL_LIMIT = 256

/** Per-tool rows kept in a request snapshot; the rest folds into the overflow. */
export const SNAPSHOT_TOOL_LIMIT = 64

/** Default width of the top-contributor lists. */
export const DEFAULT_TOP_N = 10

/** Bucket for tool-result parts whose message part carries no tool identity. */
export const UNATTRIBUTED_TOOL = "(unattributed)"

/** Bucket for tool names that are absent or blank in the event. */
export const UNKNOWN_TOOL = "(unknown)"

// --- Ledger ------------------------------------------------------------------

export type ToolCounters = {
  /** Completed calls observed (error results are not attributed). */
  calls: number
  /** Results that carried any text at all. */
  nonEmptyResults: number
  /** Result text at `execute.after` entry, post native limits: exact chars. */
  observedChars: number
  /** Text that actually entered the transcript, markers included: exact chars. */
  retainedChars: number
  /** `observedChars - retainedChars`, clamped at zero. */
  omittedChars: number
  /** Times parsnip compression shortened this tool's result. */
  compressionCount: number
  /** Times dedup collapsed this tool's repeated result to the marker. */
  dedupCount: number
}

/**
 * Session-wide per-tool counters. Token estimates are deliberately NOT stored
 * — they derive from chars at render time, so the stored record cannot drift
 * from its source.
 */
export type AttributionLedger = {
  tools: Record<string, ToolCounters>
  /** Tool rows evicted by the bound so far, so the report can say so. */
  droppedTools: number
  updatedAt: number
}

export function emptyToolCounters(): ToolCounters {
  return {
    calls: 0,
    nonEmptyResults: 0,
    observedChars: 0,
    retainedChars: 0,
    omittedChars: 0,
    compressionCount: 0,
    dedupCount: 0,
  }
}

export function emptyLedger(now = Date.now()): AttributionLedger {
  return { tools: {}, droppedTools: 0, updatedAt: now }
}

/** Trim a tool name; anything blank lands in `UNKNOWN_TOOL`. */
export function cleanToolName(value: unknown): string {
  if (typeof value !== "string") return UNKNOWN_TOOL
  const name = value.trim()
  return name.length > 0 ? name : UNKNOWN_TOOL
}

/** Coerce to a finite, non-negative integer (defensive against junk). */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/**
 * Enforce the tool bound: beyond `ATTRIBUTION_TOOL_LIMIT` rows the smallest by
 * observed chars are evicted (ties by name, for determinism) and every
 * eviction is counted. A repeat of an evicted tiny tool can be evicted again —
 * the bound keeps the *biggest contributors*, not first-seen rows.
 */
function boundTools(
  tools: Record<string, ToolCounters>,
  dropped: number,
): { tools: Record<string, ToolCounters>; dropped: number } {
  const names = Object.keys(tools)
  if (names.length <= ATTRIBUTION_TOOL_LIMIT) return { tools, dropped }
  const bySize = [...names].sort(
    (a, b) => tools[a].observedChars - tools[b].observedChars || (a < b ? -1 : a > b ? 1 : 0),
  )
  const excess = names.length - ATTRIBUTION_TOOL_LIMIT
  const evict = new Set(bySize.slice(0, excess))
  const next: Record<string, ToolCounters> = {}
  for (const name of names) {
    if (!evict.has(name)) next[name] = tools[name]
  }
  return { tools: next, dropped: dropped + excess }
}

export type RecordInput = {
  tool: string
  observedChars: number
  retainedChars: number
  /** True when parsnip compression shortened this result. */
  compressed?: boolean
  /** True when dedup replaced this result with the marker. */
  deduped?: boolean
}

/**
 * Fold one completed tool call into the ledger. Pure: returns a new ledger
 * with a new tool map. Both sizes are exact lengths as measured in
 * `execute.after` — observed at entry, retained after every parsnip transform
 * (recall note included).
 */
export function recordResult(
  ledger: AttributionLedger,
  input: RecordInput,
  now = Date.now(),
): AttributionLedger {
  const tool = cleanToolName(input.tool)
  const observed = count(input.observedChars)
  const retained = count(input.retainedChars)
  const omitted = Math.max(0, observed - retained)
  const prev = ledger.tools[tool] ?? emptyToolCounters()
  const tools: Record<string, ToolCounters> = {
    ...ledger.tools,
    [tool]: {
      calls: prev.calls + 1,
      nonEmptyResults: prev.nonEmptyResults + (observed > 0 ? 1 : 0),
      observedChars: prev.observedChars + observed,
      retainedChars: prev.retainedChars + retained,
      omittedChars: prev.omittedChars + omitted,
      compressionCount: prev.compressionCount + (input.compressed ? 1 : 0),
      dedupCount: prev.dedupCount + (input.deduped ? 1 : 0),
    },
  }
  const bounded = boundTools(tools, ledger.droppedTools)
  return { tools: bounded.tools, droppedTools: bounded.dropped, updatedAt: now }
}

/** Narrow stored JSON to a ledger, tolerating junk; re-enforces the bound. */
export function asAttributionLedger(value: unknown): AttributionLedger {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyLedger()
  const v = value as Record<string, unknown>
  const raw =
    v.tools && typeof v.tools === "object" && !Array.isArray(v.tools)
      ? (v.tools as Record<string, unknown>)
      : {}
  const tools: Record<string, ToolCounters> = {}
  for (const [name, entry] of Object.entries(raw)) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    tools[cleanToolName(name)] = {
      calls: count(e.calls),
      nonEmptyResults: count(e.nonEmptyResults),
      observedChars: count(e.observedChars),
      retainedChars: count(e.retainedChars),
      omittedChars: count(e.omittedChars),
      compressionCount: count(e.compressionCount),
      dedupCount: count(e.dedupCount),
    }
  }
  const bounded = boundTools(tools, count(v.droppedTools))
  return { tools: bounded.tools, droppedTools: bounded.dropped, updatedAt: count(v.updatedAt) }
}

// --- Request snapshot --------------------------------------------------------

export type SnapshotToolEntry = {
  /** Exact observed tool name, or `UNATTRIBUTED_TOOL` when the part is anonymous. */
  tool: string
  chars: number
}

/** Raw bins extracted from the outgoing request by the caller (`index.ts`). */
export type SnapshotInput = {
  systemChars: number
  userChars: number
  assistantChars: number
  reasoningChars: number
  toolResults: readonly SnapshotToolEntry[]
  /** Tool-catalogue size; the event exposes names, not schemas, so names only. */
  catalogueChars: number
}

export type ContextSnapshot = {
  systemChars: number
  userChars: number
  assistantChars: number
  reasoningChars: number
  toolResults: SnapshotToolEntry[]
  toolTotalChars: number
  toolOverflowCount: number
  toolOverflowChars: number
  catalogueChars: number
  totalChars: number
  updatedAt: number
}

/**
 * Merge a snapshot input into its report shape: duplicate tool rows fold
 * together, rows sort by chars (desc, name asc), and anything past
 * `SNAPSHOT_TOOL_LIMIT` collapses into the overflow figures. Every size is
 * exact observed chars — the snapshot is what the next request will actually
 * carry, including compressed and deduplicated results.
 */
export function buildSnapshot(input: SnapshotInput, now = Date.now()): ContextSnapshot {
  const merged = new Map<string, number>()
  for (const entry of input.toolResults) {
    const chars = count(entry.chars)
    if (chars <= 0) continue
    const tool = cleanToolName(entry.tool)
    merged.set(tool, (merged.get(tool) ?? 0) + chars)
  }
  const sorted = [...merged.entries()].sort(
    (a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0),
  )
  const toolTotalChars = sorted.reduce((sum, [, chars]) => sum + chars, 0)
  const kept = sorted.slice(0, SNAPSHOT_TOOL_LIMIT)
  const overflow = sorted.slice(SNAPSHOT_TOOL_LIMIT)
  const toolOverflowChars = overflow.reduce((sum, [, chars]) => sum + chars, 0)
  const systemChars = count(input.systemChars)
  const userChars = count(input.userChars)
  const assistantChars = count(input.assistantChars)
  const reasoningChars = count(input.reasoningChars)
  const catalogueChars = count(input.catalogueChars)
  return {
    systemChars,
    userChars,
    assistantChars,
    reasoningChars,
    toolResults: kept.map(([tool, chars]) => ({ tool, chars })),
    toolTotalChars,
    toolOverflowCount: overflow.length,
    toolOverflowChars,
    catalogueChars,
    totalChars:
      systemChars + userChars + assistantChars + reasoningChars + toolTotalChars + catalogueChars,
    updatedAt: now,
  }
}

// --- Report ------------------------------------------------------------------

/**
 * Everything the formatter consumes. Undefined means "not requested for this
 * report" (the section is skipped); null means "requested, nothing captured
 * yet" (the section says so explicitly). `usage` is the only authoritative
 * block; snapshot and ledger are estimates/exact-observed respectively.
 */
export type AttributionReport = {
  snapshot?: ContextSnapshot | null
  ledger?: AttributionLedger
  usage?: TokenUsageState | null
}

export type ReportOptions = {
  /** Top rows shown per list; clamped to 1–50. */
  topN?: number
  /** Session calibration; when absent the fallback ratio is used. */
  calibration?: CalibrationSummary | null
}

/**
 * Fallback chars-per-token ratio, measured on this install 2026-10-08
 * (`npm run calibrate`: 3.47 weighted across 11,751 request pairs; 3.61 for
 * additions >= 2000 chars). Sessions override it live once they have paired
 * snapshot→usage data. Always render the result with `~`.
 */
export const FALLBACK_CHARS_PER_TOKEN = 3.5

/**
 * Estimate tokens from an exact char count at the given ratio. Same labelled
 * heuristic as `quality.ts#estimateTokens` (which stays at chars/4 for the
 * occupancy reading only); kept local because the input here is a count, not
 * text.
 */
export function estimatedTokensOf(chars: number, charsPerToken = FALLBACK_CHARS_PER_TOKEN): number {
  const n = count(chars)
  const ratio =
    typeof charsPerToken === "number" && Number.isFinite(charsPerToken) && charsPerToken > 0
      ? charsPerToken
      : FALLBACK_CHARS_PER_TOKEN
  return n === 0 ? 0 : Math.ceil(n / ratio)
}

const fmtInt = (value: number): string => value.toLocaleString("en-US")

const fmtTok = (chars: number, charsPerToken: number): string =>
  `~${fmtInt(estimatedTokensOf(chars, charsPerToken))} tok`

const share = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a"

const money = (value: number): string =>
  `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`

const clip = (name: string, max = 28): string => (name.length <= max ? name : `${name.slice(0, max - 1)}…`)

function snapshotLines(snapshot: ContextSnapshot, topN: number, charsPerToken: number): string[] {
  const lines: string[] = ["Current request (last outgoing context) — estimated"]
  const row = (label: string, chars: number, pct?: string): string =>
    `  ${label.padEnd(16)}${fmtTok(chars, charsPerToken).padStart(12)}${pct ? `   ${pct}` : ""}`
  const base = snapshot.totalChars
  lines.push(row("system", snapshot.systemChars, share(snapshot.systemChars, base)))
  lines.push(row("user", snapshot.userChars, share(snapshot.userChars, base)))
  lines.push(row("assistant", snapshot.assistantChars, share(snapshot.assistantChars, base)))
  lines.push(row("reasoning", snapshot.reasoningChars, share(snapshot.reasoningChars, base)))
  lines.push(row("tool results", snapshot.toolTotalChars, share(snapshot.toolTotalChars, base)))
  const shown = snapshot.toolResults.slice(0, topN)
  for (const entry of shown) {
    lines.push(`    ${clip(entry.tool, 18).padEnd(18)}${fmtTok(entry.chars, charsPerToken).padStart(12)}`)
  }
  const hiddenKept = snapshot.toolResults.slice(topN)
  const hiddenChars =
    hiddenKept.reduce((sum, entry) => sum + entry.chars, 0) + snapshot.toolOverflowChars
  const hiddenCount = hiddenKept.length + snapshot.toolOverflowCount
  if (hiddenCount > 0) {
    lines.push(`    … ${hiddenCount} more tool row(s) (${fmtTok(hiddenChars, charsPerToken)})`)
  }
  lines.push(row("tool catalogue", snapshot.catalogueChars, share(snapshot.catalogueChars, base)))
  lines.push(row("total", snapshot.totalChars))
  return lines
}

function ledgerLines(ledger: AttributionLedger | undefined, topN: number): string[] {
  if (!ledger) return []
  const lines: string[] = [
    "Session tool ledger (observed chars, exact — counters only, no text stored)",
  ]
  const names = Object.keys(ledger.tools)
  if (names.length === 0) {
    lines.push("  no completed tool calls observed yet.")
    if (ledger.droppedTools > 0) {
      lines.push(`  ${ledger.droppedTools} tool row(s) evicted by the retention bound.`)
    }
    return lines
  }
  const sorted = [...names].sort(
    (a, b) =>
      ledger.tools[b].observedChars - ledger.tools[a].observedChars ||
      (a < b ? -1 : a > b ? 1 : 0),
  )
  const shown = sorted.slice(0, topN)
  const totalObserved = sorted.reduce((sum, name) => sum + ledger.tools[name].observedChars, 0)
  const nameW = Math.min(28, Math.max(8, ...shown.map((name) => clip(name).length), "total".length))
  const header =
    `  ${"tool".padEnd(nameW)}${"calls".padStart(6)}${"observed".padStart(10)}` +
    `${"kept".padStart(10)}${"omitted".padStart(10)}${"cmp".padStart(4)}` +
    `${"dup".padStart(4)}${"share".padStart(8)}`
  lines.push(header)
  const row = (name: string, t: ToolCounters): string =>
    `  ${clip(name, nameW).padEnd(nameW)}${String(t.calls).padStart(6)}` +
    `${fmtInt(t.observedChars).padStart(10)}${fmtInt(t.retainedChars).padStart(10)}` +
    `${fmtInt(t.omittedChars).padStart(10)}${String(t.compressionCount).padStart(4)}` +
    `${String(t.dedupCount).padStart(4)}${share(t.observedChars, totalObserved).padStart(8)}`
  for (const name of shown) lines.push(row(name, ledger.tools[name]))
  if (sorted.length > shown.length) {
    lines.push(`  … ${sorted.length - shown.length} more tool(s) (raise topN to widen the list).`)
  }
  const totals = sorted.reduce(
    (acc, name) => {
      const t = ledger.tools[name]
      return {
        calls: acc.calls + t.calls,
        observed: acc.observed + t.observedChars,
        kept: acc.kept + t.retainedChars,
        omitted: acc.omitted + t.omittedChars,
        cmp: acc.cmp + t.compressionCount,
        dup: acc.dup + t.dedupCount,
      }
    },
    { calls: 0, observed: 0, kept: 0, omitted: 0, cmp: 0, dup: 0 },
  )
  lines.push(
    `  ${"total".padEnd(nameW)}${String(totals.calls).padStart(6)}` +
      `${fmtInt(totals.observed).padStart(10)}${fmtInt(totals.kept).padStart(10)}` +
      `${fmtInt(totals.omitted).padStart(10)}${String(totals.cmp).padStart(4)}` +
      `${String(totals.dup).padStart(4)}${"100.0%".padStart(8)}`,
  )
  if (ledger.droppedTools > 0) {
    lines.push(`  ${ledger.droppedTools} tool row(s) evicted by the retention bound.`)
  }
  return lines
}

function usageLines(usage: TokenUsageState): string[] {
  const lines: string[] = [
    "Provider totals (session, authoritative — from session.usage.updated)",
    `  input ${fmtInt(usage.input)} · output ${fmtInt(usage.output)} · reasoning ${fmtInt(usage.reasoning)}`,
    `  cache read ${fmtInt(usage.cacheRead)} · cache write ${fmtInt(usage.cacheWrite)}`,
  ]
  const prompt = usage.input + usage.cacheRead + usage.cacheWrite
  const parts: string[] = []
  if (prompt > 0) parts.push(`cache hit rate ${share(usage.cacheRead, prompt)}`)
  if (typeof usage.cost === "number" && Number.isFinite(usage.cost)) parts.push(`cost ${money(usage.cost)}`)
  if (parts.length > 0) lines.push(`  ${parts.join(" · ")}`)
  return lines
}

/**
 * Render the report. Sections appear only when requested (see
 * `AttributionReport`); empty states are explicit, never silently blank.
 */
export function formatAttributionReport(
  report: AttributionReport,
  options: ReportOptions = {},
): string {
  const requested = options.topN
  const topN =
    typeof requested === "number" && Number.isFinite(requested)
      ? Math.min(50, Math.max(1, Math.floor(requested)))
      : DEFAULT_TOP_N

  const calibration = options.calibration ?? null
  const charsPerToken = calibration?.ratio ?? FALLBACK_CHARS_PER_TOKEN
  const estimateLabel = calibration
    ? `~ tokens calibrated on this session (${calibration.ratio.toFixed(2)} chars/token over ${calibration.pairs} requests)`
    : `~ tokens at ${FALLBACK_CHARS_PER_TOKEN} chars/token (uncalibrated — install-measured fallback)`

  const lines: string[] = [
    `Context attribution — exact chars (observed), ${estimateLabel}, authoritative provider totals.`,
  ]
  const section = (block: string[]): void => {
    if (block.length === 0) return
    lines.push("", ...block)
  }

  if (report.snapshot === undefined) {
    // not requested for this scope — omit silently
  } else if (report.snapshot === null) {
    section(["Current request: no snapshot captured yet — it starts with the next outgoing request."])
  } else {
    section(snapshotLines(report.snapshot, topN, charsPerToken))
  }

  section(ledgerLines(report.ledger, topN))

  if (report.usage === undefined) {
    // not requested — omit
  } else if (report.usage === null) {
    section(["Provider totals: no session.usage.updated recorded for this session yet."])
  } else {
    section(usageLines(report.usage))
  }

  if (lines.length === 1) lines.push("", "No attribution data captured yet.")
  return lines.join("\n")
}

// --- Storage (session-scoped) ------------------------------------------------

/** Stable storage key for a session's per-tool attribution ledger. */
export const attributionKey = (sessionID: string): string => `session:${sessionID}:attribution`

/** Load a session's ledger; absent or malformed records narrow to empty. */
export async function loadAttribution(
  storage: StorageDomain,
  sessionID: string,
): Promise<AttributionLedger> {
  return asAttributionLedger(await storage.get(attributionKey(sessionID)))
}

export async function saveAttribution(
  storage: StorageDomain,
  sessionID: string,
  ledger: AttributionLedger,
): Promise<void> {
  await storage.set(
    attributionKey(sessionID),
    ledger as unknown as Parameters<StorageDomain["set"]>[1],
  )
}

// --- Capture helpers ---------------------------------------------------------
//
// `recordAttribution` is called from `execute.after` for every completed tool
// call. Load -> fold -> save is not atomic and hooks for one session can run
// concurrently (parallel tool calls land together), so writes serialize
// through a per-session promise chain instead of racing.

/**
 * Serialize async read-modify-write work per key: one promise chain per key,
 * so concurrent tool hooks for the same session cannot clobber each other's
 * ledger updates. The chain entry is removed once it drains, and a rejected
 * task reaches its caller without breaking the chain.
 */
export function enqueue<T>(
  chains: Map<string, Promise<void>>,
  key: string,
  work: () => Promise<T>,
): Promise<T> {
  const previous = chains.get(key) ?? Promise.resolve()
  const run = previous.then(work)
  const tail = run.then(
    () => undefined,
    () => undefined,
  )
  chains.set(key, tail)
  void tail.then(() => {
    if (chains.get(key) === tail) chains.delete(key)
  })
  return run
}

/** One completed call as the capture site sees it. */
export type CaptureInput = {
  sessionID: string
  tool: string
  observedChars: number
  retainedChars: number
  compressed?: boolean
  deduped?: boolean
}

/**
 * Fold one completed tool call into a session's ledger. Counters only — no
 * tool text. Failures stay with the caller (the hook logs and swallows them).
 */
export async function recordAttribution(
  storage: StorageDomain,
  chains: Map<string, Promise<void>>,
  input: CaptureInput,
): Promise<void> {
  await enqueue(chains, input.sessionID, async () => {
    const ledger = await loadAttribution(storage, input.sessionID)
    const next = recordResult(ledger, {
      tool: input.tool,
      observedChars: input.observedChars,
      retainedChars: input.retainedChars,
      compressed: input.compressed,
      deduped: input.deduped,
    })
    await saveAttribution(storage, input.sessionID, next)
  })
}

// --- Request snapshot --------------------------------------------------------
//
// `snapshotInputFromContext` classifies one outgoing request (the `context`
// hook's event) into the bins `buildSnapshot` expects. The vocabulary is
// pinned to the installed `@opencode/ai` schema
// (`dist/schema/messages.d.ts`): messages are
// `{ role: "system" | "user" | "assistant" | "tool", content: ContentPart[] }`
// and content parts are tagged by `type` — `text`, `reasoning`, `tool-call`,
// `tool-result` (which carries `name`), `media`, `compaction`, `effort`.
//
// Classification rules (see NOTES.md "Context attribution"):
//  - text parts bucket by message role; unknown roles are skipped.
//  - reasoning parts are their own bucket.
//  - tool-result parts bucket by their `name`; a missing name lands in
//    `UNATTRIBUTED_TOOL`.
//  - tool-call arguments and `effort` parts are skipped: the categories count
//    what their labels say, nothing else.
//  - media parts count as the `[media]` placeholder; file entries inside a
//    `content`-type result count as `[file]`.
//  - `compaction` parts (summaries carried in history) count as assistant text.

const MEDIA_PLACEHOLDER = "[media]"
const FILE_PLACEHOLDER = "[file]"

/** Text of a text-bearing part; "" for anything else. */
function textOfPart(value: unknown): string {
  if (typeof value === "string") return value
  if (!value || typeof value !== "object") return ""
  const part = value as Record<string, unknown>
  return typeof part.text === "string" ? part.text : ""
}

/** Exact chars of a tool-result part's `result` value, by result kind. */
function toolResultChars(result: unknown): number {
  if (!result || typeof result !== "object") return 0
  const r = result as Record<string, unknown>
  const value = r.value
  if (r.type === "content" && Array.isArray(value)) {
    let sum = 0
    for (const item of value) {
      if (!item || typeof item !== "object") continue
      const entry = item as Record<string, unknown>
      if (entry.type === "text" && typeof entry.text === "string") sum += entry.text.length
      else if (entry.type === "file") sum += FILE_PLACEHOLDER.length
    }
    return sum
  }
  if (typeof value === "string") return value.length
  if (value === undefined) return 0
  return safeJson(value).length
}

export type ContextLike = {
  system?: readonly unknown[]
  messages?: readonly unknown[]
  tools?: Record<string, unknown>
}

/**
 * Classify an outgoing request into the snapshot bins. Read-only and
 * tolerant: unrecognised shapes contribute nothing rather than throwing.
 */
export function snapshotInputFromContext(input: ContextLike): SnapshotInput {
  let systemChars = 0
  for (const part of input.system ?? []) {
    systemChars += textOfPart(part).length
  }

  let userChars = 0
  let assistantChars = 0
  let reasoningChars = 0
  const toolResults: SnapshotToolEntry[] = []

  for (const message of input.messages ?? []) {
    if (!message || typeof message !== "object") continue
    const m = message as Record<string, unknown>
    const role = typeof m.role === "string" ? m.role : ""
    const content = Array.isArray(m.content) ? m.content : []
    for (const part of content) {
      if (!part || typeof part !== "object") continue
      const p = part as Record<string, unknown>
      const type = typeof p.type === "string" ? p.type : ""
      if (type === "text" || type === "media") {
        const chars = type === "text" ? textOfPart(p).length : MEDIA_PLACEHOLDER.length
        if (role === "user") userChars += chars
        else if (role === "assistant") assistantChars += chars
        else if (role === "tool") toolResults.push({ tool: UNATTRIBUTED_TOOL, chars })
        else if (role === "system") systemChars += chars
      } else if (type === "reasoning") {
        reasoningChars += textOfPart(p).length
      } else if (type === "tool-result") {
        toolResults.push({
          tool: typeof p.name === "string" ? p.name : UNATTRIBUTED_TOOL,
          chars: toolResultChars(p.result),
        })
      } else if (type === "compaction") {
        assistantChars += textOfPart(p).length
      }
      // tool-call arguments and `effort` parts are deliberately not counted.
    }
  }

  return {
    systemChars,
    userChars,
    assistantChars,
    reasoningChars,
    toolResults,
    catalogueChars: input.tools ? safeJson(input.tools).length : 0,
  }
}

// --- Snapshot storage (session-scoped) ---------------------------------------

/** Stable storage key for a session's latest request snapshot. */
export const snapshotKey = (sessionID: string): string => `session:${sessionID}:snapshot`

/** Narrow stored JSON to a snapshot, tolerating junk; undefined when unusable. */
export function asContextSnapshot(value: unknown): ContextSnapshot | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  const rawTools = Array.isArray(v.toolResults) ? v.toolResults : []
  const toolResults: SnapshotToolEntry[] = []
  for (const entry of rawTools) {
    if (!entry || typeof entry !== "object" || Array.isArray(entry)) continue
    const e = entry as Record<string, unknown>
    const chars = count(e.chars)
    if (chars <= 0) continue
    const tool = typeof e.tool === "string" && e.tool.trim().length > 0 ? e.tool.trim() : UNATTRIBUTED_TOOL
    toolResults.push({ tool, chars })
  }
  return {
    systemChars: count(v.systemChars),
    userChars: count(v.userChars),
    assistantChars: count(v.assistantChars),
    reasoningChars: count(v.reasoningChars),
    toolResults,
    toolTotalChars: count(v.toolTotalChars),
    toolOverflowCount: count(v.toolOverflowCount),
    toolOverflowChars: count(v.toolOverflowChars),
    catalogueChars: count(v.catalogueChars),
    totalChars: count(v.totalChars),
    updatedAt: count(v.updatedAt),
  }
}

export async function loadSnapshot(
  storage: StorageDomain,
  sessionID: string,
): Promise<ContextSnapshot | undefined> {
  return asContextSnapshot(await storage.get(snapshotKey(sessionID)))
}

export async function saveSnapshot(
  storage: StorageDomain,
  sessionID: string,
  snapshot: ContextSnapshot,
): Promise<void> {
  await storage.set(snapshotKey(sessionID), snapshot as unknown as Parameters<StorageDomain["set"]>[1])
}

// --- Calibration --------------------------------------------------------------
//
// The `~` token figures divide observed chars by a chars-per-token ratio. The
// fallback ratio is install-measured (`npm run calibrate`, 2026-10-08: 3.47
// weighted / 3.61 on large additions across 11,751 request pairs), but a
// session can measure its own: every primary request fires the `context` hook
// (chars about to be sent) and then `session.usage.updated` (the provider's
// cumulative prompt count). The delta between two usage readings is that
// request's prompt size — the reading is cumulative, so the delta between two
// readings IS that request's full prompt tokens. Pairing it with the request's
// full snapshot chars yields `chars / promptTokens` for the content mix
// actually sent.
//
// Pairing is conservative: a usage update only pairs when a fresh snapshot is
// pending (title/compaction requests fire usage without a context snapshot and
// are skipped — their readings still advance the baseline, so the next delta
// stays clean), and the pending snapshot expires so a lost update cannot pair
// with a later request. `calibrationRatio` returns null until enough pairs and
// tokens exist, or when the ratio is outside a sane range.

export type CalibrationState = {
  /** Chars of the requests that were paired (full snapshot totals). */
  charsSent: number
  /** Provider prompt tokens (input + cache read + cache write) for those pairs. */
  promptTokens: number
  /** Completed snapshot→usage pairs. */
  pairs: number
  /** Chars of the request awaiting its usage update; null once consumed. */
  pendingChars: number | null
  /** When the pending snapshot was taken (freshness guard). */
  pendingAt: number
  /** Last cumulative prompt reading, for deltas. */
  lastPromptTokens: number | null
  updatedAt: number
}

export type CalibrationSummary = {
  ratio: number
  pairs: number
  promptTokens: number
}

/** Below these, a session ratio is too thin to show. */
export const CALIBRATION_MIN_PAIRS = 3
export const CALIBRATION_MIN_TOKENS = 10_000
/** A pending snapshot older than this cannot pair (a lost usage update). */
export const CALIBRATION_PENDING_MAX_AGE_MS = 10 * 60_000
/** Outside this range the data is anomalous; stay uncalibrated. */
export const CALIBRATION_MIN_RATIO = 2
export const CALIBRATION_MAX_RATIO = 6

export function emptyCalibration(now = Date.now()): CalibrationState {
  return {
    charsSent: 0,
    promptTokens: 0,
    pairs: 0,
    pendingChars: null,
    pendingAt: 0,
    lastPromptTokens: null,
    updatedAt: now,
  }
}

/** Narrow stored JSON to a calibration record, tolerating junk. */
export function asCalibration(value: unknown): CalibrationState {
  if (!value || typeof value !== "object" || Array.isArray(value)) return emptyCalibration()
  const v = value as Record<string, unknown>
  const pending =
    typeof v.pendingChars === "number" && Number.isFinite(v.pendingChars) && v.pendingChars > 0
      ? Math.floor(v.pendingChars)
      : null
  const lastPrompt =
    typeof v.lastPromptTokens === "number" && Number.isFinite(v.lastPromptTokens)
      ? Math.floor(v.lastPromptTokens)
      : null
  return {
    charsSent: count(v.charsSent),
    promptTokens: count(v.promptTokens),
    pairs: count(v.pairs),
    pendingChars: pending,
    pendingAt: count(v.pendingAt),
    lastPromptTokens: lastPrompt,
    updatedAt: count(v.updatedAt),
  }
}

/** Record the chars of the request about to be sent (context hook). */
export function noteSnapshot(cal: CalibrationState, chars: number, now = Date.now()): CalibrationState {
  return { ...cal, pendingChars: count(chars), pendingAt: now, updatedAt: now }
}

/**
 * Record a usage reading (cumulative prompt tokens). The delta against the
 * previous reading is the request's full prompt, so it pairs with the full
 * pending snapshot chars; always refreshes the delta baseline.
 */
export function noteUsage(cal: CalibrationState, promptTokens: number, now = Date.now()): CalibrationState {
  const prompt = count(promptTokens)
  const last = cal.lastPromptTokens
  const delta = last !== null && prompt > last ? prompt - last : 0
  const pending = cal.pendingChars
  const fresh =
    pending !== null && pending > 0 && now - cal.pendingAt <= CALIBRATION_PENDING_MAX_AGE_MS
  const paired = fresh && delta > 0
  return {
    charsSent: cal.charsSent + (paired ? (pending ?? 0) : 0),
    promptTokens: cal.promptTokens + (paired ? delta : 0),
    pairs: cal.pairs + (paired ? 1 : 0),
    pendingChars: null,
    pendingAt: cal.pendingAt,
    lastPromptTokens: prompt,
    updatedAt: now,
  }
}

/** The session's measured ratio, or null when the data is too thin or absurd. */
export function calibrationRatio(cal: CalibrationState): number | null {
  if (cal.pairs < CALIBRATION_MIN_PAIRS) return null
  if (cal.promptTokens < CALIBRATION_MIN_TOKENS) return null
  if (cal.charsSent <= 0) return null
  const ratio = cal.charsSent / cal.promptTokens
  if (!Number.isFinite(ratio) || ratio < CALIBRATION_MIN_RATIO || ratio > CALIBRATION_MAX_RATIO) {
    return null
  }
  return ratio
}

/** The summary the formatter consumes; null when uncalibrated. */
export function calibrationSummary(cal: CalibrationState): CalibrationSummary | null {
  const ratio = calibrationRatio(cal)
  if (ratio === null) return null
  return { ratio, pairs: cal.pairs, promptTokens: cal.promptTokens }
}

// --- Calibration storage (session-scoped) -------------------------------------

/** Stable storage key for a session's chars-per-token calibration. */
export const calibrationKey = (sessionID: string): string => `session:${sessionID}:calibration`

export async function loadCalibration(
  storage: StorageDomain,
  sessionID: string,
): Promise<CalibrationState> {
  return asCalibration(await storage.get(calibrationKey(sessionID)))
}

export async function saveCalibration(
  storage: StorageDomain,
  sessionID: string,
  calibration: CalibrationState,
): Promise<void> {
  await storage.set(
    calibrationKey(sessionID),
    calibration as unknown as Parameters<StorageDomain["set"]>[1],
  )
}
