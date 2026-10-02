/**
 * Pure token / occupancy estimation.
 *
 * No OpenCode imports and no side effects — everything here is unit-testable
 * under `node --test` without the OpenCode runtime.
 *
 * The `chars / 4` heuristic is deliberately crude, and it is NOT the plugin's
 * token measurement. Real provider usage is captured from the
 * `session.usage.updated` event and stored per session (see `tokenUsageFrom` in
 * `./storage.ts`); that ledger — not this function — is what `npm run savings`
 * reports and what the cache-preservation signal is read from.
 *
 * What this estimate is for: the *occupancy* reading shown in the compaction
 * continuity block, where a cheap relative number is enough. It is an estimate
 * by design; do not treat it as a token count.
 */

/** Heuristic token estimate: ~4 characters per token. */
export function estimateTokens(text: string): number {
  if (!text) return 0
  return Math.ceil(text.length / 4)
}

/** JSON.stringify that never throws (used for non-text parts). */
export function safeJson(value: unknown): string {
  if (value === undefined) return ""
  try {
    return JSON.stringify(value) ?? ""
  } catch {
    return "[unserializable]"
  }
}

/** Best-effort text for a single system part or message content part. */
export function partText(part: unknown): string {
  if (part == null) return ""
  if (typeof part === "string") return part
  if (typeof part !== "object") return String(part)
  const p = part as Record<string, unknown>
  if (typeof p.text === "string") return p.text
  if (p.media !== undefined) return "[media]"
  if (p.result !== undefined) return safeJson(p.result)
  if (p.input !== undefined) return safeJson(p.input)
  return ""
}

export type OccupancyReading = {
  tokens: number
  limit: number
  occupancy: number
}

/**
 * Compute occupancy. A non-positive limit means "unknown", reported as NaN:
 * an undefined ratio is more honest than a misleading 0, and NaN disables
 * threshold comparisons (so an unknown limit never triggers a nudge).
 */
export function computeOccupancy(tokens: number, limit: number): OccupancyReading {
  const occupancy = limit > 0 ? tokens / limit : Number.NaN
  return { tokens, limit, occupancy }
}

export type ContextShape = {
  system?: readonly unknown[]
  messages?: readonly unknown[]
  tools?: Record<string, unknown>
}

/**
 * Estimate total tokens for an outbound request: system parts, every message's
 * content parts, and the tool catalogue.
 *
 * Strictly read-only: the input is never mutated. This function is the heart of
 * the cache-preservation invariant — it must never write to the event.
 */
export function measureContext(input: ContextShape, limit: number): OccupancyReading {
  let tokens = 0

  for (const part of input.system ?? []) {
    tokens += estimateTokens(partText(part))
  }

  for (const message of input.messages ?? []) {
    const content = (message as { content?: unknown } | null)?.content
    if (Array.isArray(content)) {
      for (const part of content) tokens += estimateTokens(partText(part))
    } else if (content !== undefined) {
      tokens += estimateTokens(safeJson(content))
    }
  }

  const toolNames = Object.keys(input.tools ?? [])
  if (toolNames.length > 0) tokens += estimateTokens(safeJson(toolNames))

  return computeOccupancy(tokens, limit)
}
