import { test } from "node:test"
import assert from "node:assert/strict"
import { buildContinuityBlock, lastUserText, percent, truncate } from "./compaction.ts"

test("truncate: leaves short text alone, ellipsizes long text", () => {
  assert.equal(truncate("short", 10), "short")
  const out = truncate("x".repeat(50), 10)
  assert.equal(out.length, 10)
  assert.ok(out.endsWith("…"))
})

test("percent: formats fractions and handles a non-finite value", () => {
  assert.equal(percent(0.5), "50.0%")
  assert.equal(percent(Number.POSITIVE_INFINITY), "n/a")
})

test("lastUserText: picks the most recent user turn, ignoring assistant turns", () => {
  const messages = [
    { role: "user", content: [{ type: "text", text: "first" }] },
    { role: "assistant", content: [{ type: "text", text: "reply" }] },
    { role: "user", content: [{ type: "text", text: "second" }] },
  ]
  assert.equal(lastUserText(messages), "second")
  assert.equal(lastUserText([]), "")
  assert.equal(lastUserText(undefined), "")
})

test("buildContinuityBlock: returns empty string when there is nothing to inject", () => {
  assert.equal(buildContinuityBlock({}), "")
  assert.equal(buildContinuityBlock({ state: { lastTask: "", decisions: [], activeFiles: [] } }), "")
  // Agent mode alone is noise, not continuity.
  assert.equal(buildContinuityBlock({ agent: "build" }), "")
})

test("buildContinuityBlock: renders agent, task, decisions, files and occupancy", () => {
  const block = buildContinuityBlock({
    agent: "build",
    state: {
      lastTask: "wire the compaction hook",
      decisions: ["keep the context hook read-only", "do not set event.result"],
      activeFiles: ["server/index.ts", "server/lib/compaction.ts"],
      tokens: 4200,
      limit: 200000,
      occupancy: 0.021,
    },
  })

  assert.ok(block.startsWith("[ctx-guard continuity]"))
  assert.match(block, /Agent mode: build/)
  assert.match(block, /Current task: wire the compaction hook/)
  assert.match(block, /Recent decisions:/)
  assert.match(block, /- keep the context hook read-only/)
  assert.match(block, /Active files: server\/index\.ts, server\/lib\/compaction\.ts/)
  assert.match(block, /2\.1%/)
  assert.match(block, /~4200\/200000 tokens/)
})

test("buildContinuityBlock: derives the task from the last user message when state is empty", () => {
  const block = buildContinuityBlock({
    messages: [{ role: "user", content: [{ type: "text", text: "fix the failing test" }] }],
  })
  assert.match(block, /Current task: fix the failing test/)
})
