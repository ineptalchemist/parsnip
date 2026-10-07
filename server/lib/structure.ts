/**
 * Structural reporting: which MCP servers and skills looked unused or unusable
 * during this session.
 *
 * **This module is report-only. It mutates nothing.**
 *
 * It used to carry an opt-in prune that set `disabled: true` on MCP servers.
 * That was removed 2026-10-03 (see
 * `~/.opencode/plan/parsnip-remove-structure-prune-2026-10-03.md`). Two
 * reasons, both learned the hard way:
 *
 *  1. Its only actionable signal was weak. "Unused" is scoped to a single
 *     session, and — because `codemode` defaults to `true` — it is blind to
 *     every code-mode server, whose tool calls never fire `execute.before`.
 *     `used` had been `false` for every server in all 57 measurable sessions.
 *     The 2026-09-29 smoke test duly flipped all five configured servers,
 *     three of them healthy.
 *  2. Its payoff was small. Disabling a server only shrinks the main prompt if
 *     that server's tools are native, and under a code-mode config the ones
 *     worth disabling are already absent from the prompt.
 *
 * The report survives because it is cheap and, after the `usageKnown` fix,
 * honest — and because it is what surfaced the `used` bug in the first place.
 *
 * Signals, of very unequal quality:
 *  - MCP server unusable = the runtime reports `failed` or `needs_auth`. The
 *    strong, reliable one (observed live: `taproot` failed to spawn, `n8n`
 *    unreachable).
 *  - MCP server unused = no tool call belonging to it was seen in this session.
 *    Weak, and gated by `usageKnown` — see `ServerReport`.
 *  - Skill unused = not `autoinvoke` and never observed through the `skill`
 *    tool. The skill catalog surfaced by the SDK is *incomplete* (verified live
 *    on 2.0.19: only the builtin skills appear, while the session prompt lists
 *    many more), so this is advisory only.
 *
 * Everything except the storage helpers at the bottom is pure and unit-testable
 * under `node --test`; the SDK reference is a type-only import, so this module
 * adds no runtime dependency.
 */
import type { StorageDomain } from "@opencode/plugin/promise/storage"

export type ServerEntry = {
  name: string
  /** `unknown` until the transform catalog has been observed. */
  type: "local" | "remote" | "unknown"
  disabled: boolean
  /** Runtime status from `ctx.mcp.list()` — never available from the transform. */
  status?: string
  /**
   * Whether this server's tools are exposed through Code Mode. Read from the MCP
   * server config, where **the SDK default is `true`** — so an absent value means
   * code mode, not native tools. `undefined` is therefore the *least* observable
   * case and must not be read as "no tools seen".
   */
  codemode?: boolean
}

export type SkillEntry = {
  id: string
  name: string
  autoinvoke: boolean
}

export type ToolUsage = {
  tools: string[]
  skills: string[]
}

/**
 * `usageKnown` answers "could we have observed this at all?", and it is the
 * field that makes the report honest.
 *
 * Before 2026-10-03 the report only had `used: boolean`, and `used: false` was
 * read as "this server is dead weight". Measured over 57 sessions it was **false
 * for every server, every time** — it had never once been true. Two distinct
 * causes, both of which made `false` mean "we cannot tell":
 *
 *  1. **Code-mode servers are structurally invisible.** `codemode` defaults to
 *     `true`, so such a server's tools are reachable *only* through the
 *     `execute` tool. The inner call never fires `execute.before`, so its name
 *     never reaches `session:<id>:toolUsage`. Confirmed live: a session that
 *     called `parallel.web_search` and `firecrawl.scrape` through `execute`
 *     recorded `execute` and nothing else.
 *  2. **An absent catalog entry looked identical to an unused server.**
 *
 * So `used` is only load-bearing when `usageKnown` is true, and the report
 * filter drops an unobserved server rather than listing it as dead weight.
 */
export type ServerReport = ServerEntry & {
  used: boolean
  unusable: boolean
  /** False when this server's tool calls could not have been observed at all. */
  usageKnown: boolean
}

export type SkillReport = SkillEntry & {
  used: boolean
  /** Always false — see `SKILL_CATALOG_COMPLETE`. */
  usageKnown: boolean
}

/**
 * The skill catalog surfaced by the SDK is **incomplete**: verified live, only
 * the builtin skills appear while the session prompt lists many more. So a skill
 * reading `used: false` may simply be invisible to the catalog rather than
 * unused. Skills are report-only anyway (`Skill.Info` has no `disabled` field),
 * but the flag keeps a future reader from treating the number as evidence.
 */
export const SKILL_CATALOG_COMPLETE = false

export type StructureReport = {
  servers: ServerReport[]
  skills: SkillReport[]
  computedAt: number
}

export type ReportOptions = {
  unusedServersOnly: boolean
  unusedSkillsOnly: boolean
}

// --- Defaults ---------------------------------------------------------------

/**
 * Report only dead weight: servers that are unusable, or unused *and* observed
 * unused. Used-and-healthy servers are dropped, because the report exists to
 * answer "what looks like it could be turned off", not "what is configured".
 *
 * This was previously `UNUSED_SERVERS_ONLY`, shared with the deleted prune
 * options. With the prune gone it is purely a display filter, so it is renamed
 * to say that.
 */
export const REPORT_DEAD_WEIGHT_ONLY = true

/** Statuses that mean "this server cannot be used at all". */
export const UNUSABLE_STATUSES: readonly string[] = ["failed", "needs_auth"]

/**
 * Host tool families that look like an MCP namespace but are not one. A
 * configured server literally named `browser`/`opencode` would otherwise steal
 * every `browser_*` / `opencode_*` host tool call (45 + 5 tools live on 2.0.19).
 */
export const HOST_TOOL_NAMESPACES: readonly string[] = ["browser", "opencode"]

/** Bounds for the per-session usage sets. */
export const TOOL_USAGE_LIMIT = 512
export const SKILL_USAGE_LIMIT = 512

// --- Classification (pure) --------------------------------------------------

/**
 * Does `tool` belong to the MCP server `serverName`? MCP tools surface as
 * `<server>_<tool>` and the server's name is itself usable as a tool name.
 * Host namespaces are excluded so `browser_*` never counts as a `browser`
 * server's usage.
 */
export function toolBelongsToServer(tool: string, serverName: string): boolean {
  if (!tool || !serverName) return false
  if (HOST_TOOL_NAMESPACES.includes(serverName)) return false
  return tool === serverName || tool.startsWith(`${serverName}_`)
}

export function classifyServers(
  servers: readonly ServerEntry[],
  usedTools: ReadonlySet<string>,
): ServerReport[] {
  return servers.map((server) => {
    let used = false
    for (const tool of usedTools) {
      if (toolBelongsToServer(tool, server.name)) {
        used = true
        break
      }
    }
    const unusable = server.status !== undefined && UNUSABLE_STATUSES.includes(server.status)
    // Usage is observable only when the server's tools surface as native tool
    // calls, i.e. `codemode: false`. Anything else reaches the model through
    // `execute`, whose inner calls never fire `execute.before`. Seeing a call is
    // itself proof, so `used: true` forces `usageKnown: true`.
    const usageKnown = used || server.codemode === false
    return { ...server, used, unusable, usageKnown }
  })
}

/**
 * A skill counts as used when it auto-invokes (the host will load it without
 * being asked) or when it was observed through the `skill` tool by id or name.
 */
export function classifySkills(
  skills: readonly SkillEntry[],
  usedSkills: ReadonlySet<string>,
): SkillReport[] {
  return skills.map((skill) => ({
    ...skill,
    used: skill.autoinvoke || usedSkills.has(skill.id) || usedSkills.has(skill.name),
    usageKnown: SKILL_CATALOG_COMPLETE,
  }))
}

export const REPORT_OPTIONS: ReportOptions = {
  unusedServersOnly: REPORT_DEAD_WEIGHT_ONLY,
  unusedSkillsOnly: true,
}

/**
 * Assemble the per-session structure report. Tolerates empty inputs.
 *
 * The `unusedServersOnly` filter keeps a server when it is **unusable**, or when
 * it is unused *and that verdict is supported* (`usageKnown`). An unobservable
 * server is dropped rather than reported, because "we could not see whether it
 * was used" is not the same claim as "you can turn this off".
 */
export function computeReport(
  servers: readonly ServerEntry[],
  skills: readonly SkillEntry[],
  usage: ToolUsage,
  options: ReportOptions = REPORT_OPTIONS,
): StructureReport {
  const classifiedServers = classifyServers(servers, new Set(usage.tools))
  const classifiedSkills = classifySkills(skills, new Set(usage.skills))

  return {
    servers: options.unusedServersOnly
      ? classifiedServers.filter((server) => server.unusable || (!server.used && server.usageKnown))
      : classifiedServers,
    skills: options.unusedSkillsOnly
      ? classifiedSkills.filter((skill) => !skill.used)
      : classifiedSkills,
    computedAt: Date.now(),
  }
}

// --- Usage extraction -------------------------------------------------------

/** Tool names are appended once each; bounded so storage cannot grow forever. */
export function appendUsage(
  existing: readonly string[],
  value: string,
  max: number,
): string[] | undefined {
  if (!value) return undefined
  if (existing.includes(value)) return undefined
  return [...existing, value].slice(-max)
}

export function asStringArray(value: unknown, max: number): string[] {
  if (!Array.isArray(value)) return []
  return value.filter((entry): entry is string => typeof entry === "string").slice(-max)
}

export function asToolUsage(value: unknown): ToolUsage {
  if (!value || typeof value !== "object" || Array.isArray(value)) {
    return { tools: [], skills: [] }
  }
  const v = value as Record<string, unknown>
  return {
    tools: asStringArray(v.tools, TOOL_USAGE_LIMIT),
    skills: asStringArray(v.skills, SKILL_USAGE_LIMIT),
  }
}

/** Skill id from the `skill` tool input — verified live as `{ id }`. */
export function skillIdOf(input: unknown): string {
  if (!input || typeof input !== "object") return ""
  const record = input as Record<string, unknown>
  if (typeof record.id === "string") return record.id
  if (typeof record.name === "string") return record.name
  return ""
}

// --- Storage (session-scoped) ----------------------------------------------

export const toolUsageKey = (sessionID: string): string => `session:${sessionID}:toolUsage`
export const skillUsageKey = (sessionID: string): string => `session:${sessionID}:skillUsage`
export const structureKey = (sessionID: string): string => `session:${sessionID}:structure`

type Json = Parameters<StorageDomain["set"]>[1]

export async function loadUsage(storage: StorageDomain, sessionID: string): Promise<ToolUsage> {
  const [tools, skills] = await Promise.all([
    storage.get(toolUsageKey(sessionID)),
    storage.get(skillUsageKey(sessionID)),
  ])
  return {
    tools: asStringArray(tools, TOOL_USAGE_LIMIT),
    skills: asStringArray(skills, SKILL_USAGE_LIMIT),
  }
}

/** Record a tool call. Returns the new skill list when it changed, else null. */
export async function recordToolUsage(
  storage: StorageDomain,
  sessionID: string,
  tool: string,
  skillID = "",
): Promise<{ toolsChanged: boolean; skillsChanged: boolean }> {
  const current = await loadUsage(storage, sessionID)

  const tools = appendUsage(current.tools, tool, TOOL_USAGE_LIMIT)
  if (tools) await storage.set(toolUsageKey(sessionID), tools as unknown as Json)

  const skills = appendUsage(current.skills, skillID, SKILL_USAGE_LIMIT)
  if (skills) await storage.set(skillUsageKey(sessionID), skills as unknown as Json)

  return { toolsChanged: Boolean(tools), skillsChanged: Boolean(skills) }
}

export async function saveStructureReport(
  storage: StorageDomain,
  sessionID: string,
  report: StructureReport,
): Promise<void> {
  await storage.set(structureKey(sessionID), report as unknown as Json)
}

/**
 * Narrow stored JSON back to a `StructureReport`.
 *
 * Reports written before 2026-10-03 have no `usageKnown` field, and their
 * `used: false` is exactly the unsupported verdict this type now distinguishes.
 * A missing flag is therefore read as `false` — old data is treated as
 * unobservable, never as evidence.
 *
 * Still no production reader: the report is written per session but nothing
 * reads it back, because the TUI footer that was meant to surface it is not
 * built. It exists — and is tested — so a future reader does not have to
 * re-derive the stored shape, and so a consumer can trust whatever it finds in
 * `session:<id>:structure`.
 */
export function asStructureReport(value: unknown): StructureReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.servers) || !Array.isArray(v.skills)) return undefined
  return {
    servers: (v.servers as ServerReport[]).map((server) => ({
      ...server,
      usageKnown: server?.usageKnown === true,
    })),
    skills: (v.skills as SkillReport[]).map((skill) => ({
      ...skill,
      usageKnown: skill?.usageKnown === true,
    })),
    computedAt: typeof v.computedAt === "number" ? v.computedAt : 0,
  }
}

export async function loadStructureReport(
  storage: StorageDomain,
  sessionID: string,
): Promise<StructureReport | undefined> {
  return asStructureReport(await storage.get(structureKey(sessionID)))
}
