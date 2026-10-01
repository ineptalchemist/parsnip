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

## Status: Phase 3 (structural report) + runtime config switch

Implemented (server side):

- **Runtime config switch** — compression, selector and dedup are toggled at
  runtime and persist in `ctx.storage` (session override → global override →
  default). The agent toggles via the `ctxguard_config` tool; a human via
  `/ctx-guard`. See "Runtime config" below. Defaults: compression **OFF**,
  dedup **ON**, selector **head-tail**.
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
  oversized `shell`/`bash` result with a compaction of it before it is
  committed. The compaction is chosen by a pluggable **selector**
  (`server/lib/selectors.ts`); the default `head-tail` keeps
  `head + "… [ctx-guard: N chars omitted] …" + tail`. Defaults: 4000-char
  threshold, 1600 head, 1200 tail. A second selector, **`token-budget`**, keeps
  the same budget but cuts on token boundaries (after whitespace or a delimiter)
  so identifiers and words are never split. A third, **`log-compact`**, strips
  ANSI escapes and collapses runs of identical consecutive lines
  (`[ctx-guard: ×N]`), then bounds the result with head-tail — the highest ratio
  on repetitive output. A fourth, **`signal-preserving`**, keeps head + tail and
  rescues bounded middle lines matching a diagnostic pattern (errors, file:line,
  hashes, URLs) — the fidelity pick. A fifth, **`extractive`**, keeps a 3-line
  lead + tail plus the highest-scoring middle lines (position + length + signal).
  Swapping the selector — via `ctxguard_config` or `/ctx-guard selector <name>` —
  changes the method without touching the hook.
- **Duplicate suppression** — a repeated identical large result (> 1000 chars,
  same tool + arguments) collapses to a marker. The per-session signature ring
  lives in `ctx.storage` under `session:<id>:toolHistory`, capped at 16.
- **Savings ledger** — every compression/dedup event folds its exact char delta
  into a per-session tally in `ctx.storage` under `session:<id>:savings`. This is
  the measurement surface (see "Measuring effects").
- **Fidelity ledger** — `session:<id>:savings.bySelector` breaks the compression
  tally down per selector, and a bounded `session:<id>:compressions` ring records
  one fingerprint per compression: the selector, exact char deltas, FNV-1a hashes
  of the input / output / dropped region, and a 120-char sample of what was
  dropped. This is how context loss can be attributed to a specific method (see
  "Measuring effects").
- **Real token usage** — the plugin subscribes to `session.usage.updated` and
  writes the session's cumulative usage to `session:<id>:usage` (`input`,
  `output`, `reasoning`, `cache.read`, `cache.write`, `cost`). This is the
  authoritative token measurement and it replaces the old `chars / 4` estimate:
  `cache.read` is the cache-preservation signal (how much of the prompt was
  served from cache).
- **Structural report** (Phase 3) — an unused/unusable MCP server + skill report
  computed and persisted per session, with an opt-in, double-gated,
  `disabled: true`-only prune path. Report-only by default
  (`STRUCTURE_PRUNE_ENABLED = false`).

Not yet implemented: RPC + sidebar display (Phase 4), CLI plugin (Phase 5).

## Runtime config

Compression, selector and dedup are runtime-toggleable and persist in
`ctx.storage` (the `kv` table in `opencode.db`), so they survive reloads and
restarts. Precedence: **session override → global override → default**
(compression OFF, dedup ON, selector head-tail).

- **Agent:** call the `ctxguard_config` tool —
  `{ compression?, selector?, dedup?, session?, reset? }`. Set `session: true`
  to scope a change to the current session only (e.g. while doing critical
  work). It returns the resulting effective config.
- **Human:** run `/ctx-guard compression off`, `/ctx-guard dedup on`,
  `/ctx-guard selector head-tail`, `/ctx-guard reset [session]`. (V2 commands
  cannot return output, so this applies silently; confirm via the
  `ctxguard_config` tool.)
- **Read path:** `execute.after` reads the effective config fresh each call, so
  a toggle takes effect on the next tool call — no hot reload needed.


## Layout

```
server/
  index.ts              plugin entry: { id, setup } + hook wiring + tool/command
  lib/compaction.ts     buildContinuityBlock (pure)
  lib/config.ts         runtime compression/dedup/selector switch (persisted) + resolver
  lib/quality.ts        token estimate + occupancy (pure)
  lib/storage.ts        per-session continuity + savings + token usage (ctx.storage)
  lib/selectors.ts      pluggable compression selectors (head-tail, …) (pure, leaf)
  lib/toolhooks.ts      compression application + dedup + signatures + savings (pure)
  lib/structure.ts      structural report + prune plan (pure)
  *.test.ts             node:test suites (no framework)
bench/
  run.ts                offline ceiling benchmark (npm run bench)
  corpus.ts             curated 8-item corpus, one per differentiating axis (compare)
  compare.ts            cross-selector comparison: ratio + fidelity/fragment proxies
  lib/proxies.ts        pure proxies: signal/identifier/novel retention + fragments
  read-savings.ts       dump per-session tokens + char savings from opencode.db
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
npm test            # node --test 'server/**/*.test.ts' (Node strips types; no build step)
npm run test:bench  # node --test 'bench/**/*.test.ts' (proxy + fragment tests)
npm run bench       # offline ceiling benchmark (compression + dedup)
npm run compare     # per-selector ratio + fidelity/fragment proxies over the corpus
npm run savings     # dump per-session savings ledgers from opencode.db (read-only)
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

Two ledgers are recorded per session, and they measure different things.

1. **Real token usage (live, measured):** the plugin subscribes to
   `session.usage.updated` and stores the session's cumulative usage at
   `session:<id>:usage` — `input` (fresh, uncached), `output`, `reasoning`, and
   `cache.read` / `cache.write`. Total prompt input is
   `input + cache.read + cache.write`, and
   `cache.read / (input + cache.read + cache.write)` is the cache-preservation
   signal: a high ratio means the live prefix stayed cached. This is *measured
   provider usage*, not an estimate.
2. **Characters removed by the transforms (live, exact):** every
   compression/dedup folds its exact char delta into `session:<id>:savings`
   (`compressions`/`charsOmitted`, `dedups`/`charsDeduped`). For a compression
   the delta is `original - compressed`; for a dedup it is
   `original - marker.length`. These are **characters, not tokens** — they are
   never converted. `bySelector` breaks the compression side down per method
   (`compressions`/`charsOmitted`/`charsKept`), so methods compare directly.
3. **What each method dropped (live, per event):** a bounded
   `session:<id>:compressions` ring (cap 64) holds one record per compression —
   `selector`, `tool`, char deltas, FNV-1a `inputHash`/`outputHash`/`omittedHash`,
   and a 120-char `omittedSample`. `omittedHash` is the replay key: an external
   eval can ask "did dropping exactly this region break a known-answer query?"
   and attribute a failure to a selector. The dropped region is reconstructed
   from the longest common prefix/suffix of input and output — exact for
   `head-tail`, best-effort for reordering selectors.
4. **Mechanism ceiling (offline, deterministic):** `npm run bench` pushes a
   realistic shell-output corpus through the pure `compressText` / dedup
   functions — a ~95% ceiling on the sample corpus.
5. **Selector comparison + fidelity proxies (offline, deterministic):**
   `npm run compare` pushes the curated corpus (`bench/corpus.ts`) through all
   five selectors and reports, per selector: ratio, uncalibrated ~tokens, four
   content-retention proxies — signal lines, identifiers, novel lines (exact
   and shape) — and a **fragment count** (identifiers the output emits cut
   mid-token; lower is better, 0 = every emitted identifier is whole).
   Retention cannot separate `head-tail` from `token-budget` — both keep the
   same char budget and a cut fragment never counts as retained — while the
   fragment proxy can: **9 vs 2** fragments over the corpus, `token-budget`'s 2
   being the no-boundary fallback case only. The proxies compare *visible* text
   (ANSI stripped, so `log-compact`'s ANSI strip is not scored as lost
   content); ratios and token counts stay on the raw bytes.

`npm run savings` prints both live ledgers. It reads `opencode.db` directly
because plugin `console.log`/`console.error` does *not* reach `opencode.log`.
The old `~chars / 4` "token estimate" was an uncalibrated guess and has been
removed in favour of the measured `session.usage.updated` numbers.

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

