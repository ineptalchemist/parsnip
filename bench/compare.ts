/**
 * Cross-selector bench: pushes the curated corpus (`bench/corpus.ts`) through
 * all five compression selectors and reports, per selector:
 *
 *   ratio        output chars / input chars (lower = more compressed)
 *   ~tok saved   ceil(omitted chars / 4) — the uncalibrated chars/4 heuristic
 *   signal       signal-line retention       \  content-retention proxies:
 *   ident        identifier retention         |  survived in output / present in
 *   novel-x      novel-line retention, exact  |  input, as a percentage
 *   novel-shape  novel-line retention, shape  /
 *
 * Run with `npm run compare`. Pure: imports only pure exports (no SDK, no
 * runtime deps), so Node 24 runs the `.ts` files directly.
 *
 * This is a *content-retention* report, not a correctness judgment. The corpus
 * gives every selector one home-turf item, so a missing win is a finding (see
 * the plan's "expected signals" section), not a silent pass.
 */

import { CORPUS } from "./corpus.ts"
import { SELECTOR_NAMES, SELECTORS } from "../server/lib/selectors.ts"
import {
  fragments,
  identifiers,
  novelExactLines,
  novelShapeLines,
  pct,
  retainedIdentifiers,
  retainedLines,
  signalLines,
} from "./lib/proxies.ts"

/** Uncalibrated token heuristic — chars / 4, same as `server/lib/quality.ts`. */
const tokensOf = (chars: number): number => Math.ceil(chars / 4)

/** Line-based proxies need lines: below this, a line-retention number is noise. */
const LINE_METRIC_MIN_LINES = 3

type Metrics = {
  ratio: number
  inputChars: number
  outputChars: number
  omittedTokens: number
  signal: number | null
  identifier: number | null
  fragmentCount: number
  novelExact: number | null
  novelShape: number | null
}

type Row = { selector: string; metrics: Metrics }
type ItemRows = { name: string; rows: Row[] }

/** Pure: every metric for one (input, output) pair. */
function metricsFor(input: string, output: string): Metrics {
  const signal = signalLines(input)
  const ids = identifiers(input)
  const novelExact = novelExactLines(input)
  const novelShape = novelShapeLines(input)
  const lineMetrics = input.split("\n").filter((line) => line.length > 0).length >= LINE_METRIC_MIN_LINES

  return {
    ratio: input.length === 0 ? 1 : output.length / input.length,
    inputChars: input.length,
    outputChars: output.length,
    omittedTokens: tokensOf(Math.max(0, input.length - output.length)),
    signal: lineMetrics ? pct(retainedLines(output, signal), signal.length) : null,
    identifier: pct(retainedIdentifiers(output, ids), ids.length),
    fragmentCount: fragments(input, output),
    novelExact: lineMetrics ? pct(retainedLines(output, novelExact), novelExact.length) : null,
    novelShape: lineMetrics ? pct(retainedLines(output, novelShape), novelShape.length) : null,
  }
}

// --- rendering --------------------------------------------------------------

type Col = { title: string; width: number; align: "left" | "right" }

const ITEM_COLUMNS: Col[] = [
  { title: "selector", width: 18, align: "left" },
  { title: "ratio", width: 7, align: "right" },
  { title: "chars in -> out", width: 24, align: "right" },
  { title: "~tok saved", width: 11, align: "right" },
  { title: "signal", width: 9, align: "right" },
  { title: "ident", width: 9, align: "right" },
  { title: "frag", width: 5, align: "right" },
  { title: "novel-x", width: 9, align: "right" },
  { title: "novel-shape", width: 12, align: "right" },
]

const ROLLUP_COLUMNS: Col[] = [
  { title: "selector", width: 18, align: "left" },
  { title: "ratio", width: 7, align: "right" },
  { title: "signal", width: 9, align: "right" },
  { title: "ident", width: 9, align: "right" },
  { title: "frag (sum)", width: 10, align: "right" },
  { title: "novel-x", width: 9, align: "right" },
  { title: "novel-shape", width: 12, align: "right" },
]

const fmtPct = (value: number | null): string => (value === null ? "n/a" : `${value.toFixed(1)}%`)

function render(cols: Col[], rows: string[][]): string[] {
  const cell = (value: string, col: Col): string =>
    col.align === "left" ? value.padEnd(col.width) : value.padStart(col.width)
  const lines = [`  ${cols.map((col) => cell(col.title, col)).join("  ")}`]
  for (const row of rows) lines.push(`  ${cols.map((col, i) => cell(row[i] ?? "", col)).join("  ")}`)
  return lines
}

function rowOf(row: Row): string[] {
  const m = row.metrics
  return [
    row.selector,
    m.ratio.toFixed(3),
    `${m.inputChars} -> ${m.outputChars}`,
    String(m.omittedTokens),
    fmtPct(m.signal),
    fmtPct(m.identifier),
    String(m.fragmentCount),
    fmtPct(m.novelExact),
    fmtPct(m.novelShape),
  ]
}

const mean = (values: number[]): number | null =>
  values.length === 0 ? null : values.reduce((a, b) => a + b, 0) / values.length

const sum = (values: number[]): number => values.reduce((a, b) => a + b, 0)

function rollupRows(perItem: ItemRows[]): string[][] {
  return SELECTOR_NAMES.map((selector) => {
    const ratios: number[] = []
    const signal: number[] = []
    const ident: number[] = []
    const fragCounts: number[] = []
    const novelX: number[] = []
    const novelShape: number[] = []

    for (const item of perItem) {
      const row = item.rows.find((r) => r.selector === selector)
      if (!row) continue
      ratios.push(row.metrics.ratio)
      if (row.metrics.signal !== null) signal.push(row.metrics.signal)
      if (row.metrics.identifier !== null) ident.push(row.metrics.identifier)
      fragCounts.push(row.metrics.fragmentCount)
      if (row.metrics.novelExact !== null) novelX.push(row.metrics.novelExact)
      if (row.metrics.novelShape !== null) novelShape.push(row.metrics.novelShape)
    }

    return [
      selector,
      (mean(ratios) ?? 1).toFixed(3),
      fmtPct(mean(signal)),
      fmtPct(mean(ident)),
      String(sum(fragCounts)),
      fmtPct(mean(novelX)),
      fmtPct(mean(novelShape)),
    ]
  })
}

// --- main -------------------------------------------------------------------

function main(): void {
  console.log("ctx-guard selector comparison")
  console.log(`corpus: ${CORPUS.length} items, all above the selectors' 4000-char gate`)
  console.log(`selectors: ${SELECTOR_NAMES.join(", ")}`)
  console.log("token heuristic: chars / 4 (uncalibrated)")
  console.log("retention = survived in the output / present in the input; n/a when the input has none")
  console.log("proxies measure visible text: ANSI escapes are formatting, not content (ratios stay on raw bytes)")
  console.log("frag = identifiers the output emits cut mid-token (lower is better; 0 = every emitted identifier is whole)")
  console.log(`line metrics are n/a on items with fewer than ${LINE_METRIC_MIN_LINES} lines`)

  const perItem: ItemRows[] = []

  for (const item of CORPUS) {
    const rows: Row[] = SELECTOR_NAMES.map((selector) => ({
      selector,
      metrics: metricsFor(item.text, SELECTORS[selector].select(item.text)),
    }))
    perItem.push({ name: item.name, rows })

    console.log(`\n### ${item.name} [${item.axis}]`)
    for (const line of render(ITEM_COLUMNS, rows.map(rowOf))) console.log(line)
  }

  console.log("\n### rollup (mean over items; n/a cells excluded)")
  for (const line of render(ROLLUP_COLUMNS, rollupRows(perItem))) console.log(line)
}

main()
