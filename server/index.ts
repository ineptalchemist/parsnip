/**
 * ctx-guard — server plugin (MVP: compaction + occupancy + continuity).
 *
 * Cache-preservation invariant (the whole point of this plugin):
 *   The ONLY surfaces allowed to alter content are the `compaction` hook
 *   (event.system.push) and, in a later phase, tool.execute.after.
 *   The `context` hook is strictly READ-ONLY — it must never touch
 *   event.messages / event.system / event.tools.
 *
 * The default export is a plain `{ id, setup }` object (what `Plugin.define`
 * returns). All SDK references are `import type`, so nothing is resolved at
 * runtime and the plugin keeps zero runtime dependencies.
 */
import type { Plugin } from "@opencode/plugin"
import type { Registration } from "@opencode/plugin/promise/registration"
import type { SessionCompaction, SessionContext } from "@opencode/plugin/promise/session"
import type { Model } from "@opencode/schema/model"
import { buildContinuityBlock } from "./lib/compaction.ts"
import { measureContext } from "./lib/quality.ts"
import { loadContinuity, saveContinuity, type ContinuityState } from "./lib/storage.ts"

/** Used only if the model's real context limit cannot be resolved. */
const DEFAULT_CONTEXT_LIMIT = 200_000

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

const ctxGuard: Plugin.Plugin = {
  id: "ctx-guard",

  setup: async (ctx: Plugin.Context) => {
    const registrations: Registration[] = []
    const limits = new Map<string, number>()

    // --- Model limits (read-only) -------------------------------------------
    registrations.push(
      await ctx.model.transform((editor) => {
        for (const model of editor.list()) {
          limits.set(modelKey(model.providerID, model.id), model.limit.context)
        }
      }),
    )

    // --- Compaction injection ------------------------------------------------
    // Runs once per compaction request. `event.system` belongs to the outgoing
    // summarizer call, so this cannot invalidate the live prompt cache.
    registrations.push(
      await ctx.session.hook("compaction", async (event: SessionCompaction) => {
        const state = await loadContinuity(ctx.storage, event.sessionID)
        const block = buildContinuityBlock({
          agent: event.agent,
          state,
          messages: event.messages,
        })
        if (block) event.system.push({ type: "text", text: block })
        // Deliberately do NOT set event.result — keep the main model as the
        // summarizer (self-compaction would need a second model, which cannot
        // reach the opencode-go provider).
      }),
    )

    // --- Occupancy scoring (READ-ONLY) ---------------------------------------
    registrations.push(
      await ctx.session.hook("context", async (event: SessionContext) => {
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
        }
        await saveContinuity(ctx.storage, event.sessionID, next)

        // INVARIANT: nothing above writes to event.messages / event.system /
        // event.tools. Keep it that way.
      }),
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
