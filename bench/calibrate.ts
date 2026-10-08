/**
 * Calibrate parsnip's chars→tokens estimate against real provider usage.
 *
 * The report's `~` token figures divide observed chars by a chars-per-token
 * ratio. The fallback (3.5) came from this measurement; sessions also
 * calibrate live (`server/lib/attribution.ts`, "Calibration"). This script
 * re-runs the offline measurement:
 *
 * Method: walk each session's assistant messages. `tokens.input +
 * cache.read + cache.write` is that request's prompt size, and the prompt
 * grows between two consecutive requests by exactly the content added in
 * between (assistant text + reasoning + tool inputs/results + user text).
 * So `Δchars / ΔpromptTokens` is an empirical chars-per-token ratio for the
 * content this install actually sends. Pairs spanning a compaction, agent,
 * model, or location switch are skipped; so are rows without tokens.
 *
 * Measured 2026-10-08 (282 sessions, 11,751 pairs): weighted 3.47 overall,
 * 3.61 for additions >= 2000 chars; per model the spread is ~3.3-3.9
 * (deepseek-v4.1-flash 3.65). Small pairs read lower because per-message
 * overhead tokens carry no chars. The 3.5 fallback is the rounded overall
 * figure.
 *
 * Usage:
 *   npm run calibrate                 # default DB (OpenCode's opencode.db)
 *   node bench/calibrate.ts /path/to/opencode.db
 */
import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const defaultDb = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const dbPath = process.argv[2] ?? defaultDb

type Part = { type?: string; text?: string; state?: { input?: unknown; content?: unknown } }
type AssistantData = {
  text?: string
  model?: { providerID?: string; id?: string }
  content?: Part[]
  tokens?: { input?: number; reasoning?: number; cache?: { read?: number; write?: number } }
}
type Pair = { model: string; chars: number; tokens: number; ratio: number }

const partChars = (part: Part): number => {
  if (part.type === "text" || part.type === "reasoning") return part.text?.length ?? 0
  if (part.type === "tool") {
    let n = 0
    if (part.state?.input !== undefined) n += JSON.stringify(part.state.input).length
    if (Array.isArray(part.state?.content)) {
      for (const c of part.state.content as Part[]) {
        if (c?.type === "text") n += c.text?.length ?? 0
      }
    }
    return n
  }
  if (part.type === "compaction") return part.text?.length ?? 0
  return 0
}

const assistantChars = (data: AssistantData): number =>
  (data.content ?? []).reduce((sum, part) => sum + partChars(part), 0)

const promptTokens = (tokens: AssistantData["tokens"]): number | null =>
  tokens ? (tokens.input ?? 0) + (tokens.cache?.read ?? 0) + (tokens.cache?.write ?? 0) : null

const SKIP_TYPES = new Set([
  "compaction",
  "system",
  "agent-switched",
  "model-switched",
  "location-switched",
  "synthetic",
])

const db = new DatabaseSync(dbPath, { readOnly: true })
const sessions = db
  .prepare(
    "SELECT DISTINCT session_id FROM session_message WHERE type = 'assistant' AND json_extract(data,'$.tokens') IS NOT NULL",
  )
  .all() as Array<{ session_id: string }>
const pairs: Pair[] = []

for (const session of sessions) {
  const rows = db
    .prepare("SELECT type, data FROM session_message WHERE session_id = ? ORDER BY seq")
    .all(session.session_id) as Array<{ type: string; data: string }>
  let prev: { model: string; prompt: number; chars: number } | null = null
  let pendingChars = 0
  let dirty = false
  for (const row of rows) {
    const data = JSON.parse(row.data) as AssistantData
    if (row.type === "assistant") {
      const prompt = promptTokens(data.tokens)
      const model = `${data.model?.providerID ?? "?"}/${data.model?.id ?? "?"}`
      if (prompt === null) {
        pendingChars += assistantChars(data)
        continue
      }
      if (prev && !dirty && prev.model === model && prompt > prev.prompt) {
        const chars = prev.chars + pendingChars
        const tokens = prompt - prev.prompt
        if (chars > 0 && tokens > 0) pairs.push({ model, chars, tokens, ratio: chars / tokens })
      }
      prev = { model, prompt, chars: assistantChars(data) }
      pendingChars = 0
      dirty = false
    } else if (row.type === "user") {
      pendingChars += typeof data.text === "string" ? data.text.length : 0
    } else if (SKIP_TYPES.has(row.type)) {
      dirty = true
    }
  }
}
db.close()

const summarize = (label: string, list: Pair[]): string => {
  if (list.length === 0) return `${label}: n=0`
  const sorted = [...list].sort((a, b) => a.ratio - b.ratio)
  const chars = list.reduce((sum, p) => sum + p.chars, 0)
  const tokens = list.reduce((sum, p) => sum + p.tokens, 0)
  const at = (fraction: number) => sorted[Math.floor(sorted.length * fraction)].ratio.toFixed(2)
  return (
    `${label}: n=${list.length}  weighted=${(chars / tokens).toFixed(2)}` +
    `  median=${sorted[Math.floor(sorted.length / 2)].ratio.toFixed(2)}  p10=${at(0.1)}  p90=${at(0.9)}`
  )
}

console.log(`chars-per-token calibration — ${dbPath}`)
console.log(`sessions: ${sessions.length}  pairs: ${pairs.length}`)
console.log(summarize("all pairs      ", pairs))
console.log(summarize("chars >= 500   ", pairs.filter((p) => p.chars >= 500)))
console.log(summarize("chars >= 2000  ", pairs.filter((p) => p.chars >= 2000)))
console.log()
const byModel = new Map<string, Pair[]>()
for (const pair of pairs) {
  const list = byModel.get(pair.model) ?? []
  list.push(pair)
  byModel.set(pair.model, list)
}
for (const [model, list] of [...byModel.entries()].sort((a, b) => b[1].length - a[1].length).slice(0, 12)) {
  console.log("  " + summarize(model, list))
}
