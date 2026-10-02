import { test } from "node:test"
import assert from "node:assert/strict"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import { appendActiveFile, appendDecision, asContinuity, asSavings, asTokenUsage, describeDecision, filePathOf, loadSavings, loadTokenUsage, saveSavings, saveTokenUsage, savingsKey, sessionKey, tokenUsageFrom, tokenUsageKey } from "./storage.ts"

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
  const empty = { compressions: 0, charsOmitted: 0, dedups: 0, charsDeduped: 0, bySelector: {} }
  assert.deepEqual(asSavings(undefined), empty)
  assert.deepEqual(asSavings(null), empty)
  assert.deepEqual(asSavings([1, 2]), empty)
  assert.deepEqual(asSavings({ compressions: 3, bogus: 9 }), { ...empty, compressions: 3 })
})

test("asSavings: narrows the bySelector breakdown", () => {
  const ledger = asSavings({
    compressions: 1,
    bySelector: {
      "head-tail": { compressions: 1, charsOmitted: 3200, charsKept: 2800 },
      junk: "nope",
    },
  })
  assert.deepEqual(ledger.bySelector, {
    "head-tail": { compressions: 1, charsOmitted: 3200, charsKept: 2800 },
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
    bySelector: {},
  })

  await saveSavings(storage, "ses_1", {
    compressions: 2,
    charsOmitted: 6400,
    dedups: 1,
    charsDeduped: 5900,
    bySelector: { "head-tail": { compressions: 2, charsOmitted: 6400, charsKept: 5600 } },
  })
  assert.deepEqual(await loadSavings(storage, "ses_1"), {
    compressions: 2,
    charsOmitted: 6400,
    dedups: 1,
    charsDeduped: 5900,
    bySelector: { "head-tail": { compressions: 2, charsOmitted: 6400, charsKept: 5600 } },
  })

  // A different session has its own tally.
  assert.deepEqual(await loadSavings(storage, "ses_2"), {
    compressions: 0,
    charsOmitted: 0,
    dedups: 0,
    charsDeduped: 0,
    bySelector: {},
  })
})

// --- token usage ledger -----------------------------------------------------

test("tokenUsageKey: namespaces by session", () => {
  assert.equal(tokenUsageKey("ses_abc"), "session:ses_abc:usage")
})

test("asTokenUsage: rejects non-objects and arrays", () => {
  assert.equal(asTokenUsage(undefined), undefined)
  assert.equal(asTokenUsage(null), undefined)
  assert.equal(asTokenUsage("nope"), undefined)
  assert.equal(asTokenUsage([1, 2, 3]), undefined)
})

test("asTokenUsage: fills safe defaults and drops junk", () => {
  assert.deepEqual(asTokenUsage({ input: 10, bogus: 9, updatedAt: 5 }), {
    input: 10,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: undefined,
    updatedAt: 5,
  })
  assert.deepEqual(asTokenUsage({ input: Number.NaN, cost: "free" }), {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: undefined,
    updatedAt: 0,
  })
})

test("tokenUsageFrom: flattens the nested cache and keeps cost", () => {
  const state = tokenUsageFrom(
    { input: 101689, output: 358, reasoning: 0, cache: { read: 101504, write: 0 } },
    0.42,
    1234,
  )
  assert.deepEqual(state, {
    input: 101689,
    output: 358,
    reasoning: 0,
    cacheRead: 101504,
    cacheWrite: 0,
    cost: 0.42,
    updatedAt: 1234,
  })
})

test("tokenUsageFrom: tolerates missing/malformed payloads", () => {
  assert.deepEqual(tokenUsageFrom(undefined, undefined, 1), {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: undefined,
    updatedAt: 1,
  })
  assert.deepEqual(tokenUsageFrom("nope", "expensive", 2), {
    input: 0,
    output: 0,
    reasoning: 0,
    cacheRead: 0,
    cacheWrite: 0,
    cost: undefined,
    updatedAt: 2,
  })
})

test("loadTokenUsage / saveTokenUsage: round-trip, overwrite is cumulative", async () => {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
  } as unknown as StorageDomain

  assert.equal(await loadTokenUsage(storage, "ses_1"), undefined)

  const first = tokenUsageFrom({ input: 100, output: 5, cache: { read: 40 } }, 0.01, 1)
  await saveTokenUsage(storage, "ses_1", first)
  assert.deepEqual(await loadTokenUsage(storage, "ses_1"), first)

  // The event is cumulative: a later write overwrites with the larger total.
  const second = tokenUsageFrom({ input: 250, output: 12, cache: { read: 180 } }, 0.03, 2)
  await saveTokenUsage(storage, "ses_1", second)
  assert.deepEqual(await loadTokenUsage(storage, "ses_1"), second)

  // A different session is independent.
  assert.equal(await loadTokenUsage(storage, "ses_2"), undefined)
})

// --- continuity derivation (pure) --------------------------------------------

test("filePathOf: reads filePath or path from a file tool, and nothing else", () => {
  assert.equal(filePathOf("read", { filePath: "/a/b.ts" }), "/a/b.ts")
  assert.equal(filePathOf("edit", { path: "/a/b.ts" }), "/a/b.ts")
  assert.equal(filePathOf("READ", { filePath: "/a/b.ts" }), "/a/b.ts", "tool match is case-insensitive")

  // Non-file tools never contribute a path.
  assert.equal(filePathOf("shell", { command: "cat /a/b.ts" }), "")
  assert.equal(filePathOf("grep", { path: "/a" }), "")

  // Junk and empties are rejected rather than recorded.
  assert.equal(filePathOf("read", undefined), "")
  assert.equal(filePathOf("read", null), "")
  assert.equal(filePathOf("read", []), "")
  assert.equal(filePathOf("read", { filePath: 42 }), "")
  assert.equal(filePathOf("read", { filePath: "   " }), "")
})

test("appendActiveFile: dedupes, bounds, and reports no-change", () => {
  assert.deepEqual(appendActiveFile([], "/a"), ["/a"])
  assert.deepEqual(appendActiveFile(["/a"], "/b"), ["/a", "/b"])
  assert.equal(appendActiveFile(["/a"], "/a"), undefined, "a repeat is not a change")
  assert.equal(appendActiveFile([], ""), undefined, "an empty path is not a change")

  // Bounded, oldest evicted first.
  const many = Array.from({ length: 5 }, (_, i) => `/f${i}`)
  assert.deepEqual(appendActiveFile(many, "/f5", 3), ["/f3", "/f4", "/f5"])
})

test("describeDecision: renders only explicit changes", () => {
  assert.equal(
    describeDecision({ compression: true, dedup: false, selector: "extractive" }, "global"),
    "ctx-guard: compression on, dedup off, selector extractive (global)",
  )
  assert.equal(describeDecision({ compression: true }, "session"), "ctx-guard: compression on (session)")
  assert.equal(describeDecision({}, "global", true), "ctx-guard config reset (global)")
  assert.equal(describeDecision({}, "global"), "", "an empty patch is not a decision")
})

test("appendDecision: dedupes, bounds, and reports no-change", () => {
  assert.deepEqual(appendDecision([], "d1"), ["d1"])
  assert.equal(appendDecision(["d1"], "d1"), undefined, "a repeat is not a change")
  assert.equal(appendDecision([], ""), undefined, "an empty decision is not a change")
  assert.deepEqual(appendDecision(["d1", "d2", "d3"], "d4", 2), ["d3", "d4"])
})
