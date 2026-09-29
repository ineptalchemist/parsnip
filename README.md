# ctx-guard

A cache-preserving context manager for OpenCode V2.

Long sessions get expensive because the prompt grows. The usual fix is to fold
stale history into summaries — but that rewrites the live conversation prefix and
throws away the provider's prompt cache. `ctx-guard` takes the opposite
approach: it never mutates the live prefix. It works only at the native
compaction boundary and (in a later phase) on new tool output entering the
window.

## Invariant

> The **only** surfaces allowed to alter content are the `compaction` hook
> (`event.system.push`, and later tool.execute.after). The `context` hook is
> **strictly read-only** — it must never touch `event.messages`,
> `event.system`, or `event.tools`.

This is the whole point of the plugin. It is enforced by review, not by the
compiler.

## Status: Phase 1 (server core) — MVP

Implemented (server side):

- **Compaction injection** — `ctx.session.hook("compaction")` pushes a
  mode-aware continuity block (agent mode, current task, recent decisions,
  active files, last occupancy reading) into the compaction system prompt. It
  does **not** set `event.result`, so the main model stays the summarizer.
- **Occupancy scoring** — `ctx.session.hook("context")` estimates tokens
  (`chars / 4`) across system + messages + tools and computes occupancy against
  the model's real context limit. Strictly read-only.
- **Continuity state** — persisted per session via `ctx.storage`, so it survives
  plugin hot reloads (module state does not).

Not yet implemented: tool hooks (Phase 2), structural cleanup (Phase 3), RPC +
`token_status` (Phase 4), CLI plugin (Phase 5).

## Layout

```
server/
  index.ts              plugin entry: { id, setup } + hook wiring
  lib/compaction.ts     buildContinuityBlock (pure)
  lib/quality.ts        token estimate + occupancy (pure)
  lib/storage.ts        per-session continuity (ctx.storage)
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
