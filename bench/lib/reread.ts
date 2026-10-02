/**
 * The reread multiplier: how much of parsnip's apparent saving is invisible
 * in the static ledger.
 *
 * The static figure counts characters removed from the transcript once. But a
 * compression shrinks the *prompt*, and every later model call re-sends the whole
 * prompt — so removed characters are never re-transmitted on any of those calls.
 * A compression made early in a session is therefore worth many times one made at
 * the end, and the static ledger alone understates the effect by the average
 * number of later calls.
 *
 * Everything here is unit-free and stays in characters. The multiplier is a
 * ratio of chars to chars, so no chars-to-tokens guess enters the calculation —
 * the repo deliberately retired that conversion (see `read-savings.ts`).
 *
 * Pure and synchronous, so `read-savings.ts` can depend on it without touching
 * the database and a test can exercise it directly.
 */

/** One recorded compression, as stored in `session:<id>:compressions`. */
export type CompressionEvent = {
  at: number
  omittedChars: number
}

/**
 * One assistant message, reduced to when it happened and how many model
 * invocations it implies.
 *
 * A message carrying K tool parts is roughly K+1 invocations: the model emitted
 * each tool call, and each tool result provoked the next call. Counting the
 * message plus its tool parts is therefore a LOWER BOUND on how many times the
 * prompt was re-sent afterwards.
 */
export type AssistantEvent = { at: number; invocations: number }

export type Reread = {
  /** Characters never re-transmitted (sum of omittedChars × later calls). */
  charReads: number
  /** charReads ÷ static removed characters. Dimensionless. */
  multiplier: number
  /** Mean later invocations per compression, for context in the readout. */
  callsAfter: number
  /** Static characters the multiplier was computed over (compression only). */
  staticChars: number
}

/** True when a stored compression record has the fields the maths needs. */
export function isCompressionEvent(value: unknown): value is CompressionEvent {
  if (value == null || typeof value !== "object") return false
  const e = value as Record<string, unknown>
  return typeof e.at === "number" && typeof e.omittedChars === "number"
}

/**
 * Model invocations implied by one assistant message's stored JSON: the message
 * itself, plus one for each tool part it contains. Unparseable input counts as a
 * single invocation rather than zero, so a malformed record can only make the
 * estimate conservative.
 */
export function toolInvocations(data: string): number {
  try {
    const parsed = JSON.parse(data) as { content?: unknown }
    if (!Array.isArray(parsed.content)) return 1
    let tools = 0
    for (const part of parsed.content) {
      if (part != null && typeof part === "object" && (part as { type?: unknown }).type === "tool") {
        tools += 1
      }
    }
    return 1 + tools
  } catch {
    return 1
  }
}

/** Invocations at or after `at` — the ones that see the shortened prompt. */
export function invocationsAfter(timeline: readonly AssistantEvent[], at: number): number {
  let total = 0
  for (const point of timeline) if (point.at > at) total += point.invocations
  return total
}

/**
 * Characters that never got re-transmitted.
 *
 * Returns null when the multiplier is not computable — no timeline for the
 * session (its messages are not flushed yet), no recorded events, or nothing
 * removed. Callers should print "n/a" rather than a misleading 1.0x.
 */
export function rereadFor(
  timeline: readonly AssistantEvent[],
  events: readonly CompressionEvent[],
): Reread | null {
  if (timeline.length === 0 || events.length === 0) return null

  const staticChars = events.reduce((sum, e) => sum + e.omittedChars, 0)
  if (staticChars <= 0) return null

  let charReads = 0
  let callsAfter = 0
  for (const event of events) {
    const after = invocationsAfter(timeline, event.at)
    charReads += event.omittedChars * after
    callsAfter += after
  }

  return {
    charReads,
    multiplier: charReads / staticChars,
    callsAfter: callsAfter / events.length,
    staticChars,
  }
}