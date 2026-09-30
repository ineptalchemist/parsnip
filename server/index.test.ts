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
import ctxGuard, { guarded } from "./index.ts"
import { COMPRESSION_OPTIONS, DEDUP_MARKER, compressResult, textLengthOf } from "./lib/toolhooks.ts"

type AnyRecord = Record<string, any>

function makeHarness() {
  const hooks: AnyRecord = {}
  const transforms: Array<(editor: AnyRecord) => void> = []
  const mcpTransforms: Array<(editor: AnyRecord) => void> = []
  const skillTransforms: Array<(editor: AnyRecord) => void> = []
  const mcpReloads: string[] = []
  const store = new Map<string, unknown>()
  const disposed: string[] = []

  const mcpServers: AnyRecord[] = []
  const skillCatalog: AnyRecord[] = []

  const ctx: AnyRecord = {
    model: {
      transform: async (callback: (editor: AnyRecord) => void) => {
        transforms.push(callback)
        return { dispose: async () => void disposed.push("model.transform") }
      },
      list: async () => ({ data: [] }),
    },
    mcp: {
      transform: async (callback: (editor: AnyRecord) => void) => {
        mcpTransforms.push(callback)
        return { dispose: async () => void disposed.push("mcp.transform") }
      },
      list: async () => ({ location: null, data: mcpServers }),
      reload: async () => void mcpReloads.push("reload"),
    },
    skill: {
      transform: async (callback: (editor: AnyRecord) => void) => {
        skillTransforms.push(callback)
        return { dispose: async () => void disposed.push("skill.transform") }
      },
      list: async () => ({ location: null, data: skillCatalog }),
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

  return {
    ctx,
    hooks,
    transforms,
    mcpTransforms,
    skillTransforms,
    mcpReloads,
    mcpServers,
    skillCatalog,
    store,
    disposed,
  }
}

/** Drives the MCP transform with a fake editor over `entries`. */
function mcpEditor(entries: Array<[string, AnyRecord]>) {
  const map = new Map(entries.map(([name, config]) => [name, { ...config }]))
  const removed: string[] = []
  return {
    map,
    removed,
    editor: {
      list: () => [...map.entries()],
      get: (name: string) => map.get(name),
      set: (name: string, config: AnyRecord) => void map.set(name, config),
      update: (name: string, update: (config: AnyRecord) => void) => {
        const config = map.get(name)
        assert.ok(config, `mcp editor update for unknown server ${name}`)
        update(config)
      },
      remove: (name: string) => {
        removed.push(name)
        map.delete(name)
      },
    },
  }
}

/** Drives the skill transform with a fake editor. */
function skillEditor(entries: AnyRecord[] = []) {
  return {
    editor: {
      list: () => entries,
      get: (id: string) => entries.find((info) => info.id === id),
      add: (skill: AnyRecord) => void entries.push(skill),
      update: (id: string, update: (skill: AnyRecord) => void) => {
        const info = entries.find((entry) => entry.id === id)
        if (info) update(info)
      },
      remove: () => {
        throw new Error("ctx-guard must never remove a skill")
      },
    },
  }
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
  assert.equal(h.mcpTransforms.length, 1)
  assert.equal(h.skillTransforms.length, 1)
})

test("setup returns a cleanup that disposes every registration", async () => {
  const h = makeHarness()
  const cleanup = await ctxGuard.setup(h.ctx)
  assert.equal(typeof cleanup, "function")
  await cleanup!()
  assert.deepEqual(h.disposed.sort(), [
    "mcp.transform",
    "model.transform",
    "session.hook:compaction",
    "session.hook:context",
    "skill.transform",
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

test("execute.after: records compression + dedup savings in storage, not the event", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const first = toolEvent()
  await h.hooks["execute.after"](first)

  // The second identical call is a duplicate, not a fresh compression.
  const second = toolEvent()
  await h.hooks["execute.after"](second)

  const originalText = "x".repeat(6000)
  const expectedOmitted =
    originalText.length -
    textLengthOf(compressResult({ content: [{ type: "text", text: originalText }] }, COMPRESSION_OPTIONS))

  const savings = h.store.get("session:ses_test:savings") as AnyRecord
  assert.ok(savings, "no savings ledger persisted")
  assert.equal(savings.compressions, 1)
  assert.equal(savings.charsOmitted, expectedOmitted)
  assert.ok(savings.charsOmitted > 3000, "compression should drop the bulk of the middle")

  assert.equal(savings.dedups, 1)
  assert.equal(savings.charsDeduped, originalText.length - DEDUP_MARKER.length)
})

test("execute.after: logs a parseable savings line per event", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const lines: string[] = []
  const original = console.error
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
  try {
    await h.hooks["execute.after"](toolEvent()) // compress
    await h.hooks["execute.after"](toolEvent()) // dedup
  } finally {
    console.error = original
  }

  const joined = lines.join("\n")
  assert.match(joined, /\[ctx-guard\] savings session=ses_test event=compress chars=\d+/)
  assert.match(joined, /\[ctx-guard\] savings session=ses_test event=dedup chars=\d+/)
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

// --- Phase 3: fail-safe hooks ----------------------------------------------

/** Replaces console.error for the duration of `run`, capturing the output. */
async function captureConsoleError(run: () => Promise<void>): Promise<string[]> {
  const original = console.error
  const lines: string[] = []
  console.error = (...args: unknown[]) => void lines.push(args.map(String).join(" "))
  try {
    await run()
  } finally {
    console.error = original
  }
  return lines
}

test("setup wiring: one failing registration cannot break the plugin load", async () => {
  const h = makeHarness()
  // Simulate a domain API that rejects (the class of failure that used to fail
  // the whole plugin load, `failed to load plugin`, and break every session).
  h.ctx.mcp.transform = async () => {
    throw new Error("mcp domain unavailable")
  }

  const lines = await captureConsoleError(async () => {
    await ctxGuard.setup(h.ctx) // must not throw
  })

  assert.match(lines.join("\n"), /\[ctx-guard\] mcp\.transform registration failed \(skipped\)/)
  // Everything else still registered.
  assert.equal(typeof h.hooks.context, "function")
  assert.equal(typeof h.hooks["execute.before"], "function")
  assert.equal(h.transforms.length, 1)
  assert.equal(h.skillTransforms.length, 1)

  // And the surviving hooks still work.
  const event = contextEvent()
  await h.hooks.context(event)
  assert.ok(h.store.has("session:ses_test:structure"))
})

test("guarded: a throwing body never rejects and is logged", async () => {
  const lines = await captureConsoleError(async () => {
    const hook = guarded("test.hook", async () => {
      throw new Error("kaboom")
    })
    await hook()
  })

  assert.equal(lines.length, 1)
  assert.match(lines[0], /\[ctx-guard\] test\.hook failed \(ignored\)/)
  assert.match(lines[0], /kaboom/)
})

test("guarded: passes arguments through and resolves on success", async () => {
  const seen: unknown[] = []
  const hook = guarded("test.hook", async (a: string, b: number) => {
    seen.push(a, b)
  })
  await hook("x", 1)
  assert.deepEqual(seen, ["x", 1])
})

test("guarded: swallows a synchronous throw too", async () => {
  const lines = await captureConsoleError(async () => {
    const hook = guarded("test.sync", () => {
      throw new Error("sync boom")
    })
    await hook()
  })
  assert.match(lines[0], /sync boom/)
})

test("setup wiring: a hook whose storage throws cannot break the session", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  // The context hook does storage work on every request: make that fail.
  h.ctx.storage.set = async () => {
    throw new Error("storage down")
  }
  h.ctx.storage.get = async () => {
    throw new Error("storage down")
  }

  const event = contextEvent()
  const snapshot = JSON.stringify(event)
  const lines = await captureConsoleError(async () => {
    await h.hooks.context(event) // must not reject
    await h.hooks["execute.before"](toolEvent())
    await h.hooks["execute.after"](toolEvent())
  })

  assert.equal(JSON.stringify(event), snapshot, "a failed hook must not touch the event")
  assert.ok(lines.length >= 3, `expected every hook to log its failure, got ${lines.length}`)
  assert.ok(lines.every((line) => line.includes("[ctx-guard]")))
})

// --- Phase 3: structural report --------------------------------------------

function seedCatalog(h: ReturnType<typeof makeHarness>) {
  h.mcpServers.push(
    { name: "basic-memory", status: { status: "connected" } },
    { name: "firecrawl", status: { status: "connected" } },
    { name: "filterboy", status: { status: "failed", error: "spawn failed" } },
    { name: "n8n", status: { status: "failed", error: "unreachable" } },
    { name: "parallel", status: { status: "connected" } },
  )
  h.skillCatalog.push(
    { id: "opencode", name: "OpenCode", description: "", path: "/builtin/opencode.md", content: "" },
    { id: "report", name: "Report", description: "", path: "/builtin/report.md", content: "" },
  )
}

test("mcp/skill transforms snapshot the catalog read-only", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const { map, removed, editor } = mcpEditor([
    ["basic-memory", { type: "local", command: ["basic-memory", "mcp"] }],
    ["filterboy", { type: "local", command: ["filterboy-mcp"] }],
    ["parallel", { type: "remote", url: "https://search.parallel.ai/mcp", oauth: false }],
  ])
  h.mcpTransforms[0](editor)

  assert.equal(map.size, 3)
  assert.deepEqual(removed, [], "the transform must never remove a server")

  const { editor: skills } = skillEditor([
    { id: "opencode", name: "OpenCode", path: "/builtin/opencode.md", content: "x" },
  ])
  h.skillTransforms[0](skills)
})

test("context hook: persists the structure report with real usage and status", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)
  seedCatalog(h)

  h.mcpTransforms[0](
    mcpEditor([
      ["basic-memory", { type: "local" }],
      ["filterboy", { type: "local" }],
      ["parallel", { type: "remote", url: "x" }],
    ]).editor,
  )
  h.skillTransforms[0](
    skillEditor([{ id: "opencode", name: "OpenCode", path: "/builtin/opencode.md", content: "x" }])
      .editor,
  )

  // Usage: one tool from basic-memory.
  await h.hooks["execute.before"](toolEvent({ tool: "basic-memory_recent_activity" }))

  const event = contextEvent()
  const snapshot = JSON.stringify(event)
  await h.hooks.context(event)
  assert.equal(JSON.stringify(event), snapshot, "context hook must stay read-only")

  const report = h.store.get("session:ses_test:structure") as AnyRecord
  assert.ok(report, "no structure report persisted")
  assert.ok(report.computedAt > 0)

  const names = report.servers.map((server: AnyRecord) => server.name)
  assert.ok(!names.includes("basic-memory"), "a used server must drop out of the report")
  assert.ok(names.includes("filterboy"), "an unusable server must be reported")

  const filterboy = report.servers.find((server: AnyRecord) => server.name === "filterboy")
  assert.equal(filterboy.unusable, true)
  assert.equal(filterboy.status, "failed")
  assert.equal(filterboy.used, false)

  assert.deepEqual(
    report.skills.map((skill: AnyRecord) => skill.id),
    ["opencode"],
  )
})

test("execute.before: records tool + skill usage in storage, not module state", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)
  seedCatalog(h)

  await h.hooks["execute.before"](toolEvent({ tool: "skill", input: { id: "systematic-debugging" } }))
  assert.deepEqual(h.store.get("session:ses_test:toolUsage"), ["skill"])
  assert.deepEqual(h.store.get("session:ses_test:skillUsage"), ["systematic-debugging"])

  // A repeated call does not grow the sets.
  await h.hooks["execute.before"](toolEvent({ tool: "skill", input: { id: "systematic-debugging" } }))
  assert.deepEqual(h.store.get("session:ses_test:skillUsage"), ["systematic-debugging"])
})

test("structure report: keys are per session and default to report-only", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  await h.hooks["execute.before"](toolEvent({ tool: "shell" }))
  assert.ok(h.store.has("session:ses_test:structure"))
  assert.ok(!h.store.has("session:ses_test:prune.diff"), "nothing may be pruned by default")
  assert.deepEqual(h.mcpReloads, [], "no config reload may happen by default")
})

test("prune path stays inert without the owner's approval flag", async () => {
  const h = makeHarness()
  await ctxGuard.setup(h.ctx)

  const { map, removed, editor } = mcpEditor([
    ["filterboy", { type: "local" }],
    ["n8n", { type: "remote", url: "x" }],
  ])
  h.mcpTransforms[0](editor)

  assert.deepEqual([...map.values()], [{ type: "local" }, { type: "remote", url: "x" }])
  assert.deepEqual(removed, [])
  assert.ok(!h.store.has("session:ses_test:prune.diff"))
})

