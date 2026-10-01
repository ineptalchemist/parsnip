/**
 * Export the fact corpus to JSON for the out-of-process Laya probe.
 *
 * Usage: `npm run eval:export [out.json]` (default `/tmp/opencode/laya-eval/facts.json`).
 */

import { mkdirSync, writeFileSync } from "node:fs"
import { dirname } from "node:path"
import { FACT_CORPUS } from "./facts.ts"

const out = process.argv[2] ?? "/tmp/opencode/laya-eval/facts.json"
mkdirSync(dirname(out), { recursive: true })

const items = FACT_CORPUS.map((item) => ({
  name: item.name,
  task: item.task,
  text: item.text,
  facts: item.facts,
}))

writeFileSync(out, JSON.stringify({ items }, null, 2))
console.log(`wrote ${items.length} items to ${out}`)
