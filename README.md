# ctx-guard

A cache-preserving context manager for OpenCode V2.

Long sessions get expensive because the prompt grows. The usual fix is to fold
stale history into summaries — but that rewrites the live conversation prefix and
throws away the provider's prompt cache. `ctx-guard` takes the opposite
approach: it never mutates the live prefix. It works only at the native
compaction boundary and (in a later phase) on new tool output entering the
window.

## Invariant

> The **only** surfaces allowed to alter content are:
> 1. the `compaction` hook (`event.system.push`), and
> 2. `tool.hook("execute.after")` on `status: "completed"` (`event.result` only),
>    which rewrites a result *about to be committed as new content*.
>
> The `context` hook is **strictly read-only** — it must never touch
> `event.messages`, `event.system`, or `event.tools`. `event.input` in the tool
> hooks is readonly and is never mutated.

This is the whole point of the plugin. It is enforced by review, not by the
compiler.

## Status: Phase 2 (tool hooks)

Implemented (server side):

- **Compaction injection** — `ctx.session.hook("compaction")` pushes a
  mode-aware continuity block (agent mode, current task, last command, recent
  decisions, active files, last occupancy reading) into the compaction system
  prompt. It does **not** set `event.result`, so the main model stays the
  summarizer.
- **Occupancy scoring** — `ctx.session.hook("context")` estimates tokens
  (`chars / 4`) across system + messages + tools and computes occupancy against
  the model's real context limit. Strictly read-only.
- **Continuity state** — persisted per session via `ctx.storage`, so it survives
  plugin hot reloads (module state does not).
- **Tool-output compression** — `ctx.tool.hook("execute.after")` replaces an
  oversized `shell`/`bash` result with `head + "… [ctx-guard: N chars omitted] …"
  + tail` before it is committed. Defaults: 4000-char threshold, 1600 head,
  1200 tail (`COMPRESSION_ENABLED`).
- **Duplicate suppression** — a repeated identical large result (> 1000 chars,
  same tool + arguments) collapses to a marker. The per-session signature ring
  lives in `ctx.storage` under `session:<id>:toolHistory`, capped at 16
  (`DEDUP_ENABLED`).

Not yet implemented: structural cleanup (Phase 3), RPC + `token_status`
(Phase 4), CLI plugin (Phase 5).


## Layout

```
server/
  index.ts              plugin entry: { id, setup } + hook wiring
  lib/compaction.ts     buildContinuityBlock (pure)
  lib/quality.ts        token estimate + occupancy (pure)
  lib/storage.ts        per-session continuity (ctx.storage)
  lib/toolhooks.ts      compression + dedup + signatures (pure)
  *.test.ts             node:test suites (no framework)
```

## How it loads

The server plugin is auto-discovered from the plugins directory. This repo is
symlinked into place:

```
~/.config/opencode/plugins/ctx-guard -> ~/projects/ctx-guard/server
```

No `opencode.jsonc` entry is needed. OpenCode hot-reloads plugins when a file in
the directory is touched — no service restart required.

## Development

```bash
npm test          # node --test 'server/**/*.test.ts' (Node strips types; no build step)
```

- Zero runtime dependencies. The only `devDependency` is `@opencode/plugin`
  (pinned to the installed OpenCode version, currently `2.0.19`) and it is used
  for **type-checking and API reference only** — every SDK reference in the
  source is an `import type`, which Node strips, so nothing is resolved at
  runtime.
- Node 24 runs the `.ts` sources directly via built-in type stripping. Keep
  types single-line-friendly: no multi-line nested function types inside
  `interface` bodies, and no constructor parameter properties.

## Notes

- The `chars / 4` token heuristic is uncalibrated. It is fine for a relative
  occupancy signal but must be checked against real provider usage before being
  trusted.
- Do not disable native auto-compaction — this plugin is designed to work with
  it.
- **Native `tool_output` truncation runs first.** OpenCode's own
  `tool_output.max_lines` / `max_bytes` (here 500 lines / 20000 bytes) caps a
  result *before* `execute.after` sees it, so compression only earns its keep on
  results that are long but few-lined (diffs, minified JSON, long log lines).
  Duplicates are still caught either way.
- `file` content parts, `result.output`, and `result.metadata` are never
  touched — only text content is rewritten.
- Where does the tool-hook invoke come from? `ctx.tool.hook` — the two events are
  `execute.before` (read-only; here it records the last command for continuity)
  and `execute.after` (the only mutating one).

