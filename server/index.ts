/**
 * ctx-guard — server plugin (compaction + occupancy + continuity + tool hooks +
 * structural report).
 *
 * Cache-preservation invariant (the whole point of this plugin):
 *   The ONLY surfaces allowed to alter content are:
 *     1. the `compaction` hook (event.system.push), and
 *     2. `tool.hook("execute.after")` on `status: "completed"` (event.result),
 *        which rewrites a result *about to be committed as new content* — never
 *        anything already in the transcript.
 *   The `context` hook is strictly READ-ONLY — it must never touch
 *   event.messages / event.system / event.tools. `event.input` in the tool
 *   hooks is readonly; it is never mutated.
 *
 * Phase 3 adds no content-writing surface at all: the MCP/skill transforms only
 * *observe*, the tool hooks only record names, and the opt-in prune path (off by
 * default, double-gated) edits the MCP config — never the transcript.
 *
 * The default export is a plain `{ id, setup }` object (what `Plugin.define`
 * returns). All SDK references are `import type`, so nothing is resolved at
 * runtime and the plugin keeps zero runtime dependencies.
 */
import type { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { MCPEditor } from "@opencode/plugin/promise/mcp"
import type { ModelEditor } from "@opencode/plugin/promise/model"
import type { SkillEditor } from "@opencode/plugin/promise/skill"
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session"
import type { Model } from "@opencode/schema/model"
import { buildContinuityBlock } from "./lib/compaction.ts"
import { measureContext } from "./lib/quality.ts"
import { loadContinuity, saveContinuity, type ContinuityState } from "./lib/storage.ts"
import {
  PRUNE_OPTIONS,
  STRUCTURE_PRUNE_ENABLED,
  applyPrunePlan,
  buildPrunePlan,
  computeReport,
  isPruneApproved,
  loadUsage,
  recordPruneDiff,
  recordToolUsage,
  saveStructureReport,
  skillIdOf,
  type ServerEntry,
  type SkillEntry,
  type ToolUsage,
} from "./lib/structure.ts"
import {
  COMPRESSION_ENABLED,
  COMPRESSION_OPTIONS,
  DEDUP_ENABLED,
  DEDUP_MARKER,
  DEDUP_MIN_CHARS,
  commandOf,
  compressResult,
  isTargetTool,
  loadRecentSignatures,
  replaceResultText,
  saveRecentSignatures,
  signatureOf,
  textLengthOf,
} from "./lib/toolhooks.ts"

/** Used only if the model's real context limit cannot be resolved. */
const DEFAULT_CONTEXT_LIMIT = 200_000

/**
 * Phase 3 state, created per `setup()` call — i.e. rebuilt on every hot reload,
 * and isolated between plugin instances. Nothing durable lives here: usage,
 * reports and prune diffs all go to `ctx.storage`.
 */
type StructureState = {
  /** Latest read-only catalog snapshot from the transform callbacks. */
  catalog: { servers: ServerEntry[]; skills: SkillEntry[] }
  /** Status is NOT in the transform config — only `ctx.mcp.list()` carries it. */
  statusCache?: { at: number; statuses: Map<string, string> }
  /** The session that asked for (and was approved for) a prune, if any. */
  pruneIntent?: { sessionID: string }
  /** Last session whose usage was read, so repeat tool calls skip storage. */
  usageCache?: { sessionID: string; usage: ToolUsage }
}

const STATUS_TTL_MS = 5_000

function createStructureState(): StructureState {
  return { catalog: { servers: [], skills: [] } }
}

function modelKey(providerID: string, modelID: string): string {
  return `${providerID}/${modelID}`
}

/**
 * Resolve the model's context limit. `ctx.model.transform` is preferred: it
 * runs once when the model list is built. `ctx.model.list()` is a fallback for
 * the (unlikely) case where the hook fires before any transform has run.
 */
async function resolveLimit(
  ctx: Plugin.Context,
  limits: Map<string, number>,
  model: Model.Ref,
): Promise<number> {
  const cached = limits.get(modelKey(model.providerID, model.id))
  if (cached !== undefined && cached > 0) return cached

  try {
    const result = await ctx.model.list()
    for (const info of result.data ?? []) {
      if (info.providerID !== model.providerID) continue
      if (info.id !== model.id && info.modelID !== model.id) continue
      limits.set(modelKey(info.providerID, info.id), info.limit.context)
      return info.limit.context
    }
  } catch {
    // Fall through to the default; occupancy is an estimate either way.
  }

  return DEFAULT_CONTEXT_LIMIT
}

/**
 * Snapshot the MCP catalog read-only. Taken inside the transform callback, i.e.
 * during a config build — never in a session hook. Called again after an opt-in
 * prune so the stored report reflects what was actually applied.
 */
function snapshotServers(
  editor: { list(): readonly (readonly [string, { type?: string; disabled?: boolean }])[] },
  state: StructureState,
): void {
  state.catalog.servers = editor.list().map(([name, config]) => ({
    name,
    type: config.type === "local" ? "local" : "remote",
    disabled: config.disabled === true,
  }))
}

/**
 * Runtime statuses per server name. Only `ctx.mcp.list()` exposes them (the
 * transform config has no status), and it can be empty very early in a process,
 * so it is queried lazily and cached briefly. Status is advisory: a failure
 * here must never break the report.
 */
async function serverStatuses(
  ctx: Plugin.Context,
  state: StructureState,
): Promise<Map<string, string>> {
  if (state.statusCache && Date.now() - state.statusCache.at < STATUS_TTL_MS) {
    return state.statusCache.statuses
  }

  const statuses = new Map<string, string>()
  try {
    const result = await ctx.mcp.list()
    for (const server of result.data ?? []) {
      const status = (server.status as { status?: string } | undefined)?.status
      if (typeof status === "string") statuses.set(server.name, status)
    }
  } catch {
    // Status is optional; the report still works without it.
  }

  state.statusCache = { at: Date.now(), statuses }
  return statuses
}

/**
 * Server entries for the report: the transform snapshot (name, type, disabled)
 * merged with the runtime status map, unioned so an entry visible only through
 * one of the two sources is still reported.
 */
async function serverEntries(ctx: Plugin.Context, state: StructureState): Promise<ServerEntry[]> {
  const statuses = await serverStatuses(ctx, state)
  const byName = new Map<string, ServerEntry>()
  for (const entry of state.catalog.servers) byName.set(entry.name, { ...entry })

  for (const [name, status] of statuses) {
    const existing = byName.get(name)
    byName.set(
      name,
      existing
        ? { ...existing, status }
        : { name, type: "unknown", disabled: false, status },
    )
  }

  return [...byName.values()]
}

/** Skill entries for the report; falls back to `ctx.skill.list()` on a cold reload. */
async function skillEntries(ctx: Plugin.Context, state: StructureState): Promise<SkillEntry[]> {
  if (state.catalog.skills.length > 0) return state.catalog.skills

  try {
    const result = await ctx.skill.list()
    return (result.data ?? []).map((info) => ({
      id: info.id,
      name: info.name,
      autoinvoke: info.autoinvoke === true,
    }))
  } catch {
    return []
  }
}

/** Read this session's usage once, then keep it in local state. */
async function hydrateUsage(
  ctx: Plugin.Context,
  state: StructureState,
  sessionID: string,
): Promise<ToolUsage> {
  if (state.usageCache?.sessionID !== sessionID) {
    state.usageCache = { sessionID, usage: await loadUsage(ctx.storage, sessionID) }
  }
  return state.usageCache.usage
}

/**
 * Recompute and persist the structural report. Read-only with respect to the
 * request: it touches storage and the catalogs, never the event.
 */
async function refreshStructure(
  ctx: Plugin.Context,
  state: StructureState,
  sessionID: string,
): Promise<void> {
  const usage = await hydrateUsage(ctx, state, sessionID)
  const report = computeReport(
    await serverEntries(ctx, state),
    await skillEntries(ctx, state),
    usage,
  )
  await saveStructureReport(ctx.storage, sessionID, report)
}

/**
 * Hook bodies are best-effort by contract: a throw inside one must never take
 * down the request, the config build, or the whole agent loop.
 *
 * This is not hypothetical. During Phase 3 development this plugin is symlinked
 * live into `~/.config/opencode/plugins/`, so a half-edited hook that threw a
 * `ReferenceError` made *every* session unusable until the plugin was disabled
 * by hand. Failures are logged to the server's stderr and swallowed.
 */
export function guarded<Args extends unknown[]>(
  label: string,
  body: (...args: Args) => void | Promise<void>,
): (...args: Args) => Promise<void> {
  return async (...args: Args) => {
    try {
      await body(...args)
    } catch (error) {
      console.error(`[ctx-guard] ${label} failed (ignored):`, error)
    }
  }
}

/**
 * Registration is the other place a throw is fatal: a rejected `transform` or
 * `hook` call makes `setup()` throw, which fails the *entire plugin load* and
 * takes every session down with it. That is the exact failure mode observed in
 * the server log during Phase 3 development
 * (`failed to load plugin ... ReferenceError: probe is not defined`).
 *
 * Each registration is therefore attempted independently: whatever cannot be
 * registered is reported and skipped, and the rest of the plugin still loads.
 */
async function register(
  registrations: Registration[],
  label: string,
  start: () => Promise<Registration>,
): Promise<void> {
  try {
    registrations.push(await start())
  } catch (error) {
    console.error(`[ctx-guard] ${label} registration failed (skipped):`, error)
  }
}

const ctxGuard: Plugin.Plugin = {
  id: "ctx-guard",

  setup: async (ctx: Plugin.Context) => {
    const registrations: Registration[] = []
    const limits = new Map<string, number>()
    const state = createStructureState()

    // --- Model limits (read-only) -------------------------------------------
    await register(registrations, "model.transform", () =>
      ctx.model.transform(
        guarded("model.transform", (editor: ModelEditor) => {
          for (const model of editor.list()) {
            limits.set(modelKey(model.providerID, model.id), model.limit.context)
          }
        }),
      ),
    )

    // --- MCP catalog (read-only) + opt-in prune -----------------------------
    // The snapshot is always taken. Pruning happens only when the feature flag
    // is on AND this session was explicitly approved by the owner (see the
    // `context` hook below); even then it only ever sets `disabled: true`.
    await register(registrations, "mcp.transform", () =>
      ctx.mcp.transform(
        guarded("mcp.transform", (editor: MCPEditor) => {
          snapshotServers(editor, state)

          if (!STRUCTURE_PRUNE_ENABLED || !state.pruneIntent) return
          const sessionID = state.pruneIntent.sessionID
          const usage =
            state.usageCache?.sessionID === sessionID
              ? state.usageCache.usage
              : { tools: [], skills: [] }
          const report = computeReport(state.catalog.servers, state.catalog.skills, usage, {
            unusedServersOnly: false,
            unusedSkillsOnly: false,
          })
          const diff = applyPrunePlan(editor, buildPrunePlan(report, PRUNE_OPTIONS))

          // Re-snapshot: the report must reflect what was just applied.
          snapshotServers(editor, state)

          // Only a real flip (false -> true) is worth recording.
          const changed = diff.changes.filter((change) => !change.before.disabled)
          if (changed.length === 0) return
          void recordPruneDiff(ctx.storage, sessionID, { ...diff, changes: changed }).catch(
            () => {},
          )
        }),
      ),
    )

    // --- Skill catalog (read-only) ------------------------------------------
    // Skills are report-only: `Skill.Info` has no reversible off-switch, so the
    // prune path never touches them.
    await register(registrations, "skill.transform", () =>
      ctx.skill.transform(
        guarded("skill.transform", (editor: SkillEditor) => {
          state.catalog.skills = editor.list().map((info) => ({
            id: info.id,
            name: info.name,
            autoinvoke: info.autoinvoke === true,
          }))
        }),
      ),
    )

    // --- Compaction injection ------------------------------------------------
    // Runs once per compaction request. `event.system` belongs to the outgoing
    // summarizer call, so this cannot invalidate the live prompt cache.
    await register(registrations, "compaction", () =>
      ctx.session.hook(
        "compaction",
        guarded("compaction", async (event: SessionCompaction) => {
          const continuity = await loadContinuity(ctx.storage, event.sessionID)
          const block = buildContinuityBlock({
            agent: event.agent,
            state: continuity,
            messages: event.messages,
          })
          if (block) event.system.push({ type: "text", text: block })
          // Deliberately do NOT set event.result — keep the main model as the
          // summarizer (self-compaction would need a second model, which cannot
          // reach the opencode-go provider).
        }),
      ),
    )

    // --- Occupancy scoring (READ-ONLY) ---------------------------------------
    await register(registrations, "context", () =>
      ctx.session.hook(
        "context",
        guarded("context", async (event: SessionContext) => {
          const limit = await resolveLimit(ctx, limits, event.model)
          const reading = measureContext(event, limit)
          const previous = await loadContinuity(ctx.storage, event.sessionID)

          const next: ContinuityState = {
            lastTask: previous?.lastTask ?? "",
            decisions: previous?.decisions ?? [],
            activeFiles: previous?.activeFiles ?? [],
            agent: event.agent,
            tokens: reading.tokens,
            limit: reading.limit,
            occupancy: reading.occupancy,
            updatedAt: Date.now(),
            lastCommand: previous?.lastCommand,
          }
          await saveContinuity(ctx.storage, event.sessionID, next)

          // Phase 3: the owner may approve a one-shot structural prune for this
          // session. The plugin never sets the flag; with the feature disabled
          // (the default) this whole block is dead code.
          if (STRUCTURE_PRUNE_ENABLED && (await isPruneApproved(ctx.storage, event.sessionID))) {
            if (state.pruneIntent?.sessionID !== event.sessionID) {
              state.pruneIntent = { sessionID: event.sessionID }
              // Rebuild the MCP config so the transform callback can apply it.
              try {
                await ctx.mcp.reload()
              } catch {
                // A failed reload leaves everything untouched — the safe outcome.
              }
            }
          }

          await refreshStructure(ctx, state, event.sessionID)

          // INVARIANT: nothing above writes to event.messages / event.system /
          // event.tools. Keep it that way.
        }),
      ),
    )

    // --- Tool hooks: bash/shell output compression + dedup --------------------
    // `execute.before` (read-only): remember the last command for the
    // continuity block. `event.input` is never mutated.
    await register(registrations, "execute.before", () =>
      ctx.tool.hook(
        "execute.before",
        guarded("execute.before", async (event) => {
          // Phase 3 (read-only): record that this tool ran, so the structure
          // report can tell used servers/skills from dead weight. A skill call
          // also records the skill id — verified live as `{ id }`.
          const skillID = event.tool === "skill" ? skillIdOf(event.input) : ""
          const { toolsChanged, skillsChanged } = await recordToolUsage(
            ctx.storage,
            event.sessionID,
            event.tool,
            skillID,
          )
          if (toolsChanged || skillsChanged) {
            state.usageCache = {
              sessionID: event.sessionID,
              usage: await loadUsage(ctx.storage, event.sessionID),
            }
            await refreshStructure(ctx, state, event.sessionID)
          }

          if (!isTargetTool(event.tool)) return
          const command = commandOf(event.input)
          if (!command) return

          const previous = await loadContinuity(ctx.storage, event.sessionID)
          await saveContinuity(ctx.storage, event.sessionID, {
            lastTask: previous?.lastTask ?? "",
            decisions: previous?.decisions ?? [],
            activeFiles: previous?.activeFiles ?? [],
            agent: event.agent,
            tokens: previous?.tokens,
            limit: previous?.limit,
            occupancy: previous?.occupancy,
            updatedAt: Date.now(),
            lastCommand: command,
          })
        }),
      ),
    )

    await register(registrations, "execute.after", () =>
      ctx.tool.hook(
        "execute.after",
        guarded("execute.after", async (event) => {
          if (!isTargetTool(event.tool)) return
          if (event.status !== "completed") return // never touch errors

          const text = textLengthOf(event.result)
          if (text <= 0) return // structured output only → nothing to compress

          // Dedup first: a repeated large result collapses to a marker, and is
          // not re-added to the history (it is already there).
          if (DEDUP_ENABLED && text > DEDUP_MIN_CHARS) {
            const signature = signatureOf(event.tool, event.input)
            const recent = await loadRecentSignatures(ctx.storage, event.sessionID)
            if (recent.includes(signature)) {
              event.result = replaceResultText(event.result, DEDUP_MARKER)
              return
            }
            await saveRecentSignatures(ctx.storage, event.sessionID, [...recent, signature])
          }

          // Then compress: head + tail with an omission marker. Only the result
          // that is about to be committed is rewritten — never the transcript.
          if (COMPRESSION_ENABLED) {
            event.result = compressResult(event.result, COMPRESSION_OPTIONS)
          }
        }),
      ),
    )

    return async () => {
      for (const registration of registrations.reverse()) {
        try {
          await registration.dispose()
        } catch {
          // Disposal is best-effort; a failed dispose must not block unload.
        }
      }
    }
  },
}

export default ctxGuard
