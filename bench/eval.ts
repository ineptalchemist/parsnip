/**
 * Known-answer eval: runs the planted-fact corpus (`bench/facts.ts`) through
 * every compression selector and reports **literal fact recovery** — the
 * measured answer to "does compression lose task-relevant signal?".
 *
 * Run with `npm run eval`. Pure: imports only pure exports (no SDK, no runtime
 * deps), so Node 24 runs the `.ts` files directly.
 *
 * Recovery is exact (selectors are faithful subsets). Bands are relative to the
 * head-tail baseline cut: `head`/`tail` are what the baseline keeps verbatim,
 * `middle` is what it drops — the headline number. Every corpus item sits in the
 * live-valid window (over the 4000-char gate, under the native caps), so these
 * are the few-line-but-long outputs where compression actually fires live.
 */

import { FACT_CORPUS } from "./facts.ts"
import { SELECTOR_NAMES, SELECTORS } from "../server/lib/selectors.ts"
import { BANDS, FACT_LABELS, pct, recover, recovery } from "./lib/recovery.ts"

type Col = { title: string; width: number; align: "left" | "right" }
type Kept = { kept: number; total: number }

const ITEM_COLUMNS: Col[] = [
  { title: "selector", width: 18, align: "left" },
  { title: "ratio", width: 7, align: "right" },
  { title: "recov", width: 7, align: "right" },
  { title: "head", width: 7, align: "right" },
  { title: "middle", width: 8, align: "right" },
  { title: "tail", width: 7, align: "right" },
]

const LABEL_COLUMNS: Col[] = [
  { title: "selector", width: 18, align: "left" },
  { title: "error", width: 7, align: "right" },
  { title: "file:line", width: 11, align: "right" },
  { title: "hash", width: 7, align: "right" },
  { title: "url", width: 7, align: "right" },
  { title: "value", width: 7, align: "right" },
  { title: "identifier", width: 11, align: "right" },
]

const fmtPct = (value: number | null): string => (value === null ? "n/a" : `${value.toFixed(0)}%`)

function render(cols: Col[], rows: string[][]): void {
  const cell = (value: string, col: Col): string =>
    col.align === "left" ? value.padEnd(col.width) : value.padStart(col.width)
  console.log(`  ${cols.map((col) => cell(col.title, col)).join("  ")}`)
  for (const row of rows) {
    console.log(`  ${cols.map((col, i) => cell(row[i] ?? "", col)).join("  ")}`)
  }
}

const add = (acc: Map<string, Kept>, key: string, kept: number, total: number): void => {
  const cur = acc.get(key) ?? { kept: 0, total: 0 }
  acc.set(key, { kept: cur.kept + kept, total: cur.total + total })
}

function main(): void {
  const totalFacts = FACT_CORPUS.reduce((n, item) => n + item.facts.length, 0)
  const bandCounts = BANDS.map((band) => {
    const n = FACT_CORPUS.reduce((acc, item) => acc + item.facts.filter((f) => f.band === band).length, 0)
    return `${band} ${n}`
  })

  console.log("ctx-guard known-answer eval")
  console.log(`corpus: ${FACT_CORPUS.length} items, ${totalFacts} planted facts (${bandCounts.join(" / ")})`)
  console.log(`selectors: ${SELECTOR_NAMES.join(", ")}`)
  console.log("recov = planted facts whose exact bytes survive; band = position vs the head-tail baseline cut")

  // Per-selector aggregates across all items.
  const midDistinctTotals = new Map<string, Kept>()
  const midPlainTotals = new Map<string, Kept>()
  const labelTotals = new Map<string, Map<string, Kept>>()

  for (const item of FACT_CORPUS) {
    console.log(`\n### ${item.name}  (${item.facts.length} facts)`)
    const rows = SELECTOR_NAMES.map((selector) => {
      const output = SELECTORS[selector].select(item.text)
      const r = recovery(output, item.facts)

      const midDistinct = item.facts.filter((f) => f.band === "middle" && f.distinctive !== false)
      const midPlain = item.facts.filter((f) => f.band === "middle" && f.distinctive === false)
      add(midDistinctTotals, selector, recover(output, midDistinct), midDistinct.length)
      add(midPlainTotals, selector, recover(output, midPlain), midPlain.length)
      const byLabel = labelTotals.get(selector) ?? new Map<string, Kept>()
      for (const label of FACT_LABELS) {
        const b = r.byLabel[label]
        add(byLabel, label, b.kept, b.total)
      }
      labelTotals.set(selector, byLabel)

      return [
        selector,
        (output.length / item.text.length).toFixed(3),
        fmtPct(pct(r.kept, r.total)),
        fmtPct(pct(r.byBand.head.kept, r.byBand.head.total)),
        fmtPct(pct(r.byBand.middle.kept, r.byBand.middle.total)),
        fmtPct(pct(r.byBand.tail.kept, r.byBand.tail.total)),
      ]
    })
    render(ITEM_COLUMNS, rows)
  }

  console.log("\n### labels (across items)")
  render(
    LABEL_COLUMNS,
    SELECTOR_NAMES.map((selector) => {
      const byLabel = labelTotals.get(selector)
      return [
        selector,
        ...FACT_LABELS.map((label) => {
          const k = byLabel?.get(label) ?? { kept: 0, total: 0 }
          return fmtPct(pct(k.kept, k.total))
        }),
      ]
    }),
  )

  console.log("\n### headline — middle-band recovery (across items)")
  printHeadline("distinctive (novel-shaped lines)", midDistinctTotals)
  printHeadline("plain (values in shape-repetitive lines)", midPlainTotals)
}

/** One middle-band headline block, for one distinctiveness class. */
function printHeadline(title: string, totals: Map<string, Kept>): void {
  console.log(`  ${title}:`)
  for (const selector of SELECTOR_NAMES) {
    const m = totals.get(selector) ?? { kept: 0, total: 0 }
    console.log(`    ${selector.padEnd(18)} ${fmtPct(pct(m.kept, m.total))}  (${m.kept}/${m.total})`)
  }
}

main()
