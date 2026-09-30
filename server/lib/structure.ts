/**
 * Structural cleanup: report unused / unusable MCP servers and unused skills.
 *
 * Two hard rules, both inherited from the plugin's cache-preservation stance:
 *
 *  1. **Nothing here is automatic.** The default is report-only. Config entries
 *     change only through the opt-in prune path, which is double-gated by
 *     `STRUCTURE_PRUNE_ENABLED` (a module constant) *and* a per-session approval
 *     flag — neither of which this plugin ever sets itself.
 *  2. **Never remove.** The prune path only ever sets `disabled: true`, which is
 *     a first-class, reversible field on both MCP config variants. Removing an
 *     entry would lose `command`/`url`/`oauth` and has no cheap restore. Skills
 *     have no `disabled` field at all (see `Skill.Info`), so skills are
 *     report-only and are never mutated.
 *
 * "Unused" is scoped per session and is an honest-but-weak signal:
 *  - MCP server unused = no tool call belonging to it was seen in this session.
 *  - MCP server unusable = the runtime reports `failed` or `needs_auth`. This is
 *    the strong, useful signal (observed live: `filterboy` failed to spawn,
 *    `n8n` unreachable).
 *  - Skill unused = not `autoinvoke` and never observed through the `skill`
 *    tool. The skill catalog surfaced by the SDK is *incomplete* (verified live
 *    on 2.0.19: only the builtin skills appear, while the session prompt lists
 *    many more), so this is advisory only — never prune a skill.
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

export type ServerReport = ServerEntry & { used: boolean; unusable: boolean }
export type SkillReport = SkillEntry & { used: boolean }

export type StructureReport = {
  servers: ServerReport[]
  skills: SkillReport[]
  computedAt: number
}

export type PrunePlan = {
  servers: string[]
  skills: string[]
}

export type PruneChange = {
  kind: "server"
  name: string
  before: { disabled: boolean }
  after: { disabled: boolean }
}

export type PruneDiff = {
  at: number
  changes: PruneChange[]
  /** Named in the plan but not found in the editor (stale catalog). */
  skipped: string[]
}

/** Narrow editor surface the prune path needs; keeps the logic testable. */
export type ServerEditorLike = {
  list(): readonly (readonly [string, { disabled?: boolean }])[]
  update(name: string, update: (config: { disabled?: boolean }) => void): void
}

// --- Defaults ---------------------------------------------------------------

/** Opt-in only. With this `false` (the default) Phase 3 changes nothing. */
export const STRUCTURE_PRUNE_ENABLED = false

/** Report used-but-usable servers too? No — the report is about dead weight. */
export const UNUSED_SERVERS_ONLY = true

/** Skills are report-only: `Skill.Info` has no reversible off-switch. */
export const PRUNE_UNUSED_SKILLS = false

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

export type PruneOptions = {
  enabled: boolean
  /** Include servers that are merely unused (not unusable). */
  unusedServers: boolean
  /** Include skills that are merely unused. Off by default — see the header. */
  unusedSkills: boolean
}

/**
 * What the prune path actually selects when it is switched on.
 *
 * Read this before flipping `STRUCTURE_PRUNE_ENABLED`: with `unusedServers:
 * true` (the plan's `UNUSED_SERVERS_ONLY`) turning the feature on disables
 * *every* server that was unused in the approving session — including healthy
 * ones. Verified live during the Phase 3 smoke: with the flag on, all five
 * configured servers (three of them `connected`) were flipped to
 * `disabled: true`. "Unused in this session" is a weak signal; `unusable`
 * (`failed`/`needs_auth`) is the safe one. Set `unusedServers: false` for a
 * conservative prune.
 */
export const PRUNE_OPTIONS: PruneOptions = {
  enabled: STRUCTURE_PRUNE_ENABLED,
  unusedServers: UNUSED_SERVERS_ONLY,
  unusedSkills: PRUNE_UNUSED_SKILLS,
}

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
    return { ...server, used, unusable }
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
  }))
}

export type ReportOptions = {
  unusedServersOnly: boolean
  unusedSkillsOnly: boolean
}

export const REPORT_OPTIONS: ReportOptions = {
  unusedServersOnly: UNUSED_SERVERS_ONLY,
  unusedSkillsOnly: true,
}

/** Assemble the per-session structure report. Tolerates empty inputs. */
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
      ? classifiedServers.filter((server) => server.unusable || !server.used)
      : classifiedServers,
    skills: options.unusedSkillsOnly
      ? classifiedSkills.filter((skill) => !skill.used)
      : classifiedSkills,
    computedAt: Date.now(),
  }
}

/** The list of entries the opt-in prune would disable. */
export function buildPrunePlan(
  report: StructureReport,
  options: PruneOptions = PRUNE_OPTIONS,
): PrunePlan {
  const plan: PrunePlan = { servers: [], skills: [] }
  if (!options.enabled) return plan

  for (const server of report.servers) {
    if (server.unusable || (options.unusedServers && !server.used)) plan.servers.push(server.name)
  }
  if (options.unusedSkills) {
    for (const skill of report.skills) {
      if (!skill.used) plan.skills.push(skill.id)
    }
  }
  return plan
}

/**
 * Apply a prune plan to an MCP editor. Only ever sets `disabled: true` — never
 * `remove()` — and returns a before/after diff so the change is visible and
 * manually reversible. Skills are ignored by design.
 */
export function applyPrunePlan(editor: ServerEditorLike, plan: PrunePlan): PruneDiff {
  const changes: PruneChange[] = []
  const skipped: string[] = []
  const entries = new Map(editor.list().map(([name, config]) => [name, config]))

  for (const name of plan.servers) {
    const config = entries.get(name)
    if (!config) {
      skipped.push(name)
      continue
    }
    const before = { disabled: config.disabled === true }
    editor.update(name, (next) => {
      next.disabled = true
    })
    changes.push({ kind: "server", name, before, after: { disabled: true } })
  }

  return { at: Date.now(), changes, skipped }
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
export const pruneDiffKey = (sessionID: string): string => `session:${sessionID}:prune.diff`
export const pruneApprovedKey = (sessionID: string): string => `session:${sessionID}:prune.approved`

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

/** Narrow stored JSON back to a report (used by Phase 4/5 readers). */
export function asStructureReport(value: unknown): StructureReport | undefined {
  if (!value || typeof value !== "object" || Array.isArray(value)) return undefined
  const v = value as Record<string, unknown>
  if (!Array.isArray(v.servers) || !Array.isArray(v.skills)) return undefined
  return {
    servers: v.servers as ServerReport[],
    skills: v.skills as SkillReport[],
    computedAt: typeof v.computedAt === "number" ? v.computedAt : 0,
  }
}

export async function loadStructureReport(
  storage: StorageDomain,
  sessionID: string,
): Promise<StructureReport | undefined> {
  return asStructureReport(await storage.get(structureKey(sessionID)))
}

/** The owner sets this by hand; the plugin never does. */
export async function isPruneApproved(
  storage: StorageDomain,
  sessionID: string,
): Promise<boolean> {
  return (await storage.get(pruneApprovedKey(sessionID))) === true
}

export async function recordPruneDiff(
  storage: StorageDomain,
  sessionID: string,
  diff: PruneDiff,
): Promise<void> {
  await storage.set(pruneDiffKey(sessionID), diff as unknown as Json)
}
