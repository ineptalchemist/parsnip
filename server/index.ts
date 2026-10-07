/**
 * parsnip — server plugin (compaction + occupancy + continuity + tool hooks +
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
 * *observe*, and the tool hooks only record names. Nothing in this plugin edits
 * configuration — the structural prune that used to was removed 2026-10-03.
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
import type { ToolEditor } from "@opencode/plugin/promise/tool"
import type { CommandEditor } from "@opencode/plugin/promise/command"
import type { Model } from "@opencode/schema/model"
import { buildContinuityBlock, promptText as promptInputText, truncate } from "./lib/compaction.ts"
import { measureContext } from "./lib/quality.ts"
import {
  appendActiveFile,
  appendDecision,
  describeDecision,
  filePathOf,
  loadContinuity,
  loadSavings,
  saveContinuity,
  saveSavings,
  saveTokenUsage,
  tokenUsageFrom,
  type ContinuityState,
} from "./lib/storage.ts"
import {
  MAX_CHARS_LIMIT,
  MIN_CHARS_LIMIT,
  applyConfigPatch,
  asMinChars,
  describeConfig,
  effectiveConfig,
  loadGlobalConfig,
  loadSessionConfig,
  resolveConfig,
  type ConfigOverride,
  type ConfigScope,
} from "./lib/config.ts"
import {
  computeReport,
  loadUsage,
  recordToolUsage,
  saveStructureReport,
  skillIdOf,
  type ServerEntry,
  type SkillEntry,
  type ToolUsage,
} from "./lib/structure.ts"
import {
  DEDUP_MARKER,
  DEDUP_MIN_CHARS,
  addCompression,
  addDedup,
  addRecall,
  appendResultText,
  commandOf,
  compressResult,
  compressionEvent,
  dedupSignature,
  formatRecallIndex,
  SHELL_ONLY_TARGETS,
  TARGET_TOOLS,
  isTargetTool,
  loadRecall,
  loadRecentCompressions,
  loadRecentSignatures,
  pruneSession,
  recallNote,
  replaceResultText,
  resultTextOf,
  saveRecall,
  saveRecentCompressions,
  saveRecentSignatures,
  textLengthOf,
  type RecallEntry,
} from "./lib/toolhooks.ts"
import { SELECTOR_NAMES, isSelectorName, selectWith } from "./lib/selectors.ts"

/** Used only if the model's real context limit cannot be resolved. */
const DEFAULT_CONTEXT_LIMIT = 200_000

/**
 * Phase 3 state, created per `setup()` call — i.e. rebuilt on every hot reload,
 * and isolated between plugin instances. Nothing durable lives here: usage and
 * reports all go to `ctx.storage`.
 */
type StructureState = {
  /** Latest read-only catalog snapshot from the transform callbacks. */
  catalog: { servers: ServerEntry[]; skills: SkillEntry[] }
  /** Status is NOT in the transform config — only `ctx.mcp.list()` carries it. */
  statusCache?: { at: number; statuses: Map<string, string> }
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
 * during a config build — never in a session hook.
 */
function snapshotServers(
  editor: { list(): readonly (readonly [string, { type?: string; disabled?: boolean; codemode?: boolean }])[] },
  state: StructureState,
): void {
  state.catalog.servers = editor.list().map(([name, config]) => ({
    name,
    type: config.type === "local" ? "local" : "remote",
    disabled: config.disabled === true,
    // Left undefined when absent, which is correct: the MCP schema defaults
    // `codemode` to true, so an absent value means code mode.
    codemode: config.codemode,
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
      console.error(`[parsnip] ${label} failed (ignored):`, error)
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
    console.error(`[parsnip] ${label} registration failed (skipped):`, error)
  }
}

// --- Runtime config surfaces (tool + command) --------------------------------

const CONFIG_TOOL_NAME = "parsnip_config"

/** Longest stored form of the current task; the block truncates again on render. */
const MAX_TASK_CHARS = 240

const truncateTask = (text: string): string => truncate(text, MAX_TASK_CHARS)

/** Best-effort text from a command prompt (SDK prompt shape not pinned down). */
function promptText(prompt: unknown): string {
  if (typeof prompt === "string") return prompt
  if (Array.isArray(prompt)) return prompt.map(promptText).join(" ")
  if (prompt && typeof prompt === "object") {
    const p = prompt as Record<string, unknown>
    if (typeof p.text === "string") return p.text
    if (Array.isArray(p.parts)) return promptText(p.parts)
    if (typeof p.content === "string") return p.content
  }
  return ""
}

/**
 * Record an explicit config change as a continuity decision.
 *
 * Only *human/agent-initiated* toggles are recorded — a bare `parsnip_config`
 * view changes nothing and so records nothing. Best-effort: a failure here must
 * never fail the config write that triggered it.
 */
async function recordConfigDecision(
  ctx: Plugin.Context,
  sessionID: string,
  patch: ConfigOverride,
  scope: ConfigScope,
  reset = false,
): Promise<void> {
  const decision = describeDecision(patch, scope, reset)
  if (!decision) return
  try {
    const previous = await loadContinuity(ctx.storage, sessionID)
    const decisions = appendDecision(previous?.decisions ?? [], decision)
    if (!decisions) return
    await saveContinuity(ctx.storage, sessionID, {
      lastTask: previous?.lastTask ?? "",
      decisions,
      activeFiles: previous?.activeFiles ?? [],
      agent: previous?.agent,
      tokens: previous?.tokens,
      limit: previous?.limit,
      occupancy: previous?.occupancy,
      updatedAt: Date.now(),
      lastCommand: previous?.lastCommand,
    })
  } catch (error) {
    console.error("[parsnip] decision record failed (ignored):", error)
  }
}

/**
 * Agent-facing toggle, added to the tool catalog via `ctx.tool.transform`. The
 * model calls it to view or change compression/dedup (e.g. turn compression off
 * while doing critical work). Returns the resulting config as visible content.
 */
function configTool(ctx: Plugin.Context) {
  return {
    name: CONFIG_TOOL_NAME,
    description:
      "View or change parsnip's lossy tool-output transforms. compression = " +
      "truncate oversized tool output using the chosen selector; selector = which " +
      "compression backend to use; dedup = collapse a repeated identical large " +
      "result to a marker. minChars = compression threshold in characters " +
      "(default 4000; range 800-200000), which also sets how much is kept: " +
      "40% from the front, 30% from the back. Compression is lossy to the prompt " +
      "but lossless to the system: every dropped result is recoverable via " +
      "parsnip_recall, so a surprising omission is never a dead end. " +
      "Set session:true to scope a change to the current " +
      "session only (e.g. while doing critical work); otherwise it is global. " +
      "Values persist across restarts.",
    input: {
      type: "object",
      properties: {
        compression: { type: "boolean", description: "Enable/disable compression (default on)." },
        selector: {
          type: "string",
          enum: [...SELECTOR_NAMES],
          description: "Compression method used when compression is on (default extractive).",
        },
        dedup: { type: "boolean", description: "Enable/disable duplicate suppression." },
        searchCompression: {
          type: "boolean",
          description:
            "Also compress web-search and fetch results (default off). Search output is a " +
            "repeated record format (Title/URL/Highlights) and every selector breaks the " +
            "records apart, so excerpts end up separated from their sources. Dedup still " +
            "applies to search tools either way.",
        },
        minChars: {
          type: "integer",
          minimum: MIN_CHARS_LIMIT,
          maximum: MAX_CHARS_LIMIT,
          description:
            "Compression threshold in characters (default 4000). Also sets the kept budget: " +
            "40% head, 30% tail. Lower to compact mid-sized results too.",
        },
        session: { type: "boolean", description: "Scope the change to this session (default: global)." },
        reset: { type: "boolean", description: "Clear the override at the chosen scope (revert to defaults)." },
      },
      additionalProperties: false,
    },
    execute: async (rawInput: unknown, toolContext: { sessionID: string }) => {
      const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>
      const scope: ConfigScope = input.session === true ? "session" : "global"
      const reset = input.reset === true

      const patch: ConfigOverride = {}
      if (typeof input.compression === "boolean") patch.compression = input.compression
      if (isSelectorName(input.selector)) patch.selector = input.selector
      if (typeof input.dedup === "boolean") patch.dedup = input.dedup
      if (typeof input.searchCompression === "boolean") patch.searchCompression = input.searchCompression
      const minChars = asMinChars(input.minChars)
      if (minChars !== undefined) patch.minChars = minChars

      // A bare view writes nothing. Every field that can appear in `patch` must
      // be listed here: a field set but not checked reads as "no change" and the
      // setting is silently dropped.
      const changed =
        reset ||
        patch.compression !== undefined ||
        patch.selector !== undefined ||
        patch.dedup !== undefined ||
        patch.searchCompression !== undefined ||
        patch.minChars !== undefined
      if (changed) {
        await applyConfigPatch(ctx.storage, toolContext.sessionID, patch, { scope, reset })
        await recordConfigDecision(ctx, toolContext.sessionID, patch, scope, reset)
      }

      const [globalOverride, sessionOverride] = await Promise.all([
        loadGlobalConfig(ctx.storage),
        loadSessionConfig(ctx.storage, toolContext.sessionID),
      ])
      const effective = resolveConfig(globalOverride, sessionOverride)
      const headline = changed
        ? `parsnip config updated (scope: ${scope}${reset ? ", reset" : ""})`
        : "parsnip config"
      return {
        content: [
          {
            type: "text",
            text:
              `${headline}.\n` +
              `effective: ${describeConfig(effective)}\n` +
              `global override: ${JSON.stringify(globalOverride)}\n` +
              `session override: ${JSON.stringify(sessionOverride)}`,
          },
        ],
      }
    },
  }
}

const RECALL_TOOL_NAME = "parsnip_recall"

/**
 * Fold a retrieval into the session's savings ledger.
 *
 * This exists because compression is justified entirely by the claim that
 * nothing dropped is unrecoverable — and until this was added, the plugin
 * measured the dropping to the character while not measuring the recovering at
 * all. `misses` is the field to watch: the recall store is bounded at 1M chars /
 * 128 entries, so a rising miss rate is the early warning that drops are becoming
 * genuinely unrecoverable, which is the one thing the guarantee does not cover.
 */
async function countRecall(
  ctx: Plugin.Context,
  sessionID: string,
  event: { retrieved?: number; missed?: boolean; listed?: boolean },
): Promise<void> {
  // Best-effort by contract: the retrieval is already in hand by the time this
  // runs, so a storage failure must never turn a successful lookup — or an
  // index listing — into a tool error. Logged, not thrown, for the operator.
  try {
    await saveSavings(
      ctx.storage,
      sessionID,
      addRecall(await loadSavings(ctx.storage, sessionID), event),
    )
  } catch (error) {
    console.error("[parsnip] recall telemetry failed (ignored):", error)
  }
}

/**
 * Agent-facing recall, added to the tool catalog via `ctx.tool.transform`.
 * Compression is lossy to the prompt but lossless here: the omission marker in a
 * compressed result names a recall id, and this returns the full dropped text.
 *
 * Two modes, because an id alone is not always available. In context it is —
 * the marker names it. After a compaction it is not: the history is replaced by
 * a summary, the markers go with it, and the store survives without a pointer to
 * itself. Calling with no `id` lists the index, so recovery stays discoverable
 * rather than depending on the agent having remembered a handle.
 */
function recallTool(ctx: Plugin.Context) {
  return {
    name: RECALL_TOOL_NAME,
    description:
      "Retrieve tool output that parsnip dropped when it compressed an oversized " +
      "result. Compression is lossy to the prompt but lossless here. With an id " +
      "(named by the omission marker, e.g. recall-3) it returns the original bytes. " +
      "With NO id it lists what has been dropped this session — id, tool, size, time — " +
      "which is the way to recover dropped output after a compaction has replaced " +
      "the history. Use it whenever a compressed result looks like it is missing " +
      "something you need, or when you are unsure what a compaction threw away.",
    input: {
      type: "object",
      properties: {
        id: {
          type: "string",
          description:
            "Recall id from the omission marker, e.g. recall-3. Omit to list what has " +
            "been dropped this session instead of retrieving one entry.",
        },
      },
      additionalProperties: false,
    },
    execute: async (rawInput: unknown, toolContext: { sessionID: string }) => {
      const input = (rawInput && typeof rawInput === "object" ? rawInput : {}) as Record<string, unknown>
      const id = typeof input.id === "string" ? input.id.trim() : ""
      const state = await loadRecall(ctx.storage, toolContext.sessionID)

      // No id (or a blank one) lists the index rather than erroring. The previous
      // not-found message already spoke of "(no id given)", so this was always
      // the intended fallback — it just had nothing useful to say.
      if (id === "") {
        await countRecall(ctx, toolContext.sessionID, { listed: true })
        return { content: [{ type: "text", text: formatRecallIndex(state) }] }
      }

      const entry = state.entries.find((e) => e.id === id)
      const text = entry
        ? `parsnip recall ${id} — ${entry.inputChars} chars, tool ${entry.tool}:\n\n${entry.text}`
        : `parsnip: no cached text for ${id} — it may have been evicted, or the id is wrong.`

      // countRecall is best-effort by contract: a storage failure never costs
      // the agent its retrieval.
      await countRecall(
        ctx,
        toolContext.sessionID,
        entry ? { retrieved: entry.text.length } : { missed: true },
      )

      return { content: [{ type: "text", text }] }
    },
  }
}

/**
 * Human-facing toggle: `/parsnip compression off`, `/parsnip dedup on
 * session`, `/parsnip reset`. A V2 command cannot return output, so this
 * applies the change silently — confirm by calling the `parsnip_config` tool.
 */
function configCommand(ctx: Plugin.Context) {
  return {
    name: "parsnip",
    description:
      "View or change parsnip compression/dedup/selector: `/parsnip compression off`, " +
      "`/parsnip dedup on`, `/parsnip search on` (also compress web results; off by default), " +
      "`/parsnip selector head-tail`, " +
      "`/parsnip threshold 1500` (or `default`), " +
      "`/parsnip reset [session]`. Add `session` to scope to this session only. " +
      "`/parsnip recall <id>` looks up the full text a compression dropped (the " +
      "agent-facing path is the `parsnip_recall` tool).",
    execute: async (invocation: { sessionID: string; prompt: unknown }) => {
      const tokens = promptText(invocation.prompt).trim().toLowerCase().split(/\s+/).filter(Boolean)
      if (tokens.length === 0) return

      const scope: ConfigScope = tokens.includes("session") ? "session" : "global"
      const words = tokens.filter((token) => token !== "session")

      if (words[0] === "recall") {
        const id = words[1]
        const state = await loadRecall(ctx.storage, invocation.sessionID)
        const entry = state.entries.find((e) => e.id === id)
        // A V2 command cannot return output; log the outcome for the operator
        // (the `parsnip_recall` tool is the agent-facing retrieval path).
        console.error(
          `[parsnip] recall ${id ?? "(no id)"}: ${entry ? `${entry.text.length} chars` : "not found"}`,
        )
        return
      }

      if (words[0] === "reset") {
        await applyConfigPatch(ctx.storage, invocation.sessionID, {}, { scope, reset: true })
        await recordConfigDecision(ctx, invocation.sessionID, {}, scope, true)
        return
      }

      if (words[0] === "threshold") {
        // `/parsnip threshold 1500` (or `default` to hand the selector back its own).
        const raw = words[1]
        const patch: ConfigOverride = {}
        if (raw === "default") patch.minChars = undefined
        else {
          const minChars = asMinChars(Number(raw))
          if (minChars === undefined) return // silent on an out-of-range threshold
          patch.minChars = minChars
        }
        await applyConfigPatch(ctx.storage, invocation.sessionID, patch, { scope })
        await recordConfigDecision(ctx, invocation.sessionID, patch, scope)
        return
      }

      if (words[0] === "selector") {
        const name = words[1]
        if (!isSelectorName(name)) return // silent on an unknown selector
        await applyConfigPatch(ctx.storage, invocation.sessionID, { selector: name }, { scope })
        await recordConfigDecision(ctx, invocation.sessionID, { selector: name }, scope)
        return
      }

      const [field, value] = words
      const enabled = value === "on"
      if (value !== "on" && value !== "off") return // silent on unknown syntax
      const patch: ConfigOverride = {}
      if (field === "compression") patch.compression = enabled
      else if (field === "dedup") patch.dedup = enabled
      else if (field === "search") patch.searchCompression = enabled
      else return
      await applyConfigPatch(ctx.storage, invocation.sessionID, patch, { scope })
      await recordConfigDecision(ctx, invocation.sessionID, patch, scope)
    },
  }
}

const parsnip: Plugin.Plugin = {
  /**
   * Deliberately NOT the product name (`parsnip`).
   *
   * OpenCode namespaces plugin storage as `plugin:<utf16-hex(id)>:`, so this
   * string is the persistence namespace for everything the plugin records:
   * per-session recall (the full pre-compression text of dropped results),
   * savings, fidelity rings, dedup memory, usage and the structure report.
   *
   * Renaming it would silently orphan every existing key — the dropped text
   * exists nowhere else and cannot be regenerated. The visible name lives in
   * the repo, the directory, the tool names, the markers and the docs; this
   * stays as-is. If it ever must change, migrate the `kv` rows first.
   */
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

    // --- MCP catalog (read-only) --------------------------------------------
    // The snapshot is always taken; that is the whole job. The prune that used
    // to live here was removed 2026-10-03 — this plugin edits no config.
    await register(registrations, "mcp.transform", () =>
      ctx.mcp.transform(
        guarded("mcp.transform", (editor: MCPEditor) => {
          snapshotServers(editor, state)
        }),
      ),
    )

    // --- Skill catalog (read-only) ------------------------------------------
    // Skills are report-only: `Skill.Info` has no reversible off-switch.
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

    // --- Runtime config surfaces: agent tool + human command -----------------
    // Both write the persisted config (server/lib/config.ts) that execute.after
    // reads, so a toggle takes effect on the next tool call and survives
    // reloads/restarts.
    await register(registrations, "tool.transform", () =>
      ctx.tool.transform(
        guarded("tool.transform", (editor: ToolEditor) => {
          editor.add(configTool(ctx))
          editor.add(recallTool(ctx))
        }),
      ),
    )

    await register(registrations, "command.transform", () =>
      ctx.command.transform(
        guarded("command.transform", (editor: CommandEditor) => {
          editor.add(configCommand(ctx))
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

          await refreshStructure(ctx, state, event.sessionID)

          // INVARIANT: nothing above writes to event.messages / event.system /
          // event.tools. Keep it that way.
        }),
      ),
    )

    // --- Continuity: current task (read-only) --------------------------------
    //
    // `lastTask` was the third permanently-empty field: nothing wrote it, so the
    // block only ever saw the `lastUserText(messages)` fallback *at compaction
    // time* — i.e. the last thing said before the summary, not the task being
    // worked on. Capturing it here records the actual ask, and the fallback
    // stays in place for sessions that predate this hook.
    await register(registrations, "prompt", () =>
      ctx.session.hook(
        "prompt",
        guarded("prompt", async (event) => {
          const task = promptInputText(event.prompt).trim()
          if (!task) return

          const previous = await loadContinuity(ctx.storage, event.sessionID)
          await saveContinuity(ctx.storage, event.sessionID, {
            lastTask: truncateTask(task),
            decisions: previous?.decisions ?? [],
            activeFiles: previous?.activeFiles ?? [],
            agent: previous?.agent,
            tokens: previous?.tokens,
            limit: previous?.limit,
            occupancy: previous?.occupancy,
            updatedAt: Date.now(),
            lastCommand: previous?.lastCommand,
          })
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

          // Continuity fields this hook owns. `lastCommand` for shell targets;
          // `activeFiles` for file tools. Both are pure additions to whatever
          // the previous record held, so the two never clobber each other.
          const command = isTargetTool(event.tool) ? commandOf(event.input) : ""
          const file = filePathOf(event.tool, event.input)
          if (!command && !file) return

          const previous = await loadContinuity(ctx.storage, event.sessionID)
          const activeFiles = file ? appendActiveFile(previous?.activeFiles ?? [], file) : undefined

          await saveContinuity(ctx.storage, event.sessionID, {
            lastTask: previous?.lastTask ?? "",
            decisions: previous?.decisions ?? [],
            activeFiles: activeFiles ?? previous?.activeFiles ?? [],
            agent: event.agent,
            tokens: previous?.tokens,
            limit: previous?.limit,
            occupancy: previous?.occupancy,
            updatedAt: Date.now(),
            lastCommand: command || previous?.lastCommand,
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

          // Effective on/off comes from ctx.storage (session override -> global
          // override -> default), read fresh so a toggle takes effect next call.
          const config = await effectiveConfig(ctx.storage, event.sessionID)

          // Dedup first: a repeated large result collapses to a marker, and is
          // not re-added to the history (it is already there).
          if (config.dedup && text > DEDUP_MIN_CHARS) {
            const signature = dedupSignature(event.tool, event.input, resultTextOf(event.result))
            const recent = await loadRecentSignatures(ctx.storage, event.sessionID)
            if (recent.includes(signature)) {
              event.result = replaceResultText(event.result, DEDUP_MARKER)
              // Measure: the full text would have been committed otherwise.
              const saved = Math.max(0, text - DEDUP_MARKER.length)
              if (saved > 0) {
                await saveSavings(
                  ctx.storage,
                  event.sessionID,
                  addDedup(await loadSavings(ctx.storage, event.sessionID), text),
                )
                console.error(`[parsnip] savings session=${event.sessionID} event=dedup chars=${saved}`)
              }
              return
            }
            await saveRecentSignatures(ctx.storage, event.sessionID, [...recent, signature])
          }

          // Then compress with the configured selector. Only the result that is
          // about to be committed is rewritten — never the transcript.
          //
          // Search / retrieval results are excluded unless `searchCompression` is
          // on: measured over 28 recorded search documents, every selector breaks
          // the `Title:`/`URL:`/`Highlights:` records apart, keeping a title and
          // its excerpt together in only 6 of 71 cases. Dedup above is
          // unaffected — collapsing a byte-identical repeat is a different claim.
          const compressionTargets = config.searchCompression ? TARGET_TOOLS : SHELL_ONLY_TARGETS
          if (config.compression && isTargetTool(event.tool, compressionTargets)) {
            const selector = config.selector
            const threshold = config.minChars
            const compressed = compressResult(event.result, (part) =>
              selectWith(selector, part, threshold),
            )
            if (compressed !== event.result) {
              // Capture the pre-compression text for the fidelity diff, then
              // mutate first (the primary job) and measure best-effort: a
              // storage failure must never undo an already-applied compression.
              const beforeText = resultTextOf(event.result)
              const afterText = resultTextOf(compressed)
              event.result = compressed
              const compressedLen = textLengthOf(compressed)
              const omitted = text - compressedLen
              if (omitted > 0) {
                await saveSavings(
                  ctx.storage,
                  event.sessionID,
                  addCompression(
                    await loadSavings(ctx.storage, event.sessionID),
                    selector,
                    text,
                    compressedLen,
                  ),
                )
                // Fidelity signal: fingerprint what this method dropped, so an
                // external eval can attribute context loss to a selector.
                const fidelity = compressionEvent({
                  selector,
                  tool: event.tool,
                  input: beforeText,
                  output: afterText,
                })
                const recent = await loadRecentCompressions(ctx.storage, event.sessionID)
                await saveRecentCompressions(ctx.storage, event.sessionID, [...recent, fidelity])

                // Recall cache: keep the FULL dropped text retrievable, and hang a
                // recall note off the compressed result so the agent can get it back.
                // This is the backstop for the fact that no selector can know a
                // priori what matters (see the salience eval).
                const recall = await loadRecall(ctx.storage, event.sessionID)
                const recallId = `recall-${recall.seq + 1}`
                const entry: RecallEntry = {
                  id: recallId,
                  tool: event.tool,
                  at: fidelity.at,
                  inputChars: beforeText.length,
                  inputHash: fidelity.inputHash,
                  sample: fidelity.omittedSample,
                  text: beforeText,
                }
                await saveRecall(ctx.storage, event.sessionID, {
                  seq: recall.seq + 1,
                  entries: [...recall.entries, entry],
                })
                event.result = appendResultText(event.result, `\n${recallNote(recallId, entry.sample)}`)

                console.error(
                  `[parsnip] savings session=${event.sessionID} selector=${selector} event=compress chars=${omitted} recall=${recallId}`,
                )
              }
            }
          }
        }),
      ),
    )

    // --- Real token usage capture (read-only observer) ------------------------
    // `session.usage.updated` carries the session's CUMULATIVE token usage
    // (confirmed against the OpenCode client, which assigns data.cost/tokens
    // straight onto session.info), so each write OVERWRITES `session:<id>:usage`
    // rather than folding. This is the authoritative token measurement that
    // replaces the uncalibrated chars/4 estimate: `cacheRead` shows whether the
    // live prefix stayed cached. Read-only with respect to the request — it only
    // writes ctx.storage. The stream is aborted on dispose.
    const usageAbort = new AbortController()
    try {
      const usageStream = ctx.event.subscribe({ signal: usageAbort.signal })
      void (async () => {
        try {
          for await (const event of usageStream) {
            // `ctx.storage` has no session cascade, so a plugin's per-session keys
            // are orphaned forever when a session is deleted — prune them here.
            // NOTE: this `pruneSession` is unrelated to the removed structure
            // prune; it only deletes `session:<id>:*` keys. The name collision
            // is deliberate — renaming it would touch the session-deleted path
            // for no benefit.
            if (event.type === "session.deleted") {
              try {
                const removed = await pruneSession(ctx.storage, event.data.sessionID)
                console.error(
                  `[parsnip] pruned ${removed} storage key(s) for deleted session ${event.data.sessionID}`,
                )
              } catch (error) {
                console.error("[parsnip] session prune failed (ignored):", error)
              }
              continue
            }
            if (event.type !== "session.usage.updated") continue
            try {
              await saveTokenUsage(
                ctx.storage,
                event.data.sessionID,
                tokenUsageFrom(event.data.tokens, event.data.cost),
              )
            } catch (error) {
              console.error("[parsnip] usage capture failed (ignored):", error)
            }
          }
        } catch (error) {
          // An abort ends the iterator normally; anything else is logged, not thrown.
          if (!usageAbort.signal.aborted) {
            console.error("[parsnip] event stream ended (ignored):", error)
          }
        }
      })()
    } catch (error) {
      console.error("[parsnip] event subscription failed (ignored):", error)
    }

    return async () => {
      usageAbort.abort()
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

export default parsnip
