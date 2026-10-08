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
 *  - Every token figure is an ESTIMATE (`chars / 4`) and must render with `~`.
 *  - Provider usage (`session.usage.updated`, `TokenUsageState`) is the only
 *    authoritative token data and is never mixed into the estimates.
 *
 * Counters only — no tool text is stored anywhere here. The logic is pure and
 * carries no runtime dependency: the storage helpers take the domain as a
 * parameter and every import is type-only, so the whole surface is
 * unit-testable under `node --test`.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"
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
}

/**
 * Estimate tokens from an exact char count: `chars / 4`. Same labelled
 * heuristic as `quality.ts#estimateTokens`, kept local because the input here
 * is a count, not text. Always render the result with `~`.
 */
export function estimatedTokensOf(chars: number): number {
  const n = count(chars)
  return n === 0 ? 0 : Math.ceil(n / 4)
}

const fmtInt = (value: number): string => value.toLocaleString("en-US")

const fmtTok = (chars: number): string => `~${fmtInt(estimatedTokensOf(chars))} tok`

const share = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a"

const money = (value: number): string =>
  `$${value.toFixed(6).replace(/0+$/, "").replace(/\.$/, "")}`

const clip = (name: string, max = 28): string => (name.length <= max ? name : `${name.slice(0, max - 1)}…`)

function snapshotLines(snapshot: ContextSnapshot, topN: number): string[] {
  const lines: string[] = ["Current request (last outgoing context) — estimated"]
  const row = (label: string, chars: number, pct?: string): string =>
    `  ${label.padEnd(16)}${fmtTok(chars).padStart(12)}${pct ? `   ${pct}` : ""}`
  const base = snapshot.totalChars
  lines.push(row("system", snapshot.systemChars, share(snapshot.systemChars, base)))
  lines.push(row("user", snapshot.userChars, share(snapshot.userChars, base)))
  lines.push(row("assistant", snapshot.assistantChars, share(snapshot.assistantChars, base)))
  lines.push(row("reasoning", snapshot.reasoningChars, share(snapshot.reasoningChars, base)))
  lines.push(row("tool results", snapshot.toolTotalChars, share(snapshot.toolTotalChars, base)))
  const shown = snapshot.toolResults.slice(0, topN)
  for (const entry of shown) {
    lines.push(`    ${clip(entry.tool, 18).padEnd(18)}${fmtTok(entry.chars).padStart(12)}`)
  }
  const hiddenKept = snapshot.toolResults.slice(topN)
  const hiddenChars =
    hiddenKept.reduce((sum, entry) => sum + entry.chars, 0) + snapshot.toolOverflowChars
  const hiddenCount = hiddenKept.length + snapshot.toolOverflowCount
  if (hiddenCount > 0) {
    lines.push(`    … ${hiddenCount} more tool row(s) (${fmtTok(hiddenChars)})`)
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

  const lines: string[] = [
    "Context attribution — exact chars (observed), ~ tokens (chars/4 estimates), authoritative provider totals.",
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
    section(snapshotLines(report.snapshot, topN))
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
