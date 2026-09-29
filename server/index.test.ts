/**
 * Wiring test: drives the plugin's `setup()` with a fake OpenCode context.
 *
 * This does not prove the SDK signatures are correct (only a live session can
 * do that), but it deterministically proves the hook logic and — critically —
 * the cache-preservation invariant: the `context` hook must not mutate the
 * event, and `compaction` must not take over the summary via `event.result`.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import ctxGuard from "./index.ts"
import { DEDUP_MARKER } from "./lib/toolhooks.ts"

type AnyRecord = Record<string, any>

function makeHarness() {
  const hooks: AnyRecord = {}
  const transforms: Array<(editor: AnyRecord) => void> = []
  const store = new Map<string, unknown>()
  const disposed: string[] = []

  const ctx: AnyRecord = {
    model: {
      transform: async (callback: (editor: AnyRecord) => void) => {
        transforms.push(callback)
        return { dispose: async () => void disposed.push("model.transform") }
      },
      list: async () => ({ data: [] }),
    },
    session: {
      hook: async (name: string, callback: (input: AnyRecord) => unknown) => {
        hooks[name] = callback
        return { dispose: async () => void disposed.push(`session.hook:${name}`) }
      },
    },
    tool: {
      hook: async (name: string, callback: (input: AnyRecord) => unknown) => {
        hooks[name] = callback
        return { dispose: async () => void disposed.push(`tool.hook:${name}`) }
      },
      list: async () => [],
    },
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
      remove: async (key: string) => void store.delete(key),
      scan: async () => ({ entries: [] }),
    },
  }

  return { ctx, hooks, transforms, store, disposed }
}

function contextEvent(overrides: AnyRecord = {}) {
  return {
    sessionID: "ses_test",
    agent: "build",
    model: { providerID: "anthropic", id: "claude-sonnet" },
    system: [{ type: "text", text: "s".repeat(400) }],
    messages: [
      { role: "user", content: [{ type: "text", text: "wire it up" }] },
      { role: "assistant", content: [{ type: "text", text: "m".repeat(800) }] },
    ],
    tools: { bash: { description: "run", input: {} } },
    options: {},
    ...overrides,
  }
}

test("setup registers compaction + context hooks and a model transform", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  assert.equal(typeof h.hooks.compaction, "function")
  assert.equal(typeof h.hooks.context, "function")
  assert.equal(typeof h.hooks["execute.before"], "function")
  assert.equal(typeof h.hooks["execute.after"], "function")
  assert.equal(h.transforms.length, 1)
})

test("setup returns a cleanup that disposes every registration", async () => {
  const h = makeHarness()
  const cleanup = await ctxGuard.setup(h.ctx)
  assert.equal(typeof cleanup, "function")
  await cleanup!()
  assert.deepEqual(h.disposed.sort(), [
    "model.transform",
    "session.hook:compaction",
    "session.hook:context",
    "tool.hook:execute.after",
    "tool.hook:execute.before",
  ])
})

test("context hook: persists an occupancy reading and never mutates the event", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const event = contextEvent()
  const snapshot = JSON.stringify(event)

  await h.hooks.context(event)

  assert.equal(JSON.stringify(event), snapshot, "context hook mutated the event")

  const stored = h.store.get("session:ses_test") as AnyRecord
  assert.ok(stored, "no continuity record written")
  assert.equal(stored.agent, "build")
  assert.ok(stored.tokens > 0)
  assert.ok(stored.occupancy > 0 && stored.occupancy < 1)
  assert.equal(stored.limit, 200_000, "falls back to the default limit")
})

test("context hook: uses the transform-populated model limit", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  h.transforms[0]({
    list: () => [
      { providerID: "anthropic", id: "claude-sonnet", limit: { context: 500_000 } },
    ],
  })

  await h.hooks.context(contextEvent())
  const stored = h.store.get("session:ses_test") as AnyRecord
  assert.equal(stored.limit, 500_000)
})

test("compaction hook: injects the continuity block but does not own the summary", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  // Seed continuity state that the block should pick up.
  await h.ctx.storage.set("session:ses_test", {
    lastTask: "wire the compaction hook",
    decisions: ["keep context read-only"],
    activeFiles: ["server/index.ts"],
  })

  const event = contextEvent()
  await h.hooks.compaction(event)

  assert.equal(event.system.length, 2, "expected exactly one injected system part")
  const injected = event.system[1]
  assert.equal(injected.type, "text")
  assert.match(injected.text, /\[ctx-guard continuity\]/)
  assert.match(injected.text, /Current task: wire the compaction hook/)
  assert.match(injected.text, /keep context read-only/)
  assert.match(injected.text, /Active files: server\/index\.ts/)

  assert.equal(event.result, undefined, "compaction must not take over the summary")
})

test("compaction hook: injects nothing when there is no continuity to carry", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const event = contextEvent({
    messages: [{ role: "assistant", content: [{ type: "text", text: "hi" }] }],
  })
  await h.hooks.compaction(event)

  assert.equal(event.system.length, 1, "no empty continuity part should be pushed")
})

// --- Phase 2: tool hooks ----------------------------------------------------

function toolEvent(overrides: AnyRecord = {}) {
  return {
    tool: "shell",
    sessionID: "ses_test",
    agent: "build",
    messageID: "msg_test",
    id: "call_test",
    input: { command: "printf big" },
    status: "completed",
    result: {
      content: [{ type: "text", text: "x".repeat(6000) }],
      output: { exit: 0, truncated: false },
      metadata: { ok: true },
    },
    ...overrides,
  }
}

test("execute.after: compresses a large shell result, touching only content", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const event = toolEvent()
  const inputSnapshot = JSON.stringify(event.input)
  const outputRef = event.result.output
  const metadataRef = event.result.metadata

  await h.hooks["execute.after"](event)

  const text = (event.result.content as Array<AnyRecord>)[0].text
  assert.match(text, /\[ctx-guard: \d+ chars omitted\]/)
  assert.ok(text.length < 3000, `expected a bounded placeholder, got ${text.length} chars`)
  assert.equal(text.slice(0, 1600), "x".repeat(1600))
  assert.ok(text.endsWith("x".repeat(1200)))
  assert.equal(JSON.stringify(event.input), inputSnapshot, "execute.after mutated event.input")
  assert.equal(event.result.output, outputRef, "structured output must be untouched")
  assert.equal(event.result.metadata, metadataRef, "metadata must be untouched")
})

test("execute.after: leaves small output untouched", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const event = toolEvent({
    result: { content: [{ type: "text", text: "tiny output" }], output: { exit: 0 } },
  })
  const before = JSON.stringify(event.result)
  await h.hooks["execute.after"](event)

  assert.equal(JSON.stringify(event.result), before)
})

test("execute.after: ignores errors and non-target tools", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const failed = toolEvent({ status: "error", error: { message: "boom" } })
  await h.hooks["execute.after"](failed)
  assert.equal((failed.result.content as Array<AnyRecord>)[0].text, "x".repeat(6000))

  const other = toolEvent({ tool: "read" })
  await h.hooks["execute.after"](other)
  assert.equal((other.result.content as Array<AnyRecord>)[0].text, "x".repeat(6000))
})

test("execute.after: suppresses a repeated identical large result", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const first = toolEvent()
  await h.hooks["execute.after"](first)
  assert.match((first.result.content as Array<AnyRecord>)[0].text, /chars omitted/)

  const second = toolEvent()
  await h.hooks["execute.after"](second)
  assert.equal((second.result.content as Array<AnyRecord>)[0].text, DEDUP_MARKER)

  // A different command is not suppressed.
  const third = toolEvent({ input: { command: "printf other" } })
  await h.hooks["execute.after"](third)
  assert.match((third.result.content as Array<AnyRecord>)[0].text, /chars omitted/)
})

test("execute.after: keeps its dedup memory in storage, not module state", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  await h.hooks["execute.after"](toolEvent())
  const history = h.store.get("session:ses_test:toolHistory") as string[]
  assert.equal(history.length, 1)
  assert.ok(history[0].startsWith("shell:"))
})

test("execute.before: records the last command without mutating input", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const event = toolEvent({ input: { command: "npm test --silent" } })
  const inputSnapshot = JSON.stringify(event.input)
  await h.hooks["execute.before"](event)

  assert.equal(JSON.stringify(event.input), inputSnapshot, "execute.before mutated event.input")
  const stored = h.store.get("session:ses_test") as AnyRecord
  assert.equal(stored.lastCommand, "npm test --silent")

  // A non-target tool records nothing.
  const readEvent = toolEvent({ tool: "read", input: { filePath: "/x" } })
  await h.hooks["execute.before"](readEvent)
  const after = h.store.get("session:ses_test") as AnyRecord
  assert.equal(after.lastCommand, "npm test --silent")
})

