/**
 * Threshold sweep — decides what a lowered `minChars` actually buys.
 *
 * `npm run compare` sweeps SELECTORS over a corpus that is all above the 4000-char
 * gate, so every selector engages at every setting and the comparison says
 * nothing about the threshold. This sweeps THRESHOLDS over a corpus that spans
 * the band a lowered gate reaches, and reports, per (threshold, selector):
 *
 *   engage   how many items were compacted at all (ratio < 1)
 *   removed  chars actually removed, summed over the corpus
 *   ident    identifier retention — the fidelity cost of the setting
 *   frag     identifiers cut mid-token (lower is better; 0 = every one whole)
 *
 * The corpus is split deliberately. `SMALL_CORPUS` items sit below the default
 * gate, so they only engage as the threshold descends past them — that is the
 * marginal behaviour under test. `CORPUS` items are all above it, so they engage
 * at every setting and act as the *regression* half: a threshold must not make
 * big results worse, and this shows whether it does.
 *
 * Read the two halves together. "removed" going up is not automatically good if
 * "ident" collapses at the same threshold: the point is the knee, where extra
 * saving stops costing retention.
 *
 * Proxy metrics, not semantic fidelity — see `bench/lib/metrics.ts`. A setting
 * that preserves every identifier while destroying the argument connecting them
 * scores well here. Read as a floor on damage.
 *
 * Run with `npm run sweep`. Pure: no SDK, no runtime deps.
 */

import { CORPUS, SMALL_CORPUS, type CorpusItem } from "./corpus.ts"
import { SELECTOR_NAMES, SELECTORS, budgetFor } from "../server/lib/selectors.ts"
import { meanOrNull, metricsFor, total } from "./lib/metrics.ts"

/** Candidates from the config's accepted range, densest where the decision is. */
const THRESHOLDS = [800, 1000, 1200, 1500, 2000, 2500, 2800, 3200, 4000] as const

type Cell = {
  engaged: number
  items: number
  removed: number
  identifier: number | null
  signal: number | null
  fragments: number
}

function sweep(items: readonly CorpusItem[], selector: string, minChars: number): Cell {
  let engaged = 0
  let removed = 0
  let fragments = 0
  const ids: Array<number | null> = []
  const sig: Array<number | null> = []

  for (const item of items) {
    const out = SELECTORS[selector].select(item.text, minChars)
    const m = metricsFor(item.text, out)
    if (m.removed > 0) engaged += 1
    removed += m.removed
    fragments += m.fragmentCount
    ids.push(m.identifier)
    sig.push(m.signal)
  }

  return {
    engaged,
    items: items.length,
    removed,
    identifier: meanOrNull(ids),
    signal: meanOrNull(sig),
    fragments,
  }
}

const pctStr = (v: number | null): string => (v === null ? "n/a" : `${v.toFixed(1)}%`)

type Col = { title: string; width: number; align: "left" | "right" }

function render(cols: Col[], rows: string[][]): string[] {
  const cell = (value: string, col: Col): string =>
    col.align === "left" ? value.padEnd(col.width) : value.padStart(col.width)
  return [
    `  ${cols.map((c) => cell(c.title, c)).join("  ")}`,
    ...rows.map((row) => `  ${cols.map((c, i) => cell(row[i] ?? "", c)).join("  ")}`),
  ]
}

const SMALL_COLUMNS: Col[] = [
  { title: "threshold", width: 9, align: "right" },
  { title: "kept", width: 6, align: "right" },
  { title: "selector", width: 18, align: "left" },
  { title: "engage", width: 8, align: "right" },
  { title: "removed", width: 9, align: "right" },
  { title: "ident", width: 8, align: "right" },
  { title: "signal", width: 8, align: "right" },
  { title: "frag", width: 6, align: "right" },
]

const BIG_COLUMNS: Col[] = [
  { title: "threshold", width: 9, align: "right" },
  { title: "selector", width: 18, align: "left" },
  { title: "engage", width: 8, align: "right" },
  { title: "removed", width: 10, align: "right" },
  { title: "ident", width: 8, align: "right" },
  { title: "frag", width: 6, align: "right" },
]

function main(): void {
  console.log("parsnip threshold sweep")
  console.log(`thresholds: ${THRESHOLDS.join(", ")}`)
  console.log(`selectors: ${SELECTOR_NAMES.join(", ")}`)
  console.log(`small corpus: ${SMALL_CORPUS.length} items, ${total(SMALL_CORPUS.map((i) => i.text.length))} chars total`)
  console.log(`big corpus:   ${CORPUS.length} items, ${total(CORPUS.map((i) => i.text.length))} chars total (all above the default gate)`)
  console.log("")
  console.log("kept = head+tail budget once a result DOES compact (0.7 x threshold)")
  console.log("      it is always below the threshold, so the threshold is the real floor")
  console.log("engage = items actually compacted / total; removed = chars dropped over the corpus")
  console.log("ident/signal = content-retention proxies (see bench/lib/metrics.ts), not semantic fidelity")
  console.log("")

  // --- the marginal half: items a lowered threshold newly reaches ------------
  console.log("### small corpus — the band under test (marginal behaviour)")
  for (const minChars of THRESHOLDS) {
    const kept = budgetFor(minChars).headChars + budgetFor(minChars).tailChars
    const rows = SELECTOR_NAMES.map((selector) => {
      const c = sweep(SMALL_CORPUS, selector, minChars)
      return [
        String(minChars),
        String(kept),
        selector,
        `${c.engaged}/${c.items}`,
        String(c.removed),
        pctStr(c.identifier),
        pctStr(c.signal),
        String(c.fragments),
      ]
    })
    for (const line of render(SMALL_COLUMNS, rows)) console.log(line)
    console.log("")
  }

  // --- the regression half: items already above the default gate -------------
  console.log("### big corpus — already above the default gate (regression half)")
  for (const minChars of THRESHOLDS) {
    const rows = SELECTOR_NAMES.map((selector) => {
      const c = sweep(CORPUS, selector, minChars)
      return [
        String(minChars),
        selector,
        `${c.engaged}/${c.items}`,
        String(c.removed),
        pctStr(c.identifier),
        String(c.fragments),
      ]
    })
    for (const line of render(BIG_COLUMNS, rows)) console.log(line)
    console.log("")
  }

  // --- the decision table: one row per threshold, all selectors pooled ------
  console.log("### pooled across all selectors (the decision view)")
  const POOLED: Col[] = [
    { title: "threshold", width: 9, align: "right" },
    { title: "small removed", width: 14, align: "right" },
    { title: "small ident", width: 11, align: "right" },
    { title: "big removed", width: 12, align: "right" },
    { title: "big ident", width: 9, align: "right" },
    { title: "big frag", width: 9, align: "right" },
  ]
  const pooled = THRESHOLDS.map((minChars) => {
    const cells = SELECTOR_NAMES.map((s) => ({
      small: sweep(SMALL_CORPUS, s, minChars),
      big: sweep(CORPUS, s, minChars),
    }))
    return [
      String(minChars),
      String(total(cells.map((c) => c.small.removed))),
      pctStr(meanOrNull(cells.map((c) => c.small.identifier))),
      String(total(cells.map((c) => c.big.removed))),
      pctStr(meanOrNull(cells.map((c) => c.big.identifier))),
      String(total(cells.map((c) => c.big.fragments))),
    ]
  })
  for (const line of render(POOLED, pooled)) console.log(line)
}

main()