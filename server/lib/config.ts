/**
 * Runtime enablement config for parsnip's lossy transforms.
 *
 * Precedence (highest first): per-session override -> global override -> default.
 * Both overrides live in `ctx.storage` (the `kv` table), so a toggle survives
 * plugin hot reloads and process restarts — unlike the module constants this
 * replaces. Values are read at `execute.after` time, so a change takes effect on
 * the next tool call without depending on hot reload propagating a constant.
 *
 * `selector` picks *which* compression backend runs when `compression` is on
 * (see `./selectors.ts`). `isSelectorName` is the single source of truth for the
 * valid names, so an unknown stored value is dropped rather than trusted.
 *
 * The SDK reference is a type-only import, erased by Node's type stripper, so
 * this module adds no runtime dependency.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import type { SelectorName } from "./selectors.ts"
import { isSelectorName } from "./selectors.ts"

export type CtxGuardConfig = {
  /** Whether compression runs at all. */
  compression: boolean
  /** Collapse a repeated identical large result to a marker. */
  dedup: boolean
  /** Which compression selector runs when `compression` is on. */
  selector: SelectorName
  /** Compression threshold in chars; undefined = the selector's own default. */
  minChars?: number
}

/** A partial override; an absent field falls through to the next level. */
export type ConfigOverride = {
  compression?: boolean
  dedup?: boolean
  selector?: SelectorName
  minChars?: number
}

/** Smallest threshold accepted. Below it the derived budget leaves almost nothing. */
export const MIN_CHARS_LIMIT = 800

/** Largest threshold accepted — above this nothing is ever compressed. */
export const MAX_CHARS_LIMIT = 200_000

/**
 * Narrow a stored threshold to a usable integer in range.
 *
 * Rejected rather than clamped: a value mangled by a bad write (1500 -> 150)
 * should fall back to the selector default, not silently become a wildly
 * different setting. Non-integers are floored — a threshold is a character
 * count, so 1500.7 is not distinct from 1500.
 */
export function asMinChars(value: unknown): number | undefined {
  if (typeof value !== "number" || !Number.isFinite(value)) return undefined
  const floored = Math.floor(value)
  if (floored < MIN_CHARS_LIMIT || floored > MAX_CHARS_LIMIT) return undefined
  return floored
}

/** Used when neither the session nor the global override sets a field. */
export const DEFAULT_CONFIG: CtxGuardConfig = {
  // Compression was opt-in from 2026-09-30 until 2026-10-03, pending a quality
  // harness. The harness landed and the verdict is two-sided: `extractive` wins
  // its own salience classes outright (100% shape-novel, 4/4 middle prose facts
  // where every other method got 2/4), while the `value` class — facts with no
  // distinguishing feature — is ~0% for every selector. That residual gap is what
  // the recall cache is for, and it is why enabling compression by default does
  // not make it unsafe: nothing dropped is unrecoverable.
  compression: true,
  dedup: true,
  // `extractive` over `head-tail`: it retains strictly more of what the eval
  // measures as worth keeping, at a slightly worse ratio. It does fragment
  // identifiers the most (13 vs 9 over the compare corpus), which is the cost.
  selector: "extractive",
}

export const GLOBAL_CONFIG_KEY = "parsnip:config"
export const sessionConfigKey = (sessionID: string): string => `session:${sessionID}:parsnip`

/** Scope a change can be applied at. */
export type ConfigScope = "global" | "session"

// --- Pure resolution --------------------------------------------------------

/** Narrow an arbitrary stored JSON value to a ConfigOverride. */
export function asConfigOverride(value: unknown): ConfigOverride {
  if (!value || typeof value !== "object" || Array.isArray(value)) return {}
  const v = value as Record<string, unknown>
  const out: ConfigOverride = {}
  if (typeof v.compression === "boolean") out.compression = v.compression
  if (typeof v.dedup === "boolean") out.dedup = v.dedup
  if (isSelectorName(v.selector)) out.selector = v.selector
  const minChars = asMinChars(v.minChars)
  if (minChars !== undefined) out.minChars = minChars
  return out
}

/**
 * Resolve the effective config field by field: session override beats global
 * override beats the default, so a session can turn compression off while
 * inheriting the global dedup setting.
 */
export function resolveConfig(
  globalOverride: ConfigOverride = {},
  sessionOverride: ConfigOverride = {},
  defaults: CtxGuardConfig = DEFAULT_CONFIG,
): CtxGuardConfig {
  return {
    compression: sessionOverride.compression ?? globalOverride.compression ?? defaults.compression,
    dedup: sessionOverride.dedup ?? globalOverride.dedup ?? defaults.dedup,
    selector: sessionOverride.selector ?? globalOverride.selector ?? defaults.selector,
    minChars: sessionOverride.minChars ?? globalOverride.minChars ?? defaults.minChars,
  }
}

/** Human/agent-readable one-line summary of a config. */
export function describeConfig(config: CtxGuardConfig): string {
  const threshold = config.minChars === undefined ? "default" : `${config.minChars} chars`
  return (
    `compression ${config.compression ? "on" : "off"}, dedup ${config.dedup ? "on" : "off"}, ` +
    `selector ${config.selector}, threshold ${threshold}`
  )
}

// --- Storage (ctx.storage; the SDK type is type-only) -----------------------

type Json = Parameters<StorageDomain["set"]>[1]

export async function loadGlobalConfig(storage: StorageDomain): Promise<ConfigOverride> {
  return asConfigOverride(await storage.get(GLOBAL_CONFIG_KEY))
}

export async function saveGlobalConfig(
  storage: StorageDomain,
  override: ConfigOverride,
): Promise<void> {
  await storage.set(GLOBAL_CONFIG_KEY, override as unknown as Json)
}

export async function clearGlobalConfig(storage: StorageDomain): Promise<void> {
  await storage.remove(GLOBAL_CONFIG_KEY)
}

export async function loadSessionConfig(
  storage: StorageDomain,
  sessionID: string,
): Promise<ConfigOverride> {
  return asConfigOverride(await storage.get(sessionConfigKey(sessionID)))
}

export async function saveSessionConfig(
  storage: StorageDomain,
  sessionID: string,
  override: ConfigOverride,
): Promise<void> {
  await storage.set(sessionConfigKey(sessionID), override as unknown as Json)
}

export async function clearSessionConfig(storage: StorageDomain, sessionID: string): Promise<void> {
  await storage.remove(sessionConfigKey(sessionID))
}

/** Read both levels and resolve in one call. */
export async function effectiveConfig(
  storage: StorageDomain,
  sessionID: string,
): Promise<CtxGuardConfig> {
  const [globalOverride, sessionOverride] = await Promise.all([
    loadGlobalConfig(storage),
    loadSessionConfig(storage, sessionID),
  ])
  return resolveConfig(globalOverride, sessionOverride)
}

/**
 * Apply a patch at the chosen scope, or clear that scope when `reset` is set.
 * Merging into the current override means a patch of `{ dedup: false }` leaves
 * the scope's compression setting untouched.
 */
export async function applyConfigPatch(
  storage: StorageDomain,
  sessionID: string,
  patch: ConfigOverride,
  options: { scope: ConfigScope; reset?: boolean },
): Promise<void> {
  if (options.scope === "session") {
    if (options.reset) return clearSessionConfig(storage, sessionID)
    const current = await loadSessionConfig(storage, sessionID)
    return saveSessionConfig(storage, sessionID, { ...current, ...patch })
  }
  if (options.reset) return clearGlobalConfig(storage)
  const current = await loadGlobalConfig(storage)
  return saveGlobalConfig(storage, { ...current, ...patch })
}
