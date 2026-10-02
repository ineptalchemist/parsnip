import assert from "node:assert/strict"
import { test } from "node:test"

import {
  invocationsAfter,
  isCompressionEvent,
  rereadFor,
  toolInvocations,
  type AssistantEvent,
} from "./reread.ts"

test("toolInvocations: a text-only message is one invocation", () => {
  assert.equal(toolInvocations(JSON.stringify({ content: [{ type: "text", text: "hi" }] })), 1)
})

test("toolInvocations: K tool parts imply K+1 invocations", () => {
  const parts = [{ type: "text" }, { type: "tool" }, { type: "tool" }, { type: "tool" }]
  assert.equal(toolInvocations(JSON.stringify({ content: parts })), 4)
})

test("toolInvocations: malformed or content-less input is conservative, not zero", () => {
  assert.equal(toolInvocations("not json"), 1)
  assert.equal(toolInvocations(JSON.stringify({})), 1)
  assert.equal(toolInvocations(JSON.stringify({ content: "text" })), 1)
})

test("isCompressionEvent: guards the stored shape", () => {
  assert.equal(isCompressionEvent({ at: 1, omittedChars: 2 }), true)
  assert.equal(isCompressionEvent({ at: 1 }), false)
  assert.equal(isCompressionEvent({ omittedChars: 2 }), false)
  assert.equal(isCompressionEvent(null), false)
  assert.equal(isCompressionEvent("nope"), false)
})

test("invocationsAfter: counts only strictly later messages", () => {
  const timeline: AssistantEvent[] = [
    { at: 10, invocations: 1 },
    { at: 20, invocations: 2 },
    { at: 30, invocations: 3 },
  ]
  assert.equal(invocationsAfter(timeline, 0), 6)
  assert.equal(invocationsAfter(timeline, 10), 5)
  assert.equal(invocationsAfter(timeline, 30), 0)
})

test("rereadFor: an early compression outweighs a late one", () => {
  // 100 messages after each event, one invocation each.
  const timeline: AssistantEvent[] = Array.from({ length: 200 }, (_, i) => ({ at: i, invocations: 1 }))
  const early = rereadFor(timeline, [{ at: 0, omittedChars: 1000 }])
  const late = rereadFor(timeline, [{ at: 190, omittedChars: 1000 }])
  assert.ok(early && late)
  assert.equal(early.charReads, 1000 * 199)
  assert.equal(late.charReads, 1000 * 9)
  // Same bytes removed, wildly different real effect.
  assert.ok(early.multiplier > late.multiplier)
})

test("rereadFor: the multiplier exceeds 1 whenever calls follow", () => {
  const timeline: AssistantEvent[] = Array.from({ length: 50 }, (_, i) => ({ at: i, invocations: 1 }))
  const result = rereadFor(timeline, [{ at: 0, omittedChars: 500 }])
  assert.ok(result)
  assert.equal(result.staticChars, 500)
  assert.equal(result.charReads, 500 * 49)
  assert.equal(result.multiplier, 49)
  assert.equal(result.callsAfter, 49)
})

test("rereadFor: returns null rather than a misleading 1.0x", () => {
  const timeline: AssistantEvent[] = [{ at: 1, invocations: 1 }]
  assert.equal(rereadFor([], [{ at: 0, omittedChars: 100 }]), null)
  assert.equal(rereadFor(timeline, []), null)
  assert.equal(rereadFor(timeline, [{ at: 0, omittedChars: 0 }]), null)
})

test("rereadFor: a trailing compression has no calls after it", () => {
  const timeline: AssistantEvent[] = [{ at: 1, invocations: 1 }]
  const result = rereadFor(timeline, [{ at: 5, omittedChars: 100 }])
  assert.ok(result)
  assert.equal(result.charReads, 0)
  assert.equal(result.multiplier, 0)
})

test("rereadFor: multiple events each get their own tail", () => {
  const timeline: AssistantEvent[] = Array.from({ length: 10 }, (_, i) => ({ at: i, invocations: 1 }))
  const result = rereadFor(timeline, [
    { at: 0, omittedChars: 100 },
    { at: 5, omittedChars: 300 },
  ])
  assert.ok(result)
  // first: 9 calls × 100; second: 4 calls × 300
  assert.equal(result.charReads, 900 + 1200)
  assert.equal(result.staticChars, 400)
  assert.equal(result.multiplier, (900 + 1200) / 400)
})