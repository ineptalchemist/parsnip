/**
 * Laya-scored selection — the offline "model-graded" path for the eval harness.
 *
 * Laya (taproot's local router) is a Python + torch classifier that cannot
 * live in this zero-dep TS plugin. So the model runs out-of-process (a scratch
 * probe) and writes a `laya.json` relevance map; this module consumes that with
 * pure TS and turns it into a *faithful* compaction, comparable to the built-in
 * selectors.
 *
 * The selector mirrors the others: keep head + tail verbatim, plus the middle
 * lines Laya scores as relevant (`>= threshold`), bounded to a char budget, with
 * a counted marker. It returns the input unchanged unless the result shrinks.
 */

import { HEAD_CHARS, MIN_CHARS, TAIL_CHARS } from "../../server/lib/selectors.ts"

/** p(relevant) per line, aligned with `text.split("\n")`. */
export type RelevanceItem = { task: string; p: number[] }
export type Relevance = { threshold: number; items: Record<string, RelevanceItem> }

/** Middle char budget (~extractive's `maxChars`) so the comparison is budget-fair. */
export const LAYA_MIDDLE_BUDGET = 2000

export const layaMarker = (kept: number, total: number): string =>
  `… [parsnip: laya kept ${kept} of ${total} middle lines] …`

/**
 * Keep head + tail verbatim, plus the middle lines with `p >= threshold`
 * (bounded). Faithful: every retained line is verbatim; only the marker is added.
 */
export function layaSelect(
  text: string,
  p: readonly number[],
  threshold: number,
  maxMiddleChars: number = LAYA_MIDDLE_BUDGET,
): string {
  if (text.length <= MIN_CHARS) return text
  const lines = text.split("\n")

  // Line start offsets, to classify head / middle / tail against the baseline cut.
  const starts: number[] = []
  let offset = 0
  for (const line of lines) {
    starts.push(offset)
    offset += line.length + 1 // + the newline
  }

  const head: number[] = []
  const tail: number[] = []
  const middle: number[] = []
  lines.forEach((line, i) => {
    const start = starts[i]
    const end = start + line.length
    if (end <= HEAD_CHARS) head.push(i)
    else if (start >= text.length - TAIL_CHARS) tail.push(i)
    else middle.push(i)
  })

  const keep: number[] = []
  let chars = 0
  for (const i of middle) {
    if ((p[i] ?? 0) < threshold) continue
    if (chars + lines[i].length > maxMiddleChars) break
    keep.push(i)
    chars += lines[i].length
  }

  const out = [
    ...head.map((i) => lines[i]),
    layaMarker(keep.length, middle.length),
    ...keep.map((i) => lines[i]),
    ...tail.map((i) => lines[i]),
  ].join("\n")

  return out.length < text.length ? out : text
}

/** Narrow untrusted JSON (the scratch probe's output) to a `Relevance`. */
export function parseRelevance(value: unknown): Relevance | null {
  if (value == null || typeof value !== "object") return null
  const record = value as Record<string, unknown>
  const threshold = typeof record.threshold === "number" ? record.threshold : null
  const items = record.items
  if (threshold === null || items == null || typeof items !== "object") return null

  const out: Record<string, RelevanceItem> = {}
  for (const [name, entry] of Object.entries(items as Record<string, unknown>)) {
    if (entry == null || typeof entry !== "object") return null
    const e = entry as Record<string, unknown>
    if (!Array.isArray(e.p) || e.p.some((n) => typeof n !== "number")) return null
    out[name] = { task: typeof e.task === "string" ? e.task : "", p: e.p as number[] }
  }
  return { threshold, items: out }
}
