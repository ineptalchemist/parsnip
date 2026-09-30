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

const defaultDb = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const dbPath = process.argv[2] ?? defaultDb

type CharLedger = {
  compressions: number
  charsOmitted: number
  dedups: number
  charsDeduped: number
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

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare("SELECT key, value FROM kv WHERE key LIKE ? OR key LIKE ? ORDER BY key")
  .all("%:savings", "%:usage") as Array<{ key: string; value: string }>
db.close()

const chars = new Map<string, CharLedger>()
const tokens = new Map<string, TokenUsage>()

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
  }
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
      `  chars:   compress x${ledger.compressions} (-${ledger.charsOmitted})` +
        `  dedup x${ledger.dedups} (-${ledger.charsDeduped})  = -${removed} chars removed`,
    )
  }
  console.log("")
}

console.log(
  `total: ${totalPrompt} input tokens (${pct(totalCacheRead, totalPrompt)} served from cache) ` +
    `across ${sessions.length} session(s); ${totalCharsRemoved} chars removed by compression/dedup`,
)
