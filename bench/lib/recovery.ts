/**
 * Known-answer recovery scoring for the eval harness (`bench/eval.ts`).
 *
 * The heuristic proxies in `bench/lib/proxies.ts` measure retention of
 * *pattern-detected* content. This module measures retention of *known answers*:
 * facts we deliberately planted at controlled positions, so we know exactly what
 * a selector should have kept.
 *
 * A fact's `band` is classified against the **head-tail baseline** cut
 * (`HEAD_CHARS` / `TAIL_CHARS`): "head" and "tail" are what the baseline keeps
 * verbatim; "middle" is the region it drops — the interesting set. The band is
 * declared by the corpus and validated against `bandOf` (see `recovery.test.ts`),
 * so scoring needs only the output + facts, not the input.
 *
 * Scoring is exact: selectors are faithful subsets, so a fact survives iff its
 * bytes are a substring of the output. A fact inside a "…"-truncated long line
 * is therefore correctly counted as lost.
 */

import { HEAD_CHARS, SIGNAL_PATTERN, TAIL_CHARS, lineShape } from "../../server/lib/selectors.ts"

export type FactLabel = "error" | "file:line" | "hash" | "url" | "value" | "identifier"
export type Band = "head" | "middle" | "tail"

export type Fact = {
  /** Exact substring planted in the item (must be unique within it). */
  text: string
  label: FactLabel
  /** Position relative to the head-tail baseline cut (validated, not computed). */
  band: Band
}

export type CorpusItem = {
  name: string
  /** The task/query the facts matter to — Laya judges relevance against this. */
  task: string
  text: string
  facts: Fact[]
}

export const FACT_LABELS: readonly FactLabel[] = [
  "error",
  "file:line",
  "hash",
  "url",
  "value",
  "identifier",
]

export const BANDS: readonly Band[] = ["head", "middle", "tail"]

/** Classify a fact's position against the head-tail baseline cut. */
export function bandOf(text: string, input: string): Band {
  const i = input.indexOf(text)
  if (i < 0) return "middle" // absent → "middle" (and recover() will miss it)
  const end = i + text.length
  if (end <= HEAD_CHARS) return "head"
  if (i >= input.length - TAIL_CHARS) return "tail"
  return "middle"
}

// --- Salience ----------------------------------------------------------------
//
// The "salience class" is *which shallow feature a selector could use to find a
// fact*. It is **computed**, not hand-tagged, so the classification is objective
// and re-derivable — and it exposes the circularity the old `distinctive`
// boolean hid: extractive is graded on `shape-novel` (its own `novelty` term),
// signal-preserving on `signal` (its own pattern). The `value` class — no shallow
// feature at all — is the only one that tests relevance.

/** Precedence: positional > signal > shape-novel > value. */
export type Salience = "positional" | "signal" | "shape-novel" | "value"

export const SALIENCES: readonly Salience[] = ["positional", "signal", "shape-novel", "value"]

/** The first line of `text` containing `fact`, or "" when absent. */
export function lineContaining(text: string, fact: string): string {
  for (const line of text.split("\n")) if (line.includes(fact)) return line
  return ""
}

/** How many lines of `text` share the digit-masked `lineShape` of `line`. */
export function shapeCount(text: string, line: string): number {
  const shape = lineShape(line)
  let n = 0
  for (const l of text.split("\n")) if (lineShape(l) === shape) n += 1
  return n
}

/**
 * Classify a fact by the minimal feature a selector needs to keep it:
 *  - `positional`  — in the head/tail (kept verbatim by every selector)
 *  - `signal`      — its line matches `SIGNAL_PATTERN`
 *  - `shape-novel` — its line's `lineShape` is unique (extractive's novelty turf)
 *  - `value`       — none of the above: the hard class, no shallow feature
 */
export function salienceOf(fact: Fact, itemText: string): Salience {
  if (fact.band !== "middle") return "positional"
  const line = lineContaining(itemText, fact.text)
  if (line && SIGNAL_PATTERN.test(line)) return "signal"
  if (line && shapeCount(itemText, line) === 1) return "shape-novel"
  return "value"
}

/** Number of `facts` whose text is present in `output`. */
export function recover(output: string, facts: readonly Fact[]): number {
  let kept = 0
  for (const fact of facts) if (output.includes(fact.text)) kept += 1
  return kept
}

export type Kept = { kept: number; total: number }

export type Recovery = {
  kept: number
  total: number
  byBand: Record<Band, Kept>
  byLabel: Record<FactLabel, Kept>
}

const emptyKept = (): Kept => ({ kept: 0, total: 0 })

/** Recovery broken down by band and by label. */
export function recovery(output: string, facts: readonly Fact[]): Recovery {
  const byBand = {} as Record<Band, Kept>
  const byLabel = {} as Record<FactLabel, Kept>
  for (const band of BANDS) byBand[band] = emptyKept()
  for (const label of FACT_LABELS) byLabel[label] = emptyKept()

  let kept = 0
  for (const fact of facts) {
    const survived = output.includes(fact.text)
    byBand[fact.band].total += 1
    byLabel[fact.label].total += 1
    if (survived) {
      kept += 1
      byBand[fact.band].kept += 1
      byLabel[fact.label].kept += 1
    }
  }
  return { kept, total: facts.length, byBand, byLabel }
}

/** Recovery as a percentage, or null when there is nothing of that class. */
export const pct = (kept: number, total: number): number | null =>
  total === 0 ? null : (kept / total) * 100
