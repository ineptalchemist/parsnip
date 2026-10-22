/**
 * Read actual token cost out of OpenCode's message history.
 *
 * The dollar figure on the invoice is derived from four billable buckets per
 * request — fresh input, cached read, cached write, and output+reasoning —
 * priced per 1M tokens, with two adjustments: DeepSeek's peak hours (exactly
 * 2x, 01:00-04:00 and 06:00-10:00 UTC on weekdays) and the context-size
 * tiers some models charge above a threshold. The formula and the rate table
 * live in `bench/lib/cost.ts` (pure, unit-tested); this script stays a thin
 * database reader.
 *
 * It reports three columns per model, and the gap between them is the point:
 *
 *  - COMPUTED — the formula with peak multipliers applied. The closest thing
 *    here to an invoice.
 *  - OFF-PEAK — the same formula with every request held at its base rate.
 *  - RECORDED — the `cost` OpenCode itself wrote on each message.
 *
 * RECORDED should equal OFF-PEAK. It does, for every OpenCode Go model: the
 * recorded cost is an off-peak computation and never applies the peak
 * multiplier, so it UNDERSTATES the DeepSeek bill. Recorded cost is a
 * cross-check, not an oracle.
 *
 * Models with no rate in the table are reported as unpriced rather than
 * dropped — a total that silently omits traffic is worse than one that admits
 * a gap. OpenCode's Zen models and local Ollama models are free by
 * construction; their tokens still count toward context pressure, never
 * toward a bill.
 *
 * Data source: `session_message` rows where `type='assistant'`, each
 * carrying `tokens.{input,output,reasoning,cache.read,cache.write}`,
 * `model.{providerID,id}`, `time.created` and `cost`. The older `message`
 * table holds only the pre-migration sessions and is deliberately not read.
 *
 * Usage:
 *   npm run cost                  # default DB (OpenCode's opencode.db)
 *   node bench/cost.ts /path/to/opencode.db
 */

import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

import { aggregate, type MessageUsage } from "./lib/cost.ts"

const defaultDb = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const dbPath = process.argv[2] ?? defaultDb

type AssistantRow = { time_created: number; data: string }

/** Narrow a stored token count to a finite non-negative number. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) && value > 0 ? value : 0
}

/**
 * One assistant message row -> the usage the cost formula needs. A row
 * without tokens (a synthetic or failed message) yields `undefined` and is
 * skipped rather than counted as a free request.
 */
function toUsage(row: AssistantRow): MessageUsage | undefined {
  let parsed: Record<string, unknown>
  try {
    parsed = JSON.parse(row.data) as Record<string, unknown>
  } catch {
    return undefined
  }
  const tokens = parsed.tokens as Record<string, unknown> | undefined
  if (!tokens || typeof tokens !== "object") return undefined
  const cache = (tokens.cache as Record<string, unknown> | undefined) ?? {}
  const model = parsed.model as Record<string, unknown> | undefined
  if (!model) return undefined
  const at = (parsed.time as Record<string, unknown> | undefined)?.created
  return {
    provider: String(model.providerID ?? ""),
    model: String(model.id ?? ""),
    at: typeof at === "number" ? at : row.time_created,
    input: num(tokens.input),
    output: num(tokens.output),
    reasoning: num(tokens.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
    recordedCost: num(parsed.cost),
  }
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare("SELECT time_created, data FROM session_message WHERE type = ? ORDER BY time_created")
  .all("assistant") as AssistantRow[]
db.close()

const uses: MessageUsage[] = []
for (const row of rows) {
  const use = toUsage(row)
  if (use) uses.push(use)
}

if (uses.length === 0) {
  console.log("no assistant messages with token counts found")
  process.exit(0)
}

const totals = aggregate(uses)
const usd = (n: number): string => `$${n.toFixed(2)}`
const num0 = (n: number): string => n.toLocaleString("en-US", { maximumFractionDigits: 0 })

console.log(
  `Actual token cost, computed from ${num0(uses.length)} assistant requests ` +
    `(read from ${dbPath}).\n`,
)
console.log(
  `${"model".padEnd(44)} ${"reqs".padStart(6)} ${"computed".padStart(10)} ` +
    `${"off-peak".padStart(10)} ${"recorded".padStart(10)} ${"rec/comp".padStart(9)}`,
)

for (const row of totals.models) {
  if (row.computed < 0.005 && row.recorded < 0.005) continue
  const ratio = row.computed > 0.0005 ? `${(row.recorded / row.computed).toFixed(2)}x` : "n/a"
  const label = row.approximate ? `${row.key} (approx)` : row.key
  console.log(
    `${label.padEnd(44)} ${num0(row.requests).padStart(6)} ${usd(row.computed).padStart(10)} ` +
      `${usd(row.offPeak).padStart(10)} ${usd(row.recorded).padStart(10)} ${ratio.padStart(9)}`,
  )
  if (row.peakRequests > 0) {
    const share = ((row.peakRequests / row.requests) * 100).toFixed(1)
    console.log(
      `${" ".repeat(44)} ${num0(row.peakRequests)} requests in a peak window (${share}%)`,
    )
  }
}

console.log(
  `\ntotal: computed ${usd(totals.computed)}  off-peak ${usd(totals.offPeak)}  ` +
    `recorded ${usd(totals.recorded)}`,
)

const tokenTotal = totals.models.reduce(
  (sum, row) =>
    sum + row.input + row.cacheRead + row.cacheWrite + row.output + row.reasoning,
  0,
)
const cachedTokens = totals.models.reduce((sum, row) => sum + row.cacheRead, 0)
if (tokenTotal > 0 && totals.computed > 0) {
  console.log(
    `cached read is ${((cachedTokens / tokenTotal) * 100).toFixed(1)}% of all tokens ` +
      `but only ${((totals.cachedCost / totals.computed) * 100).toFixed(1)}% of the bill`,
  )
}

if (totals.unpriced.length > 0) {
  console.log(
    `\nunpriced (no rate in the table; their tokens are excluded from the computed total):`,
  )
  for (const key of totals.unpriced) {
    const row = totals.models.find((m) => m.key === key)
    console.log(`  ${key.padEnd(44)} ${num0(row?.requests ?? 0)} requests`)
  }
  console.log(
    `  ${num0(totals.unpricedTokens)} tokens unpriced — check the rate table in bench/lib/cost.ts`,
  )
}
