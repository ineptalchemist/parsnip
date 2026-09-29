import { test } from "node:test"
import assert from "node:assert/strict"
import { asContinuity, sessionKey } from "./storage.ts"

test("sessionKey: namespaces by session", () => {
  assert.equal(sessionKey("ses_abc"), "session:ses_abc")
})

test("asContinuity: rejects non-objects and arrays", () => {
  assert.equal(asContinuity(undefined), undefined)
  assert.equal(asContinuity(null), undefined)
  assert.equal(asContinuity("nope"), undefined)
  assert.equal(asContinuity([1, 2, 3]), undefined)
})

test("asContinuity: fills safe defaults for a partial record", () => {
  const state = asContinuity({ lastTask: "do a thing", decisions: ["d1"] })
  assert.deepEqual(state, {
    lastTask: "do a thing",
    decisions: ["d1"],
    activeFiles: [],
    agent: undefined,
    tokens: undefined,
    limit: undefined,
    occupancy: undefined,
    updatedAt: undefined,
  })
})

test("asContinuity: preserves a complete record", () => {
  const input = {
    lastTask: "t",
    decisions: ["a", "b"],
    activeFiles: ["x.ts"],
    agent: "build",
    tokens: 10,
    limit: 100,
    occupancy: 0.1,
    updatedAt: 123,
  }
  assert.deepEqual(asContinuity(input), input)
})
