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
