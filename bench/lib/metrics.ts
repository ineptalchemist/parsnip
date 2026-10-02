/**
 * Content-retention metrics for one (input, output) pair.
 *
 * Shared by `bench/compare.ts` (which sweeps selectors) and
 * `bench/threshold.ts` (which sweeps thresholds), so the two report the same
 * numbers for the same input and a difference between them is a real
 * difference in what was measured.
 *
 * The proxy metrics (signal / identifier / novel-line retention, fragment count)
 * come from `bench/lib/proxies.ts`. They are *proxies*: they measure what is
 * visible in the text, not semantic fidelity. A threshold that holds every
 * identifier while destroying the argument connecting them still scores well
 * here — read these as a floor on damage, not a verdict.
 *
 * Everything stays in chars. `omittedTokens` is the uncalibrated chars/4
 * heuristic, reported for continuity with the existing bench output and clearly
 * labelled as such wherever it is printed.
 */

import {
  fragments,
  identifiers,
  novelExactLines,
  novelShapeLines,
  pct,
  retainedIdentifiers,
  retainedLines,
  signalLines,
} from "./proxies.ts"

/** Uncalibrated token heuristic — chars / 4, same as `server/lib/quality.ts`. */
export const tokensOf = (chars: number): number => Math.ceil(chars / 4)

/** Line-based proxies need lines: below this, a line-retention number is noise. */
export const LINE_METRIC_MIN_LINES = 3

export type Metrics = {
  /** Output chars / input chars. Lower = more compressed; 1.0 = untouched. */
  ratio: number
  inputChars: number
  outputChars: number
  /** Chars actually removed. */
  removed: number
  /** Chars/4 heuristic. Not a token count. */
  omittedTokens: number
  signal: number | null
  identifier: number | null
  fragmentCount: number
  novelExact: number | null
  novelShape: number | null
}

/** Pure: every metric for one (input, output) pair. */
export function metricsFor(input: string, output: string): Metrics {
  const signal = signalLines(input)
  const ids = identifiers(input)
  const novelExact = novelExactLines(input)
  const novelShape = novelShapeLines(input)
  const lineMetrics =
    input.split("\n").filter((line) => line.length > 0).length >= LINE_METRIC_MIN_LINES

  return {
    ratio: input.length === 0 ? 1 : output.length / input.length,
    inputChars: input.length,
    outputChars: output.length,
    removed: Math.max(0, input.length - output.length),
    omittedTokens: tokensOf(Math.max(0, input.length - output.length)),
    signal: lineMetrics ? pct(retainedLines(output, signal), signal.length) : null,
    identifier: pct(retainedIdentifiers(output, ids), ids.length),
    fragmentCount: fragments(input, output),
    novelExact: lineMetrics ? pct(retainedLines(output, novelExact), novelExact.length) : null,
    novelShape: lineMetrics ? pct(retainedLines(output, novelShape), novelShape.length) : null,
  }
}

/** Mean over the non-null values, or null when every value is null. */
export function meanOrNull(values: Array<number | null>): number | null {
  const present = values.filter((v): v is number => v !== null)
  if (present.length === 0) return null
  return present.reduce((a, b) => a + b, 0) / present.length
}

/** Sum over the present values. */
export function total(values: Array<number | null>): number {
  return values
    .filter((v): v is number => v !== null)
    .reduce((a, b) => a + b, 0)
}