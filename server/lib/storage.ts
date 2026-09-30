/**
 * Durable continuity state, keyed per session.
 *
 * Module-level state does NOT survive a plugin hot reload (the module is
 * re-evaluated from source), so all continuity lives in `ctx.storage`.
 *
 * The storage type is imported as a *type only* — it is erased by Node's type
 * stripper, so this module has no runtime dependency on the SDK.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { SavingsLedger } from "./toolhooks.ts"
import { asBySelector } from "./toolhooks.ts"

export type ContinuityState = {
  lastTask: string
  decisions: string[]
  activeFiles: string[]
  agent?: string
  tokens?: number
  limit?: number
  occupancy?: number
  updatedAt?: number
  /** Truncated last target-tool command, recorded on execute.before. */
  lastCommand?: string
}

/** Stable storage key for a session's continuity record. */
export const sessionKey = (sessionID: string): string => `session:${sessionID}`

/** Narrow an arbitrary stored JSON value to ContinuityState. */
export function asContinuity(value: unknown): ContinuityState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  return {
    lastTask: typeof v.lastTask === "string" ? v.lastTask : "",
    decisions: Array.isArray(v.decisions) ? (v.decisions as string[]) : [],
    activeFiles: Array.isArray(v.activeFiles) ? (v.activeFiles as string[]) : [],
    agent: typeof v.agent === "string" ? v.agent : undefined,
    tokens: typeof v.tokens === "number" ? v.tokens : undefined,
    limit: typeof v.limit === "number" ? v.limit : undefined,
    occupancy: typeof v.occupancy === "number" ? v.occupancy : undefined,
    updatedAt: typeof v.updatedAt === "number" ? v.updatedAt : undefined,
    lastCommand: typeof v.lastCommand === "string" ? v.lastCommand : undefined,
  }
}

export async function loadContinuity(
  storage: StorageDomain,
  sessionID: string,
): Promise<ContinuityState | undefined> {
  return asContinuity(await storage.get(sessionKey(sessionID)))
}

export async function saveContinuity(
  storage: StorageDomain,
  sessionID: string,
  state: ContinuityState,
): Promise<void> {
  await storage.set(sessionKey(sessionID), state as unknown as Parameters<StorageDomain["set"]>[1])
}

// --- Savings ledger (per session) -------------------------------------------

/** Stable storage key for a session's compression/dedup savings tally. */
export const savingsKey = (sessionID: string): string => `session:${sessionID}:savings`

/** Narrow an arbitrary stored JSON value to a SavingsLedger. */
export function asSavings(value: unknown): SavingsLedger {
  const base: SavingsLedger = {
    compressions: 0,
    charsOmitted: 0,
    dedups: 0,
    charsDeduped: 0,
    bySelector: {},
  }
  if (!value || typeof value !== "object" || Array.isArray(value)) return base
  const v = value as Record<string, unknown>
  const num = (key: string): number =>
    typeof v[key] === "number" && Number.isFinite(v[key]) ? (v[key] as number) : 0
  return {
    compressions: num("compressions"),
    charsOmitted: num("charsOmitted"),
    dedups: num("dedups"),
    charsDeduped: num("charsDeduped"),
    bySelector: asBySelector(v.bySelector),
  }
}

export async function loadSavings(
  storage: StorageDomain,
  sessionID: string,
): Promise<SavingsLedger> {
  return asSavings(await storage.get(savingsKey(sessionID)))
}

export async function saveSavings(
  storage: StorageDomain,
  sessionID: string,
  ledger: SavingsLedger,
): Promise<void> {
  await storage.set(savingsKey(sessionID), ledger as unknown as Parameters<StorageDomain["set"]>[1])
}

// --- Token usage ledger (per session) ---------------------------------------
//
// Real provider token usage, captured from the `session.usage.updated` event.
// Unlike the savings ledger (which counts characters), this records actual
// tokens: `input`/`output`/`reasoning` plus `cache.read`/`cache.write`. The
// event payload is the session's CUMULATIVE usage (the OpenCode client assigns
// it straight onto session.info), so each write overwrites — never a fold.
//
// `cacheRead` is the meaningful cache-preservation signal: a high
// cacheRead/input ratio means the live prefix was not invalidated.

export type TokenUsageState = {
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** Session cost in USD, when the event carried it. */
  cost?: number
  updatedAt: number
}

/** Stable storage key for a session's real token usage. */
export const tokenUsageKey = (sessionID: string): string => `session:${sessionID}:usage`

/** Coerce anything to a finite number, else 0. */
function num(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0
}

/** Narrow an arbitrary stored JSON value to TokenUsageState. */
export function asTokenUsage(value: unknown): TokenUsageState | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  return {
    input: num(v.input),
    output: num(v.output),
    reasoning: num(v.reasoning),
    cacheRead: num(v.cacheRead),
    cacheWrite: num(v.cacheWrite),
    cost: typeof v.cost === "number" && Number.isFinite(v.cost) ? v.cost : undefined,
    updatedAt: num(v.updatedAt),
  }
}

/**
 * Pure: convert a `session.usage.updated` payload into the stored state.
 * `tokens` is `TokenUsage.Info` ({ input, output, reasoning, cache: { read,
 * write } }); `cost` is USD. Tolerates junk so a malformed event cannot throw.
 */
export function tokenUsageFrom(tokens: unknown, cost?: unknown, now = Date.now()): TokenUsageState {
  const t = (tokens && typeof tokens === "object" ? tokens : {}) as Record<string, unknown>
  const cache = (t.cache && typeof t.cache === "object" ? t.cache : {}) as Record<string, unknown>
  return {
    input: num(t.input),
    output: num(t.output),
    reasoning: num(t.reasoning),
    cacheRead: num(cache.read),
    cacheWrite: num(cache.write),
    cost: typeof cost === "number" && Number.isFinite(cost) ? cost : undefined,
    updatedAt: now,
  }
}

export async function loadTokenUsage(
  storage: StorageDomain,
  sessionID: string,
): Promise<TokenUsageState | undefined> {
  return asTokenUsage(await storage.get(tokenUsageKey(sessionID)))
}

export async function saveTokenUsage(
  storage: StorageDomain,
  sessionID: string,
  state: TokenUsageState,
): Promise<void> {
  await storage.set(
    tokenUsageKey(sessionID),
    state as unknown as Parameters<StorageDomain["set"]>[1],
  )
}
