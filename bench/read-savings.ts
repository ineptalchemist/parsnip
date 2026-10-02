/**
 * Read ctx-guard's per-session measurements out of OpenCode's plugin storage.
 *
 * Two ledgers are shown, and they measure DIFFERENT things:
 *  - tokens: REAL provider usage from the `session.usage.updated` event
 *    (cumulative per session). `cache read` is the cache-preservation signal:
 *    a high cacheRead/input ratio means the live prefix was not invalidated.
 *  - chars: exact characters removed by ctx-guard's tool-output compression and
 *    dedup. This is prompt-growth reduction, NOT tokens — it is never converted
 *    to a token count (the old `chars / 4` figure was an uncalibrated guess).
 *
 * Two figures are reported for the chars ledger, and the gap between them is the
 * point of this script:
 *  - STATIC  — characters removed from the transcript once.
 *  - REREAD  — characters that were then never re-transmitted, because every
 *    later model call re-sends the whole prompt and the prompt is now shorter.
 *    A compression made early in a session is therefore worth many times one
 *    made at the end, and the static figure alone understates the effect by the
 *    average number of later calls. Both stay in chars; the multiplier between
 *    them is a dimensionless ratio, so no chars-to-tokens guess enters here.
 *
 * The reread figure needs two extra inputs the static ledger does not keep:
 * per-compression timestamps (`session:<id>:compressions`) and the session's
 * assistant-message timeline (`session_message`). Dedup has no per-event log —
 * only the aggregate in `savings` — so its contribution is reported as static
 * only, and the reread line covers compression.
 *
 * OpenCode backs plugin storage by the `kv` table in `opencode.db`; keys are
 * namespaced `plugin:<utf16-hex(id)>:...`. Plugin console output does NOT reach
 * opencode.log, so this read-only query is the measurement surface.
 *
 * Usage:
 *   npm run savings                 # default DB (OpenCode's opencode.db)
 *   node bench/read-savings.ts /path/to/opencode.db
 */

import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"
import {
  isCompressionEvent,
  rereadFor,
  toolInvocations,
  type AssistantEvent,
  type CompressionEvent,
} from "./lib/reread.ts"

const defaultDb = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const dbPath = process.argv[2] ?? defaultDb

type SelectorTally = {
  compressions: number
  charsOmitted: number
  charsKept?: number
}

type CharLedger = {
  compressions: number
  charsOmitted: number
  dedups: number
  charsDeduped: number
  bySelector?: Record<string, SelectorTally>
}

type TokenUsage = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  cost?: number
  updatedAt: number
}

/**
 * The reread multiplier lives in `bench/lib/reread.ts` (pure, unit-tested), so
 * this script stays a thin database reader. Its inputs are the compression
 * events in `session:<id>:compressions` and the session's assistant-message
 * timeline in `session_message`; dedup has no per-event log, so its contribution
 * is reported as static only.
 */

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare("SELECT key, value FROM kv WHERE key LIKE ? OR key LIKE ? OR key LIKE ? ORDER BY key")
  .all("%:savings", "%:usage", "%:compressions") as Array<{ key: string; value: string }>

const messages = db
  .prepare(
    "SELECT session_id, time_created, data FROM session_message WHERE type = ? ORDER BY seq",
  )
  .all("assistant") as Array<{ session_id: string; time_created: number; data: string }>
db.close()

const chars = new Map<string, CharLedger>()
const tokens = new Map<string, TokenUsage>()
const events = new Map<string, CompressionEvent[]>()
const timeline = new Map<string, AssistantEvent[]>()

for (const row of rows) {
  const savings = row.key.match(/session:([^:]+):savings$/)
  if (savings) {
    try {
      chars.set(savings[1], JSON.parse(row.value) as CharLedger)
    } catch {
      // Ignore malformed records.
    }
    continue
  }
  const usage = row.key.match(/session:([^:]+):usage$/)
  if (usage) {
    try {
      tokens.set(usage[1], JSON.parse(row.value) as TokenUsage)
    } catch {
      // Ignore malformed records.
    }
    continue
  }
  const compression = row.key.match(/session:([^:]+):compressions$/)
  if (compression) {
    try {
      const parsed = JSON.parse(row.value) as unknown
      if (Array.isArray(parsed)) {
        const kept = parsed.filter(isCompressionEvent)
        if (kept.length > 0) events.set(compression[1], kept)
      }
    } catch {
      // Ignore malformed records.
    }
  }
}

for (const msg of messages) {
  const list = timeline.get(msg.session_id) ?? []
  list.push({ at: msg.time_created, invocations: toolInvocations(msg.data) })
  timeline.set(msg.session_id, list)
}

const sessions = [...new Set([...tokens.keys(), ...chars.keys()])].sort()

if (sessions.length === 0) {
  console.log("no ctx-guard ledgers found")
  process.exit(0)
}

const pct = (part: number, whole: number): string =>
  whole > 0 ? `${((part / whole) * 100).toFixed(1)}%` : "n/a"

let totalPrompt = 0
let totalCacheRead = 0
let totalCharsRemoved = 0
let totalCharReads = 0
let rereadSessions = 0

for (const id of sessions) {
  console.log(id)

  const usage = tokens.get(id)
  if (usage) {
    // TokenUsage.Info semantics (verified against the log's AI.Usage and the
    // schema's total()):
    //   input       = fresh (uncached) input tokens
    //   cache.read  = input tokens served from cache
    //   cache.write = input tokens written to cache
    // so total prompt input = input + cache.read + cache.write.
    const prompt = usage.input + usage.cacheRead + usage.cacheWrite
    totalPrompt += prompt
    totalCacheRead += usage.cacheRead
    console.log(
      `  tokens:  input ${prompt} (fresh ${usage.input})  output ${usage.output}  reasoning ${usage.reasoning}`,
    )
    console.log(
      `  cache:   read ${usage.cacheRead}  write ${usage.cacheWrite}` +
        `  → ${pct(usage.cacheRead, prompt)} of input served from cache`,
    )
    if (usage.cost !== undefined) console.log(`  cost:    $${usage.cost.toFixed(4)}`)
  } else {
    console.log("  tokens:  (none recorded yet)")
  }

  const ledger = chars.get(id)
  if (ledger) {
    const removed = ledger.charsOmitted + ledger.charsDeduped
    totalCharsRemoved += removed
    console.log(
      `  static:  compress x${ledger.compressions} (-${ledger.charsOmitted})` +
        `  dedup x${ledger.dedups} (-${ledger.charsDeduped})  = -${removed} chars removed once`,
    )
    for (const [name, tally] of Object.entries(ledger.bySelector ?? {})) {
      console.log(`    ${name}: x${tally.compressions} (-${tally.charsOmitted} chars)`)
    }

    const list = events.get(id)
    const reread = list ? rereadFor(timeline.get(id) ?? [], list) : null
    if (reread) {
      rereadSessions += 1
      totalCharReads += reread.charReads
      console.log(
        `  reread:  -${reread.charReads} chars never re-transmitted` +
          `  → ${reread.multiplier.toFixed(1)}x static` +
          `  (avg ${reread.callsAfter.toFixed(0)} later model calls per compression)`,
      )
    } else if (list) {
      console.log("  reread:  (no assistant timeline for this session yet)")
    }
    if (ledger.charsDeduped > 0) {
      console.log(`            (dedup excluded from the reread figure: no per-event log)`)
    }
  }
  console.log("")
}

console.log(
  `total: ${totalPrompt} input tokens (${pct(totalCacheRead, totalPrompt)} served from cache) ` +
    `across ${sessions.length} session(s); ${totalCharsRemoved} chars removed once` +
    `, ${totalCharReads} chars never re-transmitted` +
    (rereadSessions > 0 && totalCharsRemoved > 0
      ? ` (${(totalCharReads / totalCharsRemoved).toFixed(1)}x static, from ${rereadSessions} session(s))`
      : ""),
)
