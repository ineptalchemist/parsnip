import { test } from "node:test"
import assert from "node:assert/strict"
import {
  computeOccupancy,
  estimateTokens,
  measureContext,
  partText,
  safeJson,
} from "./quality.ts"

test("estimateTokens: empty string is zero, otherwise rounds up at 4 chars/token", () => {
  assert.equal(estimateTokens(""), 0)
  assert.equal(estimateTokens("a"), 1)
  assert.equal(estimateTokens("abcd"), 1)
  assert.equal(estimateTokens("abcde"), 2)
  assert.equal(estimateTokens("a".repeat(400)), 100)
})

test("computeOccupancy: guards against a zero or negative limit", () => {
  const zero = computeOccupancy(100, 0)
  assert.equal(zero.tokens, 100)
  assert.equal(zero.limit, 0)
  assert.ok(Number.isNaN(zero.occupancy), "unknown limit should report NaN, not a fraction")

  const negative = computeOccupancy(100, -5)
  assert.ok(Number.isNaN(negative.occupancy))

  const normal = computeOccupancy(500, 1000)
  assert.equal(normal.occupancy, 0.5)
})

test("safeJson: never throws on circular or unserializable values", () => {
  const circular: Record<string, unknown> = {}
  circular.self = circular
  assert.equal(safeJson(circular), "[unserializable]")
  assert.equal(safeJson(undefined), "")
  assert.equal(safeJson({ a: 1 }), '{"a":1}')
})

test("partText: extracts text, marks media, serializes tool payloads", () => {
  assert.equal(partText({ type: "text", text: "hello" }), "hello")
  assert.equal(partText({ type: "media", media: {} }), "[media]")
  assert.equal(partText({ type: "tool-call", input: { cmd: "ls" } }), '{"cmd":"ls"}')
  assert.equal(partText({ type: "tool-result", result: "ok" }), '"ok"')
  assert.equal(partText(null), "")
  assert.equal(partText("raw"), "raw")
})

test("measureContext: sums system, messages and tool names without mutating input", () => {
  const event = {
    system: [{ type: "text", text: "a".repeat(40) }],
    messages: [
      { role: "user", content: [{ type: "text", text: "b".repeat(40) }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "c".repeat(40) },
          { type: "tool-call", input: { path: "x" } },
        ],
      },
    ],
    tools: { bash: {}, read: {} },
  }

  const snapshot = JSON.stringify(event)
  const reading = measureContext(event, 1000)

  // Non-zero, bounded, and the event is untouched (cache-preservation invariant).
  assert.ok(reading.tokens > 0)
  assert.ok(reading.occupancy > 0 && reading.occupancy < 1)
  assert.equal(reading.limit, 1000)
  assert.equal(JSON.stringify(event), snapshot)
})

test("measureContext: tolerates an empty request", () => {
  const reading = measureContext({}, 100_000)
  assert.equal(reading.tokens, 0)
  assert.equal(reading.occupancy, 0)
})
