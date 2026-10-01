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

import { HEAD_CHARS, TAIL_CHARS } from "../../server/lib/selectors.ts"

export type FactLabel = "error" | "file:line" | "hash" | "url" | "value" | "identifier"
export type Band = "head" | "middle" | "tail"

export type Fact = {
  /** Exact substring planted in the item (must be unique within it). */
  text: string
  label: FactLabel
  /** Position relative to the head-tail baseline cut (validated, not computed). */
  band: Band
  /**
   * Whether the fact's *line* has a unique digit-masked shape (`lineShape`).
   * Default `true`. `false` = "plain": a specific value inside a line whose shape
   * recurs — invisible to novelty-based selection. Validated, not computed.
   */
  distinctive?: boolean
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
