import assert from "node:assert/strict"
import { test } from "node:test"

import { CORPUS, SMALL_CORPUS } from "./corpus.ts"
import { MIN_CHARS, SELECTORS, budgetFor } from "../server/lib/selectors.ts"

/**
 * The sweep (`bench/threshold.ts`) is only meaningful while SMALL_CORPUS stays
 * below the default gate. If a future edit grows an item past 4000 chars, every
 * item engages at every threshold, the marginal columns flatten, and the sweep
 * reports a conclusion that no longer follows — silently, because it still prints
 * a table. These tests are the tripwire for that.
 */

test("CORPUS: every item is above the default gate, as documented", () => {
  for (const item of CORPUS) {
    assert.ok(
      item.text.length > MIN_CHARS,
      `${item.name} is ${item.text.length} chars, at or below the ${MIN_CHARS} gate`,
    )
  }
})

test("SMALL_CORPUS: every item is below the default gate", () => {
  for (const item of SMALL_CORPUS) {
    assert.ok(
      item.text.length <= MIN_CHARS,
      `${item.name} is ${item.text.length} chars, above the ${MIN_CHARS} gate — the sweep's marginal half is now vacuous`,
    )
  }
})

test("SMALL_CORPUS: engagement gradients across thresholds, so a knee is visible", () => {
  // The sweep reads a trend, so the corpus must engage DIFFERENTLY at different
  // thresholds. The property that matters is not raw char spread but that the
  // engaged-count falls as the gate rises - a corpus clustered at one size would
  // report a flat line and invite a conclusion that does not follow.
  const engagedAt = (threshold: number): number =>
    SMALL_CORPUS.filter(
      (i) => SELECTORS["head-tail"].select(i.text, threshold).length < i.text.length,
    ).length

  const atDefault = engagedAt(MIN_CHARS)
  const atFloor = engagedAt(800)

  assert.equal(atDefault, 0, "the corpus must sit entirely below the default gate")
  assert.ok(atFloor > 0, "the corpus must engage at the lowest threshold")

  for (const threshold of [1200, 1500, 2000, 2500, 2800, 3200]) {
    const engaged = engagedAt(threshold)
    assert.ok(
      engaged <= atFloor && engaged >= atDefault,
      `threshold ${threshold} engaged ${engaged}, outside [${atDefault}, ${atFloor}]`,
    )
  }

  // And it must actually vary, not sit flat.
  const distinct = new Set([800, 1200, 1500, 2000, 2500, 2800, 3200, 4000].map(engagedAt))
  assert.ok(distinct.size >= 4, `engagement only takes ${distinct.size} distinct values; too flat`)
})

test("SMALL_CORPUS: names carry their real length, so the table can be trusted", () => {
  for (const item of SMALL_CORPUS) {
    const stated = /\((\d+)\)/.exec(item.name)
    assert.ok(stated, `${item.name} does not state its length`)
    assert.equal(
      Number(stated[1]),
      item.text.length,
      `${item.name} claims ${stated[1]} chars but is ${item.text.length}`,
    )
  }
})

test("the threshold, not the budget, is the effective floor", () => {
  // Guards a claim the sweep prints. The derived budget is 0.7 x the threshold,
  // which is strictly BELOW the threshold, so the gate is what binds: the
  // smallest input that compacts is threshold+1, not the head+tail total.
  //
  // The distinction matters. When the budget was frozen at 2800 against a 4000
  // gate, the BUDGET bound and the floor sat at 2800 - which is exactly the bug
  // the derivation fixed. Reading "effective floor = 0.7 x threshold" would be a
  // second, subtler version of the same mistake.
  for (const threshold of [800, 1200, 1500, 2000, 2800, 4000]) {
    const compacts = (length: number): boolean =>
      SELECTORS["head-tail"].select("a".repeat(length), threshold).length < length

    assert.ok(compacts(threshold + 1), `threshold ${threshold}: above the gate did not compact`)
    assert.equal(compacts(threshold), false, `threshold ${threshold}: the gate itself compacted`)

    const budget = budgetFor(threshold).headChars + budgetFor(threshold).tailChars
    assert.ok(budget < threshold, `budget ${budget} is not below the gate ${threshold}`)
    assert.equal(compacts(budget + 10), false, `threshold ${threshold}: compacted below the gate`)
  }
})
