/**
 * Compression selectors: pluggable, faithful text compactors.
 *
 * A selector maps a text string to a compaction of it. The **faithful
 * contract**: the output is a verbatim subset of the input's words/lines,
 * optionally joined by delimited `[ctx-guard: …]` markers that carry only
 * counts; a selector never invents content. Selectors are pure and synchronous.
 *
 * This is a **leaf module**: it imports nothing from the rest of the server, so
 * `toolhooks.ts` can depend on it without a cycle. Only a type reference to the
 * SDK would be allowed here, and there is none — nothing external is resolved at
 * runtime, so the plugin keeps zero runtime dependencies.
 *
 * Adding a selector: implement `{ id, select }`, add its id to `SELECTOR_NAMES`,
 * and register it in `SELECTORS`. Existing stored config values keep working:
 * `resolveSelector` falls back to `head-tail` for any unknown name.
 */

export type CompressOptions = {
  /** Results shorter than this are left completely untouched. */
  minChars: number
  /** Characters kept from the start of an oversized result. */
  headChars: number
  /** Characters kept from the end of an oversized result. */
  tailChars: number
}

// --- Defaults ---------------------------------------------------------------
//
// These are the *head-tail* selector's shape/bound parameters. Whether
// compression runs at all is runtime-configurable (see `server/lib/config.ts`);
// which selector runs is also runtime-configurable.
export const MIN_CHARS = 4000
export const HEAD_CHARS = 1600
export const TAIL_CHARS = 1200

export const COMPRESSION_OPTIONS: CompressOptions = {
  minChars: MIN_CHARS,
  headChars: HEAD_CHARS,
  tailChars: TAIL_CHARS,
}

export function omissionMarker(omittedChars: number): string {
  return `… [ctx-guard: ${omittedChars} chars omitted] …`
}

export function shouldCompress(text: string, o: CompressOptions): boolean {
  return text.length > o.minChars
}

/**
 * Keep the head and the tail of an oversized string, replacing the middle with
 * an omission marker. Anything that would not actually shrink is returned
 * verbatim.
 */
export function compressText(text: string, o: CompressOptions): string {
  if (!shouldCompress(text, o)) return text
  const omitted = text.length - o.headChars - o.tailChars
  if (omitted <= 0 || o.headChars < 0 || o.tailChars < 0) return text
  return `${text.slice(0, o.headChars)}\n${omissionMarker(omitted)}\n${text.slice(text.length - o.tailChars)}`
}

// --- Selector registry ------------------------------------------------------

/**
 * Canonical list of selector ids. Grows one entry at a time as each selector
 * lands; `SelectorName` is derived from it so the config surface and the
 * registry can never drift.
 */
export const SELECTOR_NAMES = ["head-tail"] as const

export type SelectorName = (typeof SELECTOR_NAMES)[number]

/** A faithful compactor: output is a verbatim subset of the input, never generated. */
export type CompressionSelector = {
  id: SelectorName
  select: (text: string) => string
}

/** Positional head + tail with a counted omission marker. The baseline selector. */
export const headTail: CompressionSelector = {
  id: "head-tail",
  select: (text) => compressText(text, COMPRESSION_OPTIONS),
}

export const SELECTORS: Record<SelectorName, CompressionSelector> = {
  "head-tail": headTail,
}

export function isSelectorName(value: unknown): value is SelectorName {
  return typeof value === "string" && (SELECTOR_NAMES as readonly string[]).includes(value)
}

/**
 * Resolve a selector by name, falling back to `head-tail` for anything unknown
 * (a renamed/removed selector stored in an old config value must not throw).
 */
export function resolveSelector(name: string): CompressionSelector {
  return isSelectorName(name) ? SELECTORS[name] : headTail
}

/** Resolve + apply in one call, for the hook's one-liner. */
export function selectWith(name: string, text: string): string {
  return resolveSelector(name).select(text)
}
