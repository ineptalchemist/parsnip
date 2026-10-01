import { test } from "node:test"
import assert from "node:assert/strict"
import { HEAD_CHARS, TAIL_CHARS } from "../../server/lib/selectors.ts"
import { FACT_CORPUS } from "../facts.ts"
import {
  BANDS,
  FACT_LABELS,
  bandOf,
  pct,
  recover,
  recovery,
  type Fact,
} from "./recovery.ts"

// --- bandOf -----------------------------------------------------------------

test("bandOf: head, middle, tail against the baseline cut", () => {
  const head = "HEADFACT" + "a".repeat(HEAD_CHARS)
  assert.equal(bandOf("HEADFACT", head), "head")

  const middle = "a".repeat(2000) + "MIDFACT" + "a".repeat(2000)
  assert.equal(bandOf("MIDFACT", middle), "middle")

  const tail = "a".repeat(4000) + "TAILFACT"
  assert.equal(bandOf("TAILFACT", tail), "tail")
})

test("bandOf: a fact straddling the head cut is middle", () => {
  const text = "a".repeat(HEAD_CHARS - 2) + "STRADDLE" + "a".repeat(3000)
  assert.equal(bandOf("STRADDLE", text), "middle")
})

test("bandOf: an absent fact falls back to middle", () => {
  assert.equal(bandOf("NOT-PRESENT", "a".repeat(HEAD_CHARS + TAIL_CHARS + 100)), "middle")
})

// --- corpus validation ------------------------------------------------------

test("corpus: every fact is a unique substring of its item", () => {
  for (const item of FACT_CORPUS) {
    for (const fact of item.facts) {
      const first = item.text.indexOf(fact.text)
      assert.ok(first >= 0, `${item.name}: fact not present: ${fact.text}`)
      assert.equal(
        item.text.indexOf(fact.text, first + 1),
        -1,
        `${item.name}: fact not unique: ${fact.text}`,
      )
    }
  }
})

test("corpus: declared bands match bandOf", () => {
  for (const item of FACT_CORPUS) {
    for (const fact of item.facts) {
      assert.equal(
        bandOf(fact.text, item.text),
        fact.band,
        `${item.name}: band mismatch for ${fact.text}`,
      )
    }
  }
})

test("corpus: items sit in the live-valid window and cover all bands", () => {
  for (const item of FACT_CORPUS) {
    assert.ok(item.text.length > 4000, `${item.name}: below the 4000-char gate`)
    assert.ok(item.text.length < 20000, `${item.name}: exceeds native max_bytes`)
    assert.ok(item.text.split("\n").length < 500, `${item.name}: exceeds native max_lines`)
    for (const band of BANDS) {
      assert.ok(
        item.facts.some((f) => f.band === band),
        `${item.name}: no ${band} fact`,
      )
    }
  }
})

test("corpus: every label is exercised somewhere", () => {
  const seen = new Set(FACT_CORPUS.flatMap((item) => item.facts.map((f) => f.label)))
  for (const label of FACT_LABELS) {
    assert.ok(seen.has(label), `no fact labelled ${label}`)
  }
})

// --- recover / recovery -----------------------------------------------------

test("recover: counts facts present in the output", () => {
  const facts: Fact[] = [
    { text: "alpha", label: "value", band: "head" },
    { text: "beta", label: "value", band: "middle" },
    { text: "gamma", label: "value", band: "tail" },
  ]
  assert.equal(recover("alpha gamma", facts), 2)
  assert.equal(recover("nothing here", facts), 0)
})

test("recover: a fact present only as a fragment is not counted", () => {
  const facts: Fact[] = [{ text: "hello world", label: "value", band: "middle" }]
  assert.equal(recover("...hello wor", facts), 0)
})

test("recovery: aggregates by band and label", () => {
  const facts: Fact[] = [
    { text: "a", label: "error", band: "head" },
    { text: "b", label: "error", band: "middle" },
    { text: "c", label: "url", band: "middle" },
  ]
  const report = recovery("a c", facts)
  assert.equal(report.kept, 2)
  assert.equal(report.total, 3)
  assert.deepEqual(report.byBand.head, { kept: 1, total: 1 })
  assert.deepEqual(report.byBand.middle, { kept: 1, total: 2 })
  assert.deepEqual(report.byBand.tail, { kept: 0, total: 0 })
  assert.deepEqual(report.byLabel.error, { kept: 1, total: 2 })
  assert.deepEqual(report.byLabel.url, { kept: 1, total: 1 })
})

test("pct: null for an empty class, a percentage otherwise", () => {
  assert.equal(pct(0, 0), null)
  assert.equal(pct(1, 4), 25)
  assert.equal(pct(3, 3), 100)
})
