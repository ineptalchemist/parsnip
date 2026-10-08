/**
 * Compaction probe — a lightweight, deterministic record of the last time the
 * `compaction` hook fired, plus a sentinel for verifying faithful injection.
 *
 * Two levels:
 *  - The hook's *injection* is recorded at firing time: did it fire, what did it
 *    push, and the system-part delta. This is deterministic and independent of
 *    the summarizer model.
 *  - The *survival* of the injected text is recorded later: a unique sentinel
 *    token is injected with the block, and a `session.compaction.ended` watcher
 *    records whether that token survived into the produced summary. This is the
 *    faithful-injection proof — the foundation for later carrying a memory
 *    address through compaction that the model can use to retrieve
 *    compacted-away results.
 *
 * Read-only with respect to the outgoing request: it stores counters, sizes,
 * and a token in `ctx.storage`, never text from the conversation. It is the
 * same shape as the other per-session ledgers in `storage.ts` (pure helpers + a
 * narrow + a storage key), and unit-testable without the OpenCode runtime.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { randomBytes } from "node:crypto"

/** What the compaction hook observed on its most recent firing. */
export type CompactionProbe = {
  /** How many times the hook has fired in this session. */
  fires: number
  /** Whether a continuity block was pushed into the outgoing system parts. */
  injected: boolean
  /** Length of the pushed block in characters; 0 when nothing was pushed. */
  blockChars: number
  /** System parts before the push (the summarizer request's own system prompt). */
  systemPartsBefore: number
  /** System parts after the push (should be `before + 1` when injected). */
  systemPartsAfter: number
  /** Whether `event.result` was already set (i.e. someone else owns the summary). */
  resultWasSet: boolean
  /** The sentinel token injected this firing, when the probe is enabled. */
  sentinel?: string
  /**
   * Whether the sentinel survived into the produced summary. Undefined until a
   * `session.compaction.ended` event reports the verdict.
   */
  sentinelFound?: boolean
  agent?: string
  updatedAt: number
}

/** Stable storage key for a session's compaction-probe record. */
export const compactionProbeKey = (sessionID: string): string =>
  `session:${sessionID}:compaction-probe`

/**
 * A unique, impossible-to-guess token injected with the continuity block.
 * `PCOMPACT-` plus 8 hex chars (32 bits) from CSPRNG — collision with the
 * conversation text is implausible, and it is regenerated per firing so a stale
 * token from an earlier compaction cannot false-positive the verdict.
 */
export function makeSentinel(): string {
  return `PCOMPACT-${randomBytes(4).toString("hex")}`
}

/** Coerce to a finite, non-negative integer (defensive against junk). */
function count(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? Math.max(0, Math.floor(value)) : 0
}

/** Narrow an arbitrary stored JSON value to a probe record, or undefined. */
export function asCompactionProbe(value: unknown): CompactionProbe | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  return {
    fires: count(v.fires),
    injected: v.injected === true,
    blockChars: count(v.blockChars),
    systemPartsBefore: count(v.systemPartsBefore),
    systemPartsAfter: count(v.systemPartsAfter),
    resultWasSet: v.resultWasSet === true,
    sentinel: typeof v.sentinel === "string" ? v.sentinel : undefined,
    sentinelFound: typeof v.sentinelFound === "boolean" ? v.sentinelFound : undefined,
    agent: typeof v.agent === "string" ? v.agent : undefined,
    updatedAt: count(v.updatedAt),
  }
}

export async function loadCompactionProbe(
  storage: StorageDomain,
  sessionID: string,
): Promise<CompactionProbe | undefined> {
  return asCompactionProbe(await storage.get(compactionProbeKey(sessionID)))
}

export async function saveCompactionProbe(
  storage: StorageDomain,
  sessionID: string,
  probe: CompactionProbe,
): Promise<void> {
  await storage.set(
    compactionProbeKey(sessionID),
    probe as unknown as Parameters<StorageDomain["set"]>[1],
  )
}

/**
 * Pure: fold one firing into the previous record. `systemPartsBefore` and
 * `systemPartsAfter` are the outgoing system-part counts around the push, both
 * measured by the caller — `before` must be the current event's count, not a
 * value carried from the previous firing. `sentinel` is present only when the
 * probe is enabled; the new firing's `sentinelFound` is always reset to
 * undefined (awaiting the `session.compaction.ended` verdict).
 */
export function recordCompactionProbe(
  previous: CompactionProbe | undefined,
  input: {
    injected: boolean
    blockChars: number
    systemPartsBefore: number
    systemPartsAfter: number
    resultWasSet: boolean
    sentinel?: string
    agent?: string
  },
  now = Date.now(),
): CompactionProbe {
  return {
    fires: (previous?.fires ?? 0) + 1,
    injected: input.injected,
    blockChars: input.blockChars,
    systemPartsBefore: input.systemPartsBefore,
    systemPartsAfter: input.systemPartsAfter,
    resultWasSet: input.resultWasSet,
    sentinel: input.sentinel,
    sentinelFound: undefined,
    agent: input.agent,
    updatedAt: now,
  }
}

/**
 * Pure: record whether the sentinel survived into the produced summary. A no-op
 * when the stored probe has no sentinel (probe was off at firing time).
 */
export function recordCompactionVerdict(
  probe: CompactionProbe | undefined,
  summary: string,
  now = Date.now(),
): CompactionProbe | undefined {
  if (!probe || !probe.sentinel) return probe
  return { ...probe, sentinelFound: summary.includes(probe.sentinel), updatedAt: now }
}

/**
 * Render the probe for the report. Returns an empty string when there is
 * nothing to show yet, so the formatter can skip the section entirely.
 */
export function formatCompactionProbe(probe: CompactionProbe | undefined): string {
  if (!probe || probe.fires === 0) return ""
  const lines: string[] = [
    "Compaction probe (last firing — hook observed, not model output)",
    `  fired ${probe.fires} time(s)${probe.agent ? ` · agent ${probe.agent}` : ""}`,
    `  injected ${probe.injected ? "yes" : "no"} · block ${probe.blockChars} chars · system ${probe.systemPartsBefore} -> ${probe.systemPartsAfter}`,
    `  summary ownership ${probe.resultWasSet ? "pre-set (skipped)" : "left to the main model"}`,
  ]
  if (probe.sentinel) {
    const verdict =
      probe.sentinelFound === undefined
        ? "awaiting summary"
        : probe.sentinelFound
          ? "survived"
          : "NOT found"
    lines.push(`  sentinel ${probe.sentinel} · ${verdict}`)
  }
  return lines.join("\n")
}
