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

## Status: Phase 3 (structural report) + savings ledger

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
- **Savings ledger** — every compression/dedup event folds its exact char delta
  into a per-session tally in `ctx.storage` under `session:<id>:savings`. This is
  the measurement surface (see "Measuring effects").
- **Structural report** (Phase 3) — an unused/unusable MCP server + skill report
  computed and persisted per session, with an opt-in, double-gated,
  `disabled: true`-only prune path. Report-only by default
  (`STRUCTURE_PRUNE_ENABLED = false`).

Not yet implemented: RPC + `token_status` (Phase 4), CLI plugin (Phase 5).


## Layout

```
server/
  index.ts              plugin entry: { id, setup } + hook wiring
  lib/compaction.ts     buildContinuityBlock (pure)
  lib/quality.ts        token estimate + occupancy (pure)
  lib/storage.ts        per-session continuity + savings (ctx.storage)
  lib/toolhooks.ts      compression + dedup + signatures + savings ledger (pure)
  lib/structure.ts      structural report + prune plan (pure)
  *.test.ts             node:test suites (no framework)
bench/
  run.ts                offline ceiling benchmark (npm run bench)
  read-savings.ts       dump per-session savings from opencode.db (npm run savings)
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
npm run bench     # offline ceiling benchmark (compression + dedup)
npm run savings   # dump per-session savings ledgers from opencode.db (read-only)
```

- Zero runtime dependencies. The only `devDependency` is `@opencode/plugin`
  (pinned to the installed OpenCode version, currently `2.0.20`) and it is used
  for **type-checking and API reference only** — every SDK reference in the
  source is an `import type`, which Node strips, so nothing is resolved at
  runtime.
- Node 24 runs the `.ts` sources directly via built-in type stripping. Keep
  types single-line-friendly: no multi-line nested function types inside
  `interface` bodies, and no constructor parameter properties.

## Measuring effects

There are three numbers that matter, and two are exact:

1. **Mechanism ceiling (offline, deterministic):** `npm run bench` pushes a
   realistic shell-output corpus through the pure `compressText` / dedup
   functions. It shows that any oversized result collapses to a fixed
   ~2.8k-char head+tail shape regardless of input size — a ~95% ceiling on the
   sample corpus.
2. **Real-world uptake (live, exact, per session):** the plugin folds every
   compression/dedup event into `session:<id>:savings` in `ctx.storage`. Read it
   back with `npm run savings`. **This is the authoritative channel** — plugin
   `console.log`/`console.error` does *not* reach `opencode.log`, so the log is
   not a measurement source. The savings values are exact chars: for a
   compression they are `original - compressed`, and for a dedup
   `original - marker.length`.
3. **Token cost (real, deferred):** `chars` must be converted to tokens. The
   `chars / 4` heuristic is uncalibrated; the log does emit real
   `session generation usage diagnostic` records (`AI.Usage` with
   `nonCachedInputTokens` / `cacheReadInputTokens`), but those are keyed by
   `run`/`span`, not session, so calibrating chars→tokens and measuring cache
   preservation is left as a follow-up (Phase 4's `token_status`).

A first live reading (the session that built this feature): 2 compressions
(−25 697 chars) + 1 dedup (−11 932 chars) = −37 629 chars ≈ −9 408 tokens
(`chars / 4`), including a single repeated 12 000-char command whose second run
collapsed to a 68-char marker.

Note: native `tool_output` truncation (`max_lines: 500` / `max_bytes: 20 000`)
runs *before* `execute.after`, so compression only earns its keep on results
that are long but **few-lined** (diffs, minified JSON, long single log lines).
Duplicates are caught either way. The savings ledger is the way to tell whether
that actually happens in your sessions.

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

