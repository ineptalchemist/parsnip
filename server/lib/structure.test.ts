/**
 * Unit tests for the Phase 3 structural-cleanup logic (pure functions + the
 * storage helpers). No OpenCode runtime is involved; the storage domain is a
 * tiny in-memory fake.
 */
import { test } from "node:test"
import assert from "node:assert/strict"
import {
  PRUNE_OPTIONS,
  SKILL_USAGE_LIMIT,
  STRUCTURE_PRUNE_ENABLED,
  applyPrunePlan,
  appendUsage,
  asStringArray,
  asStructureReport,
  asToolUsage,
  buildPrunePlan,
  classifyServers,
  classifySkills,
  computeReport,
  loadUsage,
  recordToolUsage,
  skillIdOf,
  structureKey,
  toolBelongsToServer,
  toolUsageKey,
  type ServerEntry,
  type SkillEntry,
  type StructureReport,
} from "./structure.ts"

function makeStorage() {
  const store = new Map<string, unknown>()
  return {
    store,
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
    remove: async (key: string) => void store.delete(key),
    scan: async () => ({ entries: [] }),
  }
}

const servers: ServerEntry[] = [
  { name: "basic-memory", type: "local", disabled: false, status: "connected" },
  { name: "firecrawl", type: "remote", disabled: false, status: "connected" },
  { name: "filterboy", type: "local", disabled: false, status: "failed" },
  { name: "n8n", type: "remote", disabled: false, status: "needs_auth" },
  { name: "parallel", type: "remote", disabled: true, status: "disabled" },
]

const skills: SkillEntry[] = [
  { id: "opencode", name: "OpenCode", autoinvoke: false },
  { id: "report", name: "Report", autoinvoke: false },
  { id: "auto", name: "Auto", autoinvoke: true },
]

// --- toolBelongsToServer ----------------------------------------------------

test("toolBelongsToServer: matches the bare server name", () => {
  assert.equal(toolBelongsToServer("firecrawl", "firecrawl"), true)
})

test("toolBelongsToServer: matches the `<server>_<tool>` namespace", () => {
  assert.equal(toolBelongsToServer("basic-memory_recent_activity", "basic-memory"), true)
  assert.equal(toolBelongsToServer("firecrawl_scrape", "firecrawl"), true)
})

test("toolBelongsToServer: no match on an unrelated name or prefix", () => {
  assert.equal(toolBelongsToServer("shell", "firecrawl"), false)
  assert.equal(toolBelongsToServer("firecrawl", "fire"), false)
  assert.equal(toolBelongsToServer("firecrawler_scrape", "firecrawl"), false)
})

test("toolBelongsToServer: host namespaces never count as a server's usage", () => {
  // Verified live: 45 `browser_*` and 5 `opencode_*` host tools exist.
  assert.equal(toolBelongsToServer("browser_click", "browser"), false)
  assert.equal(toolBelongsToServer("opencode_session_move", "opencode"), false)
  // An unrelated server named `browser` is not rescued by the guard either.
  assert.equal(toolBelongsToServer("firecrawl_scrape", "browser"), false)
})

test("toolBelongsToServer: tolerates empty inputs", () => {
  assert.equal(toolBelongsToServer("", "firecrawl"), false)
  assert.equal(toolBelongsToServer("firecrawl_scrape", ""), false)
})

// --- classifyServers --------------------------------------------------------

test("classifyServers: marks a server used from its tool namespace", () => {
  const report = classifyServers(servers, new Set(["basic-memory_recent_activity", "shell"]))
  const byName = new Map(report.map((server) => [server.name, server]))

  assert.equal(byName.get("basic-memory")?.used, true)
  assert.equal(byName.get("firecrawl")?.used, false)
})

test("classifyServers: failed / needs_auth are unusable", () => {
  const report = classifyServers(servers, new Set())
  const byName = new Map(report.map((server) => [server.name, server]))

  assert.equal(byName.get("filterboy")?.unusable, true)
  assert.equal(byName.get("n8n")?.unusable, true)
  assert.equal(byName.get("firecrawl")?.unusable, false)
  // A connected server is never unusable, used or not.
  assert.equal(byName.get("parallel")?.unusable, false)
})

test("classifyServers: disabled servers are still reported", () => {
  const report = classifyServers(servers, new Set())
  assert.equal(report.length, servers.length)
  const parallel = report.find((server) => server.name === "parallel")
  assert.equal(parallel?.disabled, true)
  assert.equal(parallel?.status, "disabled")
})

test("classifyServers: an unobserved status is neither used nor unusable", () => {
  const report = classifyServers([{ name: "x", type: "unknown", disabled: false }], new Set())
  assert.deepEqual(report[0], {
    name: "x",
    type: "unknown",
    disabled: false,
    used: false,
    unusable: false,
  })
})

// --- classifySkills ---------------------------------------------------------

test("classifySkills: autoinvoke counts as used", () => {
  const report = classifySkills(skills, new Set())
  assert.equal(report.find((skill) => skill.id === "auto")?.used, true)
  assert.equal(report.find((skill) => skill.id === "opencode")?.used, false)
})

test("classifySkills: an observed id counts as used", () => {
  const report = classifySkills(skills, new Set(["report"]))
  assert.equal(report.find((skill) => skill.id === "report")?.used, true)
  assert.equal(report.find((skill) => skill.id === "opencode")?.used, false)
})

test("classifySkills: an observed name counts as used", () => {
  const report = classifySkills(skills, new Set(["Report"]))
  assert.equal(report.find((skill) => skill.id === "report")?.used, true)
})

// --- computeReport ----------------------------------------------------------

test("computeReport: assembles servers and skills with usage", () => {
  const report = computeReport(
    servers,
    skills,
    { tools: ["firecrawl_scrape"], skills: ["report"] },
    { unusedServersOnly: false, unusedSkillsOnly: false },
  )

  assert.equal(report.servers.length, servers.length)
  assert.equal(report.skills.length, skills.length)
  assert.equal(report.servers.find((server) => server.name === "firecrawl")?.used, true)
  assert.equal(report.skills.find((skill) => skill.id === "report")?.used, true)
  assert.ok(report.computedAt > 0)
})

test("computeReport: defaults to dead weight only (unused or unusable)", () => {
  const report = computeReport(
    servers,
    skills,
    { tools: ["basic-memory_recent_activity"], skills: [] },
  )

  assert.deepEqual(
    report.servers.map((server) => server.name),
    ["firecrawl", "filterboy", "n8n", "parallel"],
  )
  assert.deepEqual(
    report.skills.map((skill) => skill.id),
    ["opencode", "report"],
  )
})

test("computeReport: tolerates empty catalogs and empty usage", () => {
  const report = computeReport([], [], { tools: [], skills: [] })
  assert.deepEqual(report.servers, [])
  assert.deepEqual(report.skills, [])
  assert.ok(report.computedAt > 0)
})

// --- buildPrunePlan ---------------------------------------------------------

const fullReport = computeReport(
  servers,
  skills,
  { tools: ["firecrawl_scrape"], skills: ["report"] },
  { unusedServersOnly: false, unusedSkillsOnly: false },
)

test("buildPrunePlan: nothing to prune when the feature is disabled", () => {
  assert.deepEqual(buildPrunePlan(fullReport, PRUNE_OPTIONS), { servers: [], skills: [] })
  assert.equal(STRUCTURE_PRUNE_ENABLED, false)
})

test("buildPrunePlan: unusable servers only, used/healthy servers excluded", () => {
  const plan = buildPrunePlan(fullReport, {
    enabled: true,
    unusedServers: false,
    unusedSkills: false,
  })
  assert.deepEqual(plan.servers, ["filterboy", "n8n"])
  assert.deepEqual(plan.skills, [])
})

test("buildPrunePlan: unused servers are added only with that option", () => {
  const plan = buildPrunePlan(fullReport, {
    enabled: true,
    unusedServers: true,
    unusedSkills: false,
  })
  // basic-memory/filterboy/n8n/parallel are unused; firecrawl is used in this report.
  assert.deepEqual(plan.servers.sort(), ["basic-memory", "filterboy", "n8n", "parallel"])
})

test("buildPrunePlan: unused skills need an explicit opt-in", () => {
  const withSkills = buildPrunePlan(fullReport, {
    enabled: true,
    unusedServers: true,
    unusedSkills: true,
  })
  assert.deepEqual(withSkills.skills, ["opencode"])
})

test("buildPrunePlan: empty report plans nothing", () => {
  const empty: StructureReport = { servers: [], skills: [], computedAt: 1 }
  assert.deepEqual(
    buildPrunePlan(empty, { enabled: true, unusedServers: true, unusedSkills: true }),
    { servers: [], skills: [] },
  )
})

// --- applyPrunePlan ---------------------------------------------------------

function makeEditor(entries: Array<[string, { disabled?: boolean }]>) {
  const calls: string[] = []
  const map = new Map(entries.map(([name, config]) => [name, { ...config }]))
  return {
    calls,
    map,
    list: () => [...map.entries()],
    update: (name: string, update: (config: { disabled?: boolean }) => void) => {
      calls.push(name)
      const config = map.get(name)
      assert.ok(config, `update called for an unknown server: ${name}`)
      update(config)
    },
  }
}

test("applyPrunePlan: sets disabled: true and records a before/after diff", () => {
  const editor = makeEditor([
    ["filterboy", { disabled: false }],
    ["n8n", {}],
  ])

  const diff = applyPrunePlan(editor, { servers: ["filterboy", "n8n"], skills: [] })

  assert.deepEqual(editor.calls, ["filterboy", "n8n"])
  assert.equal(editor.map.get("filterboy")?.disabled, true)
  assert.equal(editor.map.get("n8n")?.disabled, true)
  assert.deepEqual(diff.changes, [
    { kind: "server", name: "filterboy", before: { disabled: false }, after: { disabled: true } },
    { kind: "server", name: "n8n", before: { disabled: false }, after: { disabled: true } },
  ])
  assert.deepEqual(diff.skipped, [])
  assert.ok(diff.at > 0)
})

test("applyPrunePlan: skips names the editor does not know (never throws)", () => {
  const editor = makeEditor([["filterboy", {}]])
  const diff = applyPrunePlan(editor, { servers: ["filterboy", "ghost"], skills: [] })

  assert.deepEqual(editor.calls, ["filterboy"])
  assert.deepEqual(diff.skipped, ["ghost"])
})

test("applyPrunePlan: an empty plan touches nothing", () => {
  const editor = makeEditor([["filterboy", {}]])
  const diff = applyPrunePlan(editor, { servers: [], skills: ["opencode"] })
  assert.deepEqual(editor.calls, [])
  assert.deepEqual(diff.changes, [])
  assert.deepEqual(editor.map.get("filterboy"), {})
})

// --- usage helpers ----------------------------------------------------------

test("appendUsage: dedups, ignores empties, and caps the list", () => {
  assert.deepEqual(appendUsage(["shell"], "read", 10), ["shell", "read"])
  assert.equal(appendUsage(["shell"], "shell", 10), undefined)
  assert.equal(appendUsage([], "", 10), undefined)
  assert.deepEqual(appendUsage(["a", "b"], "c", 2), ["b", "c"])
})

test("asStringArray / asToolUsage: narrow stored JSON safely", () => {
  assert.deepEqual(asStringArray(undefined, 5), [])
  assert.deepEqual(asStringArray(["a", 1, "b"], 5), ["a", "b"])
  assert.deepEqual(asStringArray(["a", "b", "c"], 2), ["b", "c"])
  assert.deepEqual(asToolUsage("nope"), { tools: [], skills: [] })
  assert.deepEqual(asToolUsage(["nope"]), { tools: [], skills: [] })
  assert.deepEqual(asToolUsage({ tools: ["shell"], skills: ["report"] }), {
    tools: ["shell"],
    skills: ["report"],
  })
})

test("skillIdOf: reads the `{ id }` input verified live, falling back to name", () => {
  assert.equal(skillIdOf({ id: "systematic-debugging" }), "systematic-debugging")
  assert.equal(skillIdOf({ name: "Report" }), "Report")
  assert.equal(skillIdOf({}), "")
  assert.equal(skillIdOf(undefined), "")
})

test("recordToolUsage: appends tools and skill ids, deduping repeats", async () => {
  const storage = makeStorage()

  const first = await recordToolUsage(storage, "ses_a", "skill", "report")
  assert.deepEqual(first, { toolsChanged: true, skillsChanged: true })
  assert.deepEqual(storage.store.get(toolUsageKey("ses_a")), ["skill"])
  assert.deepEqual(storage.store.get("session:ses_a:skillUsage"), ["report"])

  const repeat = await recordToolUsage(storage, "ses_a", "skill", "report")
  assert.deepEqual(repeat, { toolsChanged: false, skillsChanged: false })

  const other = await recordToolUsage(storage, "ses_a", "shell")
  assert.deepEqual(other, { toolsChanged: true, skillsChanged: false })

  const usage = await loadUsage(storage, "ses_a")
  assert.deepEqual(usage, { tools: ["skill", "shell"], skills: ["report"] })
})

test("recordToolUsage: keeps the skill list bounded", async () => {
  const storage = makeStorage()
  assert.ok(SKILL_USAGE_LIMIT >= 2)
  await storage.set("session:ses_b:skillUsage", ["x", "y"])
  await recordToolUsage(storage, "ses_b", "skill", "z")
  assert.deepEqual(storage.store.get("session:ses_b:skillUsage"), ["x", "y", "z"])
})

test("loadUsage: tolerates a missing or malformed record", async () => {
  const storage = makeStorage()
  assert.deepEqual(await loadUsage(storage, "ses_missing"), { tools: [], skills: [] })
  await storage.set("session:ses_bad:toolUsage", "not an array")
  assert.deepEqual(await loadUsage(storage, "ses_bad"), { tools: [], skills: [] })
})

test("asStructureReport: round-trips a persisted report", () => {
  assert.equal(asStructureReport(undefined), undefined)
  assert.equal(asStructureReport({ servers: [] }), undefined)
  assert.deepEqual(asStructureReport(JSON.parse(JSON.stringify(fullReport))), fullReport)
})

test("structureKey: namespaced per session", () => {
  assert.equal(structureKey("ses_abc"), "session:ses_abc:structure")
})
