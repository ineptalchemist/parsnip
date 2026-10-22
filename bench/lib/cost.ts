/**
 * Actual token cost: the formula, and the rate table it runs on.
 *
 * The number that matters is the dollar figure on the invoice, not the
 * character count in the savings ledger. It is derived from four billable
 * buckets per model request:
 *
 *     cost = fresh_input/1e6  · R_in
 *          + cache_read/1e6   · R_cache_read
 *          + cache_write/1e6  · R_cache_write
 *          + (output + reasoning)/1e6 · R_out
 *
 * Three things about that formula are load-bearing, and each has already
 * produced a wrong number once:
 *
 *  1. `tokens.input` is FRESH (uncached) input. The full prompt is
 *     input + cache.read + cache.write. Cached read bills at its own rate,
 *     which on the Go tier is 3-13x cheaper than fresh input, so collapsing
 *     the buckets destroys the answer.
 *  2. Reasoning tokens bill at the OUTPUT rate. There is no separate one.
 *  3. Every rate is per 1M tokens, so every term divides by 1e6. A missing
 *     divisor is a 1000x error; a mis-indexed rate tuple is a ~90x error on
 *     the dominant term. Both have happened.
 *
 * Two adjustments turn "what the sheet says" into "what the invoice says":
 *
 *  - DEEPSEEK PEAK HOURS. 01:00-04:00 and 06:00-10:00 UTC, Monday-Friday,
 *    exactly double the rate. Weekends and all other hours are off-peak.
 *  - CONTEXT TIERS. Some models bill at a higher rate once the prompt passes
 *    a size threshold (GPT-6 Luna >272K, GPT-5.6 Luna >272K, Claude Haiku 5.5
 *    >100K, Grok 4.7 >200K, Qwen3.7 Plus >256K).
 *
 * OpenCode's own recorded `cost` is an OFF-PEAK computation: it applies the
 * base rate and never the peak multiplier, so it understates the DeepSeek
 * bill. It is a useful cross-check — it should equal the off-peak column
 * exactly — and a poor oracle, because it is not the invoice.
 *
 * Rates are captured from https://opencode.ai/docs/go/ (OpenCode Go) and from
 * the local model catalog (OpenRouter). Captured 2026-10-21; re-check before
 * trusting a total.
 *
 * Pure and synchronous: no database, no clock, no I/O. The reader lives in
 * `bench/cost.ts` and a test can exercise this directly.
 */

/** Per-1M-token rates for one billing tier. */
export type Rates = {
  input: number
  output: number
  cacheRead: number
  cacheWrite: number
}

/** How one model is priced. */
export type ModelRate = {
  /** Base (off-peak) rates per 1M tokens. */
  base: Rates
  /** Rates above a context-length threshold, when the provider has one. */
  above?: Rates
  /** Prompt tokens above which `above` applies. */
  aboveAt?: number
  /** True when the provider doubles its rate during peak hours. */
  peaks?: boolean
  /**
   * True when the rates were reconciled against OpenCode's recorded cost
   * rather than read off a price sheet. Such an entry is an aggregate fit,
   * not a published rate — the report marks it so a reader knows which it is.
   */
  approximate?: boolean
}

/** One model request, reduced to what the cost formula needs. */
export type MessageUsage = {
  provider: string
  model: string
  /** Epoch milliseconds of the request — the peak test reads its UTC hour. */
  at: number
  /** Fresh (uncached) input tokens. */
  input: number
  output: number
  reasoning: number
  cacheRead: number
  cacheWrite: number
  /** The cost OpenCode itself recorded, for cross-checking. */
  recordedCost: number
}

/**
 * OpenCode Go rates, per 1M tokens.
 *
 * Source: https://opencode.ai/docs/go/ (the Go and Go Plus tables carry the
 * same token rates and differ only in monthly limits). `base` is the off-peak
 * rate; `above` is the over-threshold rate where the provider has one.
 *
 * DeepSeek's two entries are the off-peak row — `peaks` marks them as
 * doubling at peak hours. GPT-5.6 Luna is here because the model catalog
 * (models.dev) does not carry it at all: the sheet's $0.20/$1.20/$0.02 is
 * what the recorded costs match, and the catalog's rate would halve them.
 */
export const GO_RATES: Readonly<Record<string, ModelRate>> = {
  "deepseek-v4-pro": {
    base: { input: 0.66, output: 1.98, cacheRead: 0.022, cacheWrite: 0 },
    peaks: true,
  },
  "deepseek-v4.1-flash": {
    base: { input: 0.15, output: 0.6, cacheRead: 0.003, cacheWrite: 0 },
    peaks: true,
  },
  "kimi-k3": {
    base: { input: 3, output: 15, cacheRead: 0.3, cacheWrite: 0 },
  },
  "glm-5.3-flash": {
    base: { input: 0.15, output: 0.5, cacheRead: 0.03, cacheWrite: 0 },
  },
  "gpt-6-luna": {
    base: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    above: { input: 0.2, output: 0.75, cacheRead: 0.02, cacheWrite: 0.25 },
    aboveAt: 272_000,
  },
  "gpt-5.6-luna": {
    base: { input: 0.2, output: 1.2, cacheRead: 0.02, cacheWrite: 0.25 },
    above: { input: 0.4, output: 1.8, cacheRead: 0.04, cacheWrite: 0.5 },
    aboveAt: 272_000,
  },
  "claude-haiku-5-5": {
    base: { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
    above: { input: 0.5, output: 2.5, cacheRead: 0.05, cacheWrite: 0.625 },
    aboveAt: 100_000,
  },
}

/**
 * OpenRouter rates, per 1M tokens, from the local model catalog (models.dev).
 *
 * Flat rates. OpenRouter's DeepSeek alias is the exception, not the rule —
 * see `APPROXIMATE_RATES` for what was done about it.
 */
export const OPENROUTER_RATES: Readonly<Record<string, Rates>> = {
  "~z-ai/glm-flash-latest": { input: 0.0273, output: 0.083, cacheRead: 0.0273, cacheWrite: 0 },
  "z-ai/glm-5.3-prime": { input: 2.8, output: 8.8, cacheRead: 0.56, cacheWrite: 0 },
  "anthropic/claude-haiku-5.5": { input: 0.1, output: 0.5, cacheRead: 0.01, cacheWrite: 0.125 },
}

/**
 * Rates reconstructed from OpenCode's recorded cost, for models whose price
 * cannot be read from a sheet.
 *
 * `openrouter/deepseek/deepseek-v4-pro-0813` is the only entry. Its recorded
 * cost does not reconcile with DeepSeek's own schedule: charged flat at the
 * peak rate it would be $7.34, at the off-peak rate $3.67, and under a
 * dynamic off-peak/peak schedule $4.42 — against $6.14 recorded. What does
 * reconcile, to 0.1% in aggregate, is DeepSeek's PEAK input and output rates
 * with cached reads contributing nothing: 3.57M input at $1.32/M plus 0.36M
 * output at $3.96/M is $6.144, against $6.1385 recorded.
 *
 * That fit is an aggregate reconciliation, not a per-message law — only 2 of
 * 318 messages match to the cent, with a median residual of $0.016 and a
 * maximum of $0.176. It is marked `approximate` so the report can say so.
 * Fitting rates per message was tried earlier and failed: the fit was
 * collinear and unreliable.
 */
export const APPROXIMATE_RATES: Readonly<Record<string, ModelRate>> = {
  "openrouter/deepseek/deepseek-v4-pro-0813": {
    base: { input: 1.32, output: 3.96, cacheRead: 0, cacheWrite: 0 },
    approximate: true,
  },
}

/**
 * Models known to be free that carry no `-free` / `:free` suffix: an
 * OpenRouter promo model and a Zen listing, neither of which appears in the
 * model catalog. Both recorded $0 across every request they appear in, over
 * thousands of requests, so pricing them at zero is evidenced rather than
 * assumed.
 */
const EXTRA_FREE_MODELS: ReadonlySet<string> = new Set([
  "openrouter/stealth/space-bunny-alpha",
  "opencode/deepseek-v4-flash",
])

/**
 * Providers and models whose spend is zero by construction.
 *
 * OpenCode's Zen models are free-tier, and Ollama models run locally. Their
 * traffic still shows up in the token counts (it is real context pressure)
 * but never in a bill, so they are priced at zero rather than reported as
 * unpriced — "free" and "unknown" are different findings.
 *
 * The `-free` / `:free` suffixes cover the Zen free models and OpenRouter's
 * `:free` tier. `big-pickle` is Zen's default model and carries no suffix.
 */
export function isFreeModel(provider: string, model: string): boolean {
  if (provider === "ollama") return true
  if (model.endsWith("-free") || model.endsWith(":free")) return true
  if (provider === "opencode" && model === "big-pickle") return true
  if (EXTRA_FREE_MODELS.has(`${provider}/${model}`)) return true
  return false
}

/** The DeepSeek peak window: 01:00-04:00 and 06:00-10:00 UTC, weekdays. */
export const PEAK_HOURS_UTC: ReadonlyArray<readonly [number, number]> = [
  [1, 4],
  [6, 10],
]

/**
 * True when `at` (epoch ms) falls in a DeepSeek peak window.
 *
 * Monday-Friday only, and the window is read in UTC — the provider's window,
 * not the local one. Weekends are always off-peak.
 */
export function isPeakHour(at: number): boolean {
  const date = new Date(at)
  const day = date.getUTCDay()
  if (day === 0 || day === 6) return false
  const hour = date.getUTCHours()
  return PEAK_HOURS_UTC.some(([from, to]) => hour >= from && hour < to)
}

/** The model's pricing, or `undefined` when it is not in the table. */
export function rateFor(provider: string, model: string): ModelRate | undefined {
  if (isFreeModel(provider, model)) {
    return { base: { input: 0, output: 0, cacheRead: 0, cacheWrite: 0 } }
  }
  const approximate = APPROXIMATE_RATES[`${provider}/${model}`]
  if (approximate) return { ...approximate, base: { ...approximate.base } }
  if (provider === "opencode-go") {
    const rate = GO_RATES[model]
    return rate ? { ...rate } : undefined
  }
  if (provider === "openrouter") {
    const rates = OPENROUTER_RATES[model]
    return rates ? { base: { ...rates } } : undefined
  }
  return undefined
}

/** The full prompt size of a request — the figure context tiers are tested against. */
export function promptTokens(use: MessageUsage): number {
  return use.input + use.cacheRead + use.cacheWrite
}

/**
 * The rates that apply to one request: the base tier or the over-threshold
 * one, doubled when the request landed in a peak window.
 *
 * `undefined` means the model is not priced — the caller must report it
 * rather than treat it as free.
 */
export function ratesFor(use: MessageUsage): Rates | undefined {
  const rate = rateFor(use.provider, use.model)
  if (!rate) return undefined
  const over = rate.above && rate.aboveAt !== undefined && promptTokens(use) > rate.aboveAt
  const chosen = over && rate.above ? rate.above : rate.base
  if (rate.peaks && isPeakHour(use.at)) {
    return {
      input: chosen.input * 2,
      output: chosen.output * 2,
      cacheRead: chosen.cacheRead * 2,
      cacheWrite: chosen.cacheWrite * 2,
    }
  }
  return { ...chosen }
}

/**
 * The dollar cost of one request, or `undefined` when the model is not
 * priced. Reasoning tokens bill at the output rate.
 */
export function costOf(use: MessageUsage): number | undefined {
  const rates = ratesFor(use)
  if (!rates) return undefined
  return (
    (use.input / 1e6) * rates.input +
    (use.cacheRead / 1e6) * rates.cacheRead +
    (use.cacheWrite / 1e6) * rates.cacheWrite +
    ((use.output + use.reasoning) / 1e6) * rates.output
  )
}

/**
 * The same cost computed with the peak multiplier withheld — the figure
 * OpenCode records, and the one to compare `recordedCost` against.
 */
export function offPeakCostOf(use: MessageUsage): number | undefined {
  const rate = rateFor(use.provider, use.model)
  if (!rate) return undefined
  const over = rate.above && rate.aboveAt !== undefined && promptTokens(use) > rate.aboveAt
  const chosen = over && rate.above ? rate.above : rate.base
  return (
    (use.input / 1e6) * chosen.input +
    (use.cacheRead / 1e6) * chosen.cacheRead +
    (use.cacheWrite / 1e6) * chosen.cacheWrite +
    ((use.output + use.reasoning) / 1e6) * chosen.output
  )
}

/** Per-model totals. */
export type ModelCost = {
  key: string
  requests: number
  input: number
  cacheRead: number
  cacheWrite: number
  output: number
  reasoning: number
  /** Computed with peak multipliers applied. */
  computed: number
  /** Computed with every request held at its base rate. */
  offPeak: number
  /** What OpenCode recorded. */
  recorded: number
  /** The part of `computed` that came from cached reads. */
  cachedCost: number
  /** Requests that landed in a peak window. */
  peakRequests: number
  /** True when the model's rates were reconciled against recorded cost. */
  approximate: boolean
  /** True when the model has no rate in the table. */
  unpriced: boolean
}

/** Aggregate totals over a set of requests. */
export type CostTotals = {
  models: ModelCost[]
  computed: number
  offPeak: number
  recorded: number
  /** The part of `computed` that came from cached reads. */
  cachedCost: number
  /** Models that were seen but could not be priced. */
  unpriced: string[]
  /** Tokens that no priced model accounts for. */
  unpricedTokens: number
}

/**
 * Fold a list of requests into per-model and overall totals.
 *
 * Unpriced models are kept in the output (flagged) rather than dropped: a
 * total that silently omits traffic is worse than one that admits a gap.
 */
export function aggregate(uses: readonly MessageUsage[]): CostTotals {
  const byModel = new Map<string, ModelCost>()
  const totals: CostTotals = {
    models: [],
    computed: 0,
    offPeak: 0,
    recorded: 0,
    cachedCost: 0,
    unpriced: [],
    unpricedTokens: 0,
  }

  for (const use of uses) {
    const key = `${use.provider}/${use.model}`
    let row = byModel.get(key)
    if (!row) {
      row = {
        key,
        requests: 0,
        input: 0,
        cacheRead: 0,
        cacheWrite: 0,
        output: 0,
        reasoning: 0,
        computed: 0,
        offPeak: 0,
        recorded: 0,
        cachedCost: 0,
        peakRequests: 0,
        approximate: false,
        unpriced: false,
      }
      byModel.set(key, row)
    }
    row.requests += 1
    row.input += use.input
    row.cacheRead += use.cacheRead
    row.cacheWrite += use.cacheWrite
    row.output += use.output
    row.reasoning += use.reasoning
    row.recorded += use.recordedCost

    const computed = costOf(use)
    const offPeak = offPeakCostOf(use)
    const spec = rateFor(use.provider, use.model)
    if (computed === undefined || offPeak === undefined) {
      row.unpriced = true
      totals.unpricedTokens +=
        use.input + use.cacheRead + use.cacheWrite + use.output + use.reasoning
      if (!totals.unpriced.includes(key)) totals.unpriced.push(key)
      continue
    }
    row.computed += computed
    row.offPeak += offPeak
    totals.computed += computed
    totals.offPeak += offPeak
    const rates = ratesFor(use)
    if (rates) {
      const cached = (use.cacheRead / 1e6) * rates.cacheRead
      row.cachedCost += cached
      totals.cachedCost += cached
    }
    // Only a model that actually has a peak multiplier can be in a peak
    // window; counting the hour for a flat-rate model would imply a
    // multiplier that does not exist.
    if (spec?.peaks && isPeakHour(use.at)) row.peakRequests += 1
    if (spec?.approximate) row.approximate = true
  }

  for (const row of byModel.values()) {
    totals.models.push(row)
    if (row.unpriced) continue
    totals.recorded += row.recorded
  }
  totals.models.sort((a, b) => b.computed - a.computed || b.recorded - a.recorded)
  return totals
}
