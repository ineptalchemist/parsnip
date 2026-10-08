import { test } from "node:test"
import assert from "node:assert/strict"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import {
  ATTRIBUTION_TOOL_LIMIT,
  SNAPSHOT_TOOL_LIMIT,
  UNATTRIBUTED_TOOL,
  asAttributionLedger,
  asContextSnapshot,
  attributionKey,
  buildSnapshot,
  cleanToolName,
  emptyLedger,
  enqueue,
  estimatedTokensOf,
  formatAttributionReport,
  loadAttribution,
  loadSnapshot,
  recordAttribution,
  recordResult,
  saveAttribution,
  saveSnapshot,
  snapshotInputFromContext,
  snapshotKey,
} from "./attribution.ts"

// --- ledger ------------------------------------------------------------------

test("recordResult: accumulates per-tool counters and keeps tools independent", () => {
  let ledger = emptyLedger(1)
  ledger = recordResult(ledger, { tool: "shell", observedChars: 9000, retainedChars: 3000, compressed: true }, 2)
  ledger = recordResult(ledger, { tool: "read", observedChars: 5000, retainedChars: 5000 }, 3)
  ledger = recordResult(ledger, { tool: "shell", observedChars: 1000, retainedChars: 1000 }, 4)

  assert.equal(ledger.tools.shell.calls, 2)
  assert.equal(ledger.tools.shell.nonEmptyResults, 2)
  assert.equal(ledger.tools.shell.observedChars, 10000)
  assert.equal(ledger.tools.shell.retainedChars, 4000)
  assert.equal(ledger.tools.shell.omittedChars, 6000)
  assert.equal(ledger.tools.shell.compressionCount, 1)
  assert.equal(ledger.tools.read.calls, 1)
  assert.equal(ledger.tools.read.observedChars, 5000)
  assert.equal(ledger.tools.read.omittedChars, 0)
  assert.equal(ledger.updatedAt, 4)
  assert.equal(ledger.droppedTools, 0)
})

test("recordResult: counts compression and dedup events, clamps omitted at zero", () => {
  let ledger = emptyLedger()
  ledger = recordResult(ledger, {
    tool: "shell",
    observedChars: 100,
    retainedChars: 120,
    compressed: true,
    deduped: true,
  })
  assert.equal(ledger.tools.shell.omittedChars, 0)
  assert.equal(ledger.tools.shell.retainedChars, 120)
  assert.equal(ledger.tools.shell.compressionCount, 1)
  assert.equal(ledger.tools.shell.dedupCount, 1)
})

test("recordResult: blank tool names land in the (unknown) bucket", () => {
  const ledger = recordResult(emptyLedger(), { tool: "   ", observedChars: 4, retainedChars: 4 })
  assert.deepEqual(Object.keys(ledger.tools), ["(unknown)"])
  assert.equal(ledger.tools["(unknown)"].calls, 1)
})

test("recordResult: evicts the smallest tool past the bound and counts the eviction", () => {
  let ledger = emptyLedger()
  for (let i = 1; i <= ATTRIBUTION_TOOL_LIMIT; i += 1) {
    ledger = recordResult(ledger, { tool: `tool-${i}`, observedChars: i, retainedChars: i })
  }
  assert.equal(Object.keys(ledger.tools).length, ATTRIBUTION_TOOL_LIMIT)

  ledger = recordResult(ledger, { tool: "hot", observedChars: 1_000_000, retainedChars: 0 })
  assert.equal(Object.keys(ledger.tools).length, ATTRIBUTION_TOOL_LIMIT)
  assert.equal(ledger.tools["tool-1"], undefined, "the smallest row is evicted")
  assert.ok(ledger.tools.hot)
  assert.equal(ledger.droppedTools, 1)
})

test("asAttributionLedger: rejects junk and narrows a partial record", () => {
  const rejected = asAttributionLedger(undefined)
  assert.deepEqual(rejected.tools, {})
  assert.equal(rejected.droppedTools, 0)
  assert.deepEqual(asAttributionLedger(null).tools, {})
  assert.deepEqual(asAttributionLedger([1, 2]).tools, {})
  assert.deepEqual(asAttributionLedger("nope").tools, {})

  const ledger = asAttributionLedger({
    tools: {
      shell: { calls: "x", observedChars: -5, retainedChars: 3.9, bogus: 1 },
      bad: "nope",
      read: null,
    },
    droppedTools: "y",
    updatedAt: 123,
  })
  assert.deepEqual(ledger.tools.shell, {
    calls: 0,
    nonEmptyResults: 0,
    observedChars: 0,
    retainedChars: 3,
    omittedChars: 0,
    compressionCount: 0,
    dedupCount: 0,
  })
  assert.deepEqual(Object.keys(ledger.tools), ["shell"])
  assert.equal(ledger.droppedTools, 0)
  assert.equal(ledger.updatedAt, 123)
})

test("asAttributionLedger: re-enforces the tool bound on load", () => {
  const tools: Record<string, unknown> = {}
  for (let i = 1; i <= ATTRIBUTION_TOOL_LIMIT + 10; i += 1) {
    tools[`t${i}`] = { calls: 1, observedChars: i }
  }
  const ledger = asAttributionLedger({ tools })
  assert.equal(Object.keys(ledger.tools).length, ATTRIBUTION_TOOL_LIMIT)
  assert.equal(ledger.droppedTools, 10)
  assert.equal(ledger.tools.t1, undefined)
  assert.ok(ledger.tools[`t${ATTRIBUTION_TOOL_LIMIT + 10}`])
})

// --- snapshot ----------------------------------------------------------------

test("buildSnapshot: merges duplicate tool rows, sorts by chars, keeps the total exact", () => {
  const snapshot = buildSnapshot(
    {
      systemChars: 40000,
      userChars: 4000,
      assistantChars: 8000,
      reasoningChars: 0,
      toolResults: [
        { tool: "shell", chars: 8000 },
        { tool: "read", chars: 1000 },
        { tool: "shell", chars: 1000 },
        { tool: UNATTRIBUTED_TOOL, chars: 500 },
        { tool: "empty", chars: 0 },
      ],
      catalogueChars: 2000,
    },
    7,
  )
  assert.deepEqual(snapshot.toolResults, [
    { tool: "shell", chars: 9000 },
    { tool: "read", chars: 1000 },
    { tool: UNATTRIBUTED_TOOL, chars: 500 },
  ])
  assert.equal(snapshot.toolTotalChars, 10500)
  assert.equal(snapshot.totalChars, 40000 + 4000 + 8000 + 0 + 10500 + 2000)
  assert.equal(snapshot.toolOverflowCount, 0)
  assert.equal(snapshot.toolOverflowChars, 0)
  assert.equal(snapshot.updatedAt, 7)
})

test("buildSnapshot: folds rows past the snapshot bound into the overflow figure", () => {
  const entries = Array.from({ length: SNAPSHOT_TOOL_LIMIT + 3 }, (_, i) => ({
    tool: `tool-${i + 1}`,
    chars: i + 1,
  }))
  const snapshot = buildSnapshot({
    systemChars: 0,
    userChars: 0,
    assistantChars: 0,
    reasoningChars: 0,
    toolResults: entries,
    catalogueChars: 0,
  })
  assert.equal(snapshot.toolResults.length, SNAPSHOT_TOOL_LIMIT)
  assert.equal(snapshot.toolOverflowCount, 3)
  assert.equal(snapshot.toolOverflowChars, 1 + 2 + 3)
  const total = entries.reduce((sum, entry) => sum + entry.chars, 0)
  assert.equal(snapshot.toolTotalChars, total)
  assert.equal(snapshot.totalChars, total)
})

// --- formatter ---------------------------------------------------------------

function sampleLedger() {
  let ledger = emptyLedger(1)
  ledger = recordResult(ledger, { tool: "shell", observedChars: 9000, retainedChars: 3000, compressed: true, deduped: false }, 2)
  ledger = recordResult(ledger, { tool: "shell", observedChars: 0, retainedChars: 0, compressed: true }, 3)
  ledger = recordResult(ledger, { tool: "shell", observedChars: 0, retainedChars: 0 }, 4)
  ledger = recordResult(ledger, { tool: "read", observedChars: 5000, retainedChars: 5000 }, 5)
  return ledger
}

test("formatAttributionReport: renders all three blocks with the honesty labels", () => {
  const snapshot = buildSnapshot(
    {
      systemChars: 40000,
      userChars: 4000,
      assistantChars: 8000,
      reasoningChars: 0,
      toolResults: [
        { tool: "shell", chars: 8000 },
        { tool: "read", chars: 2000 },
        { tool: UNATTRIBUTED_TOOL, chars: 500 },
      ],
      catalogueChars: 2000,
    },
    1,
  )
  const out = formatAttributionReport({
    snapshot,
    ledger: sampleLedger(),
    usage: {
      input: 156297,
      output: 31389,
      reasoning: 28405,
      cacheRead: 1808128,
      cacheWrite: 12000,
      cost: 0.043687,
      updatedAt: 1,
    },
  })

  assert.match(out, /exact chars \(observed\)/)
  assert.match(out, /Current request \(last outgoing context\)/)
  assert.match(out, /~16,125 tok/)
  assert.match(out, /tool results\s+~2,625 tok\s+16\.3%/)
  assert.match(out, /\(unattributed\)\s+~125 tok/)
  assert.match(out, /Session tool ledger \(observed chars, exact/)
  assert.match(out, /shell\s+3\s+9,000\s+3,000\s+6,000\s+2\s+0\s+64\.3%/)
  assert.match(out, /cache hit rate 91\.5%/)
  assert.match(out, /cost \$0\.043687/)
  assert.match(out, /authoritative/)
})

test("formatAttributionReport: empty states are explicit, not silently blank", () => {
  const out = formatAttributionReport({ snapshot: null, ledger: emptyLedger(), usage: null })
  assert.match(out, /no snapshot captured yet/)
  assert.match(out, /no completed tool calls observed yet/)
  assert.match(out, /no session\.usage\.updated recorded for this session yet/)
})

test("formatAttributionReport: sections not requested are omitted entirely", () => {
  const out = formatAttributionReport({ ledger: sampleLedger() })
  assert.ok(!out.includes("Current request"))
  assert.ok(!out.includes("Provider totals"))
  assert.match(out, /Session tool ledger/)
})

test("formatAttributionReport: respects topN and reports the remainder", () => {
  let ledger = emptyLedger()
  for (let i = 1; i <= 12; i += 1) {
    ledger = recordResult(ledger, { tool: `tool-${i}`, observedChars: i * 100, retainedChars: 0 })
  }
  const out = formatAttributionReport({ ledger }, { topN: 3 })
  const rows = out.split("\n").filter((line) => /^ {2}tool-\d+\s/.test(line))
  assert.equal(rows.length, 3)
  assert.match(out, /9 more tool\(s\)/)
})

test("formatAttributionReport: reports evictions honestly", () => {
  const out = formatAttributionReport({ ledger: { tools: {}, droppedTools: 3, updatedAt: 0 } })
  assert.match(out, /3 tool row\(s\) evicted by the retention bound/)
})

// --- storage helpers ---------------------------------------------------------

test("attributionKey / loadAttribution / saveAttribution: round-trip, junk-safe", async () => {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
  } as unknown as StorageDomain

  assert.equal(attributionKey("ses_1"), "session:ses_1:attribution")

  const empty = await loadAttribution(storage, "ses_1")
  assert.deepEqual(empty.tools, {})
  assert.equal(empty.droppedTools, 0)

  const folded = recordResult(empty, { tool: "shell", observedChars: 10, retainedChars: 4 })
  await saveAttribution(storage, "ses_1", folded)
  const loaded = await loadAttribution(storage, "ses_1")
  assert.equal(loaded.tools.shell.calls, 1)
  assert.equal(loaded.tools.shell.observedChars, 10)

  // Malformed stored values narrow to an empty ledger instead of throwing.
  await storage.set(attributionKey("ses_2"), "junk")
  assert.deepEqual((await loadAttribution(storage, "ses_2")).tools, {})
})

// --- capture helpers ---------------------------------------------------------

test("enqueue: serializes per key, survives a rejection, and cleans up", async () => {
  const chains = new Map<string, Promise<void>>()
  const order: string[] = []
  const task = (label: string, ms: number) => async () => {
    await new Promise((resolve) => setTimeout(resolve, ms))
    order.push(label)
  }

  await Promise.all([enqueue(chains, "ses_1", task("a", 8)), enqueue(chains, "ses_1", task("b", 1))])
  assert.deepEqual(order, ["a", "b"], "work runs in chain order, not duration order")

  const failed = enqueue(chains, "ses_1", async () => {
    throw new Error("boom")
  })
  await assert.rejects(failed, /boom/)
  await enqueue(chains, "ses_1", async () => void order.push("c"))
  assert.equal(order.at(-1), "c", "a rejected task does not break the chain")

  await Promise.all([
    enqueue(chains, "ses_2", task("slow", 8)),
    enqueue(chains, "ses_3", task("fast", 1)),
  ])
  assert.ok(
    order.indexOf("fast") < order.indexOf("slow"),
    "different keys do not serialize against each other",
  )

  await new Promise((resolve) => setTimeout(resolve, 5))
  assert.equal(chains.size, 0, "drained chains are removed")
})

test("recordAttribution: concurrent folds for one session both land", async () => {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      return store.get(key)
    },
    set: async (key: string, value: unknown) => {
      await new Promise((resolve) => setTimeout(resolve, 2))
      void store.set(key, value)
    },
  } as unknown as StorageDomain
  const chains = new Map<string, Promise<void>>()

  await Promise.all([
    recordAttribution(storage, chains, {
      sessionID: "ses_1",
      tool: "read",
      observedChars: 10,
      retainedChars: 10,
    }),
    recordAttribution(storage, chains, {
      sessionID: "ses_1",
      tool: "shell",
      observedChars: 20,
      retainedChars: 5,
      compressed: true,
    }),
  ])

  const ledger = await loadAttribution(storage, "ses_1")
  assert.equal(ledger.tools.read.calls, 1)
  assert.equal(ledger.tools.shell.calls, 1)
  assert.equal(ledger.tools.shell.compressionCount, 1)
  assert.equal(ledger.tools.shell.omittedChars, 15)
})

// --- helpers -----------------------------------------------------------------

test("estimatedTokensOf: ceil(chars/4), zero-safe, junk-safe", () => {
  assert.equal(estimatedTokensOf(0), 0)
  assert.equal(estimatedTokensOf(1), 1)
  assert.equal(estimatedTokensOf(40000), 10000)
  assert.equal(estimatedTokensOf(-5), 0)
})

test("cleanToolName: trims, and blanks land in (unknown)", () => {
  assert.equal(cleanToolName(" shell "), "shell")
  assert.equal(cleanToolName(""), "(unknown)")
  assert.equal(cleanToolName(undefined), "(unknown)")
})

// --- request snapshot extraction --------------------------------------------

test("snapshotInputFromContext: classifies roles and part types into bins", () => {
  const input = snapshotInputFromContext({
    system: [{ type: "text", text: "s".repeat(100) }],
    messages: [
      { role: "user", content: [{ type: "text", text: "u".repeat(50) }, { type: "media", media: {} }] },
      {
        role: "assistant",
        content: [
          { type: "text", text: "a".repeat(30) },
          { type: "reasoning", text: "r".repeat(20) },
          { type: "tool-call", id: "c1", name: "shell", input: { command: "ls" } },
          { type: "tool-result", id: "c1", name: "shell", result: { type: "text", value: "x".repeat(400) } },
          {
            type: "tool-result",
            id: "c2",
            name: "read",
            result: {
              type: "content",
              value: [
                { type: "text", text: "y".repeat(200) },
                { type: "file", uri: "f", mime: "m" },
              ],
            },
          },
        ],
      },
      { role: "tool", content: [{ type: "tool-result", id: "c3", name: "websearch", result: { type: "json", value: "j".repeat(60) } }] },
    ],
    tools: { shell: { description: "run", input: {} } },
  })

  assert.equal(input.systemChars, 100)
  assert.equal(input.userChars, 50 + "[media]".length)
  assert.equal(input.assistantChars, 30, "tool-call arguments are deliberately skipped")
  assert.equal(input.reasoningChars, 20)
  assert.deepEqual(input.toolResults, [
    { tool: "shell", chars: 400 },
    { tool: "read", chars: 200 + "[file]".length },
    { tool: "websearch", chars: 60 },
  ])
  assert.equal(
    input.catalogueChars,
    JSON.stringify({ shell: { description: "run", input: {} } }).length,
  )
})

test("snapshotInputFromContext: unnamed results and odd shapes land safely", () => {
  const input = snapshotInputFromContext({
    system: ["plain string part", { text: "obj text" }, { type: "text" }, 42],
    messages: [
      { role: "assistant", content: [{ type: "tool-result", id: "c", result: { type: "json", value: { a: "b" } } }] },
      { role: "user", content: [{ type: "text", text: "u" }] },
      { role: "nonsense", content: [{ type: "text", text: "skip me" }] },
      "junk",
    ],
  })
  assert.equal(input.systemChars, "plain string part".length + "obj text".length)
  assert.equal(input.userChars, 1)
  assert.equal(input.assistantChars, 0)
  assert.deepEqual(input.toolResults, [
    { tool: UNATTRIBUTED_TOOL, chars: JSON.stringify({ a: "b" }).length },
  ])
  assert.equal(input.catalogueChars, 0, "no tools record means no catalogue chars")
})

test("snapshotKey / loadSnapshot / saveSnapshot / asContextSnapshot: round-trip, junk-safe", async () => {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
  } as unknown as StorageDomain

  assert.equal(snapshotKey("ses_1"), "session:ses_1:snapshot")
  assert.equal(await loadSnapshot(storage, "ses_1"), undefined)

  const snapshot = buildSnapshot({
    systemChars: 10,
    userChars: 20,
    assistantChars: 30,
    reasoningChars: 40,
    toolResults: [{ tool: "shell", chars: 50 }],
    catalogueChars: 60,
  })
  await saveSnapshot(storage, "ses_1", snapshot)
  assert.deepEqual(await loadSnapshot(storage, "ses_1"), snapshot)

  await storage.set(snapshotKey("ses_2"), "junk")
  assert.equal(await loadSnapshot(storage, "ses_2"), undefined)

  const narrowed = asContextSnapshot({
    systemChars: -5,
    toolResults: [{ tool: "read", chars: 7 }, { tool: "", chars: 3 }, "nope", { tool: "x", chars: 0 }],
  })
  assert.ok(narrowed)
  assert.equal(narrowed.systemChars, 0)
  assert.deepEqual(narrowed.toolResults, [
    { tool: "read", chars: 7 },
    { tool: UNATTRIBUTED_TOOL, chars: 3 },
  ])
})
