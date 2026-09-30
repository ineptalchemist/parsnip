import { test } from "node:test"
import assert from "node:assert/strict"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { asContinuity, asSavings, loadSavings, saveSavings, savingsKey, sessionKey } from "./storage.ts"

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
    lastCommand: undefined,
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
    lastCommand: "npm test",
  }
  assert.deepEqual(asContinuity(input), input)
})

// --- savings ledger ---------------------------------------------------------

test("savingsKey: namespaces by session", () => {
  assert.equal(savingsKey("ses_abc"), "session:ses_abc:savings")
})

test("asSavings: rejects non-objects and fills safe defaults", () => {
  assert.deepEqual(asSavings(undefined), { compressions: 0, charsOmitted: 0, dedups: 0, charsDeduped: 0 })
  assert.deepEqual(asSavings(null), { compressions: 0, charsOmitted: 0, dedups: 0, charsDeduped: 0 })
  assert.deepEqual(asSavings([1, 2]), { compressions: 0, charsOmitted: 0, dedups: 0, charsDeduped: 0 })
  assert.deepEqual(asSavings({ compressions: 3, bogus: 9 }), {
    compressions: 3,
    charsOmitted: 0,
    dedups: 0,
    charsDeduped: 0,
  })
})

test("loadSavings / saveSavings: round-trip through storage", async () => {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
  } as unknown as StorageDomain

  assert.deepEqual(await loadSavings(storage, "ses_1"), {
    compressions: 0,
    charsOmitted: 0,
    dedups: 0,
    charsDeduped: 0,
  })

  await saveSavings(storage, "ses_1", { compressions: 2, charsOmitted: 6400, dedups: 1, charsDeduped: 5900 })
  assert.deepEqual(await loadSavings(storage, "ses_1"), {
    compressions: 2,
    charsOmitted: 6400,
    dedups: 1,
    charsDeduped: 5900,
  })

  // A different session has its own tally.
  assert.deepEqual(await loadSavings(storage, "ses_2"), {
    compressions: 0,
    charsOmitted: 0,
    dedups: 0,
    charsDeduped: 0,
  })
})
