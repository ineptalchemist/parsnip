/**
 * Builds the continuity block injected into the compaction system prompt.
 *
 * This runs only at the compaction boundary, so it does not touch the live
 * conversation prefix and cannot invalidate the prompt cache.
 */
import { partText } from "./quality.ts"
import type { ContinuityState } from "./storage.ts"

export type ContinuityInput = {
  agent?: string
  state?: ContinuityState
  messages?: readonly unknown[]
}

const MAX_TASK_CHARS = 240
const MAX_DECISIONS = 8

/**
 * The *rendering* bound for the "Last command" line, applied when the continuity
 * block is built.
 *
 * Deliberately not imported from `toolhooks.ts`: this module is a leaf and must
 * not depend on it. The value there (`MAX_COMMAND_CHARS`, 200) is the
 * *recording* bound applied in `execute.before`, so a command read out of
 * storage is already at most this long and this truncation is normally a no-op
 * — it only bites if a longer value was written by hand. Both are 200 on
 * purpose; keep them in step if either changes.
 */
const MAX_COMMAND_CHARS = 200

export function truncate(text: string, max: number): string {
  if (text.length <= max) return text
  return `${text.slice(0, max - 1).trimEnd()}…`
}

export function percent(fraction: number): string {
  if (!Number.isFinite(fraction)) return "n/a"
  return `${(fraction * 100).toFixed(1)}%`
}

/** Recover the most recent user turn as a fallback "current task". */
export function lastUserText(messages?: readonly unknown[]): string {
  if (!messages || messages.length === 0) return ""
  for (let i = messages.length - 1; i >= 0; i -= 1) {
    const message = messages[i] as { role?: unknown; content?: unknown } | null
    if (!message || message.role !== "user") continue
    const content = message.content
    if (!Array.isArray(content)) continue
    const text = content.map(partText).join("\n").trim()
    if (text) return text
  }
  return ""
}

/**
 * Render the continuity block. Returns an empty string when there is nothing
 * worth injecting, so the caller can skip the system part entirely.
 */
export function buildContinuityBlock(input: ContinuityInput): string {
  const { agent, state, messages } = input

  const task = (state?.lastTask || lastUserText(messages) || "").trim()
  const decisions = (state?.decisions ?? []).slice(-MAX_DECISIONS)
  const files = state?.activeFiles ?? []
  const lastCommand = (state?.lastCommand ?? "").trim()
  const hasOccupancy = state?.occupancy !== undefined && Number.isFinite(state.occupancy)

  // Nothing worth carrying → inject nothing (an agent-only block is noise).
  if (!task && !lastCommand && decisions.length === 0 && files.length === 0 && !hasOccupancy) {
    return ""
  }

  const lines: string[] = ["[ctx-guard continuity]"]
  if (agent) lines.push(`Agent mode: ${agent}`)

  if (task) lines.push(`Current task: ${truncate(task, MAX_TASK_CHARS)}`)

  if (lastCommand) lines.push(`Last command: ${truncate(lastCommand, MAX_COMMAND_CHARS)}`)

  if (decisions.length > 0) {
    lines.push("Recent decisions:")
    for (const decision of decisions) lines.push(`- ${decision}`)
  }

  if (files.length > 0) lines.push(`Active files: ${files.join(", ")}`)

  if (hasOccupancy) {
    const tokens = state?.tokens ?? 0
    const limit = state?.limit ?? 0
    lines.push(`Context occupancy at last reading: ${percent(state!.occupancy!)} (~${tokens}/${limit} tokens)`)
  }

  return lines.join("\n")
}
