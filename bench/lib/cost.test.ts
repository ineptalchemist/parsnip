import assert from "node:assert/strict"
import { test } from "node:test"

import {
  aggregate,
  costOf,
  isPeakHour,
  offPeakCostOf,
  promptTokens,
  rateFor,
  ratesFor,
  type MessageUsage,
} from "./cost.ts"

/** Epoch ms for a given UTC weekday and hour. 2026-10-21 is a Wednesday. */
function utc(weekday: number, hour: number): number {
  const date = new Date(Date.UTC(2026, 9, 21 + (weekday - 3), hour, 30))
  return date.getTime()
}

function usage(overrides: Partial<MessageUsage> = {}): MessageUsage {
  return {
    provider: "opencode-go",
    model: "deepseek-v4-pro",
    at: utc(3, 12),
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    recordedCost: 0,
    ...overrides,
  }
}

test("isPeakHour: the DeepSeek window is 01-04 and 06-10 UTC on weekdays", () => {
  assert.equal(isPeakHour(utc(3, 1)), true)
  assert.equal(isPeakHour(utc(3, 3)), true)
  assert.equal(isPeakHour(utc(3, 6)), true)
  assert.equal(isPeakHour(utc(3, 9)), true)
  assert.equal(isPeakHour(utc(3, 0)), false)
  assert.equal(isPeakHour(utc(3, 4)), false)
  assert.equal(isPeakHour(utc(3, 5)), false)
  assert.equal(isPeakHour(utc(3, 10)), false)
  assert.equal(isPeakHour(utc(3, 23)), false)
})

test("isPeakHour: weekends are always off-peak", () => {
  // Sunday and Saturday.
  assert.equal(isPeakHour(utc(0, 2)), false)
  assert.equal(isPeakHour(utc(6, 7)), false)
  // The same hours on a weekday are peak.
  assert.equal(isPeakHour(utc(3, 2)), true)
  assert.equal(isPeakHour(utc(4, 7)), true)
})

test("ratesFor: a peak-window request bills at exactly twice the base rate", () => {
  const off = ratesFor(usage({ at: utc(3, 12) }))
  const on = ratesFor(usage({ at: utc(3, 2) }))
  assert.ok(off && on)
  assert.equal(on.input, off.input * 2)
  assert.equal(on.output, off.output * 2)
  assert.equal(on.cacheRead, off.cacheRead * 2)
})

test("ratesFor: a non-peaking model is unaffected by the hour", () => {
  const off = ratesFor(usage({ model: "kimi-k3", at: utc(3, 12) }))
  const on = ratesFor(usage({ model: "kimi-k3", at: utc(3, 2) }))
  assert.deepEqual(off, on)
})

test("ratesFor: a context tier switches above its threshold", () => {
  const base = ratesFor(
    usage({ model: "gpt-6-luna", input: 200_000, cacheRead: 50_000 }),
  )
  const over = ratesFor(
    usage({ model: "gpt-6-luna", input: 200_000, cacheRead: 100_000 }),
  )
  assert.ok(base && over)
  assert.equal(base.input, 0.1)
  assert.equal(over.input, 0.2)
  // Exactly at the threshold is still the base tier.
  const edge = ratesFor(usage({ model: "gpt-6-luna", input: 172_000, cacheRead: 100_000 }))
  assert.ok(edge)
  assert.equal(edge.input, 0.1)
})

test("costOf: the formula keeps the four buckets separate", () => {
  const cost = costOf(
    usage({
      input: 1_000_000,
      cacheRead: 1_000_000,
      cacheWrite: 1_000_000,
      output: 1_000_000,
      reasoning: 1_000_000,
    }),
  )
  // 0.66 in + 0.022 cache read + 0 cache write + (1 + 1) * 1.98 out
  assert.ok(cost !== undefined)
  assert.ok(Math.abs(cost - (0.66 + 0.022 + 0 + 3.96)) < 1e-9)
})

test("costOf: reasoning bills at the output rate", () => {
  const withReasoning = costOf(usage({ output: 100, reasoning: 100 }))
  const outputOnly = costOf(usage({ output: 200, reasoning: 0 }))
  assert.ok(withReasoning !== undefined && outputOnly !== undefined)
  assert.ok(Math.abs(withReasoning - outputOnly) < 1e-12)
})

test("costOf: cached input is not charged as fresh input", () => {
  const cached = costOf(usage({ cacheRead: 1_000_000 }))
  const fresh = costOf(usage({ input: 1_000_000 }))
  assert.ok(cached !== undefined && fresh !== undefined)
  assert.ok(Math.abs(cached / fresh - 0.022 / 0.66) < 1e-9)
})

test("costOf: an unpriced model is undefined, not zero", () => {
  assert.equal(costOf(usage({ model: "no-such-model" })), undefined)
  assert.equal(costOf(usage({ provider: "openrouter", model: "some/unknown-route" })), undefined)
})

test("costOf: free-tier models are priced at zero, not reported as unknown", () => {
  // Local Ollama traffic, a Zen free model, and an OpenRouter :free model.
  assert.equal(costOf(usage({ provider: "ollama", model: "qwen3.5:9b-16k" })), 0)
  assert.equal(costOf(usage({ provider: "opencode", model: "big-pickle" })), 0)
  assert.equal(costOf(usage({ provider: "opencode", model: "deepseek-v4.1-flash-free" })), 0)
  assert.equal(costOf(usage({ provider: "openrouter", model: "nvidia/nemotron-3.5-lightning:free" })), 0)
  // Free models that carry no suffix are covered by an explicit list.
  assert.equal(costOf(usage({ provider: "openrouter", model: "stealth/space-bunny-alpha" })), 0)
  assert.equal(costOf(usage({ provider: "opencode", model: "deepseek-v4-flash" })), 0)
  // A paid Zen model is NOT free and stays unpriced.
  assert.equal(costOf(usage({ provider: "opencode", model: "deepseek-v4.1-flash" })), undefined)
})

test("rateFor: free models get zero rates; unknown models get none", () => {
  const free = rateFor("ollama", "qwen3.5:9b-16k")
  assert.ok(free)
  assert.equal(free.base.input, 0)
  assert.equal(free.base.cacheRead, 0)
  assert.equal(rateFor("opencode-go", "no-such-model"), undefined)
  assert.equal(rateFor("openrouter", "some/unknown-route"), undefined)
})

test("rateFor: the reconciled OpenRouter DeepSeek entry is flagged approximate", () => {
  const rate = rateFor("openrouter", "deepseek/deepseek-v4-pro-0813")
  assert.ok(rate)
  assert.equal(rate.approximate, true)
  assert.equal(rate.base.input, 1.32)
  assert.equal(rate.base.cacheRead, 0)
  // A sheet-sourced entry is not flagged.
  const sheet = rateFor("opencode-go", "deepseek-v4-pro")
  assert.ok(sheet)
  assert.equal(sheet.approximate, undefined)
})

test("offPeakCostOf: matches the computed cost outside the peak window", () => {
  const use = usage({ input: 100_000, cacheRead: 900_000, output: 5_000 })
  const computed = costOf(use)
  const offPeak = offPeakCostOf(use)
  assert.ok(computed !== undefined && offPeak !== undefined)
  assert.ok(Math.abs(computed - offPeak) < 1e-12)
})

test("offPeakCostOf: withholds the peak multiplier inside the peak window", () => {
  const use = usage({ at: utc(3, 2), cacheRead: 1_000_000 })
  const computed = costOf(use)
  const offPeak = offPeakCostOf(use)
  assert.ok(computed !== undefined && offPeak !== undefined)
  assert.ok(Math.abs(computed - offPeak * 2) < 1e-12)
})

test("promptTokens: the tier threshold is tested against the full prompt", () => {
  assert.equal(promptTokens(usage({ input: 10, cacheRead: 20, cacheWrite: 30 })), 60)
})

test("aggregate: folds per-model totals and keeps unpriced models visible", () => {
  const totals = aggregate([
    usage({ input: 1_000_000, recordedCost: 0.66 }),
    usage({ at: utc(3, 2), cacheRead: 1_000_000, recordedCost: 0.022 }),
    usage({ provider: "opencode", model: "deepseek-v4.1-flash", input: 500 }),
  ])
  const row = totals.models.find((m) => m.key === "opencode-go/deepseek-v4-pro")
  assert.ok(row)
  assert.equal(row.requests, 2)
  assert.equal(row.peakRequests, 1)
  // Off-peak: 0.66 for the fresh-input request + 0.022 for the cached one.
  // The peak request contributes 0.044 instead of 0.022.
  assert.ok(Math.abs(row.offPeak - 0.682) < 1e-12)
  assert.ok(Math.abs(row.computed - 0.704) < 1e-12)
  assert.equal(row.recorded, 0.682)
  // The paid Zen model has no rate in the table: it is reported, not dropped.
  const zen = totals.models.find((m) => m.key === "opencode/deepseek-v4.1-flash")
  assert.ok(zen)
  assert.equal(zen.unpriced, true)
  assert.equal(totals.unpriced.length, 1)
  assert.equal(totals.unpricedTokens, 500)
  assert.equal(totals.recorded, 0.682)
})

test("aggregate: cached reads are counted at their own (cheaper) rate", () => {
  const totals = aggregate([usage({ cacheRead: 1_000_000 })])
  assert.ok(Math.abs(totals.cachedCost - 0.022) < 1e-12)
  assert.ok(Math.abs(totals.computed - 0.022) < 1e-12)
})
