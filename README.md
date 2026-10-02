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
  the model's real context limit. Strictly read-only. This estimate is the
  *occupancy signal only*; the authoritative token count is the usage ledger
  below.
- **Continuity state** — persisted per session via `ctx.storage`, so it survives
  plugin hot reloads (module state does not).
- **Tool-output compression** — `ctx.tool.hook("execute.after")` replaces an
  oversized `shell`/`bash` result with a compaction of it before it is
  committed. The method is chosen by a pluggable **selector**
  (`server/lib/selectors.ts`); all five are pure, synchronous, and faithful
  (the output is a verbatim subset of the input — a selector never invents
  content). Defaults: 4000-char threshold, 1600 head, 1200 tail. Swap with
  `ctxguard_config { selector }` or `/ctx-guard selector <name>` — the hook
  never changes.

  | Selector | Behaviour | Reach for it when |
  |---|---|---|
  | `head-tail` *(default)* | Head + tail with a counted omission marker | You want the predictable baseline |
  | `token-budget` | Same budget, cut on token boundaries so identifiers are never split | Output is full of long identifiers you'd hate to see sliced |
  | `log-compact` | Strips ANSI, collapses runs of identical lines (`[ctx-guard: ×N]`), then bounds with head-tail | Output is repetitive logs — best compression ratio by a wide margin |
  | `signal-preserving` | Head + tail plus bounded middle lines matching a diagnostic pattern (errors, `file:line`, hashes, URLs) | You are reading build/test/tool output and want the failures |
  | `extractive` | 3-line lead + tail plus the highest-scoring middle lines (position, length, signal, shape novelty) | Output is heterogeneous and you want the "interesting" lines |

  Every selector's dropped text is recoverable — see the recall cache below.
- **Duplicate suppression** — a repeated **byte-identical** large result
  (> 1000 chars) collapses to a marker. The signature is content-addressed —
  `tool + args + FNV-1a(output)` — so a re-run whose *output changed* never
  matches (a re-read of a mutable file, a re-run whose log differs). Applies to
  shell (`bash`/`shell`) and to search/retrieval tools (`websearch`,
  `parallel_web_search`/`web_fetch`, `firecrawl_search`/`scrape`); state-query
  tools (`read`, `grep`) are deliberately excluded. The per-session signature
  ring lives in `ctx.storage` under `session:<id>:toolHistory`, capped at 16.
- **Savings + fidelity ledgers** — every compression/dedup event folds its exact
  char delta into `session:<id>:savings`, with `bySelector` breaking the
  compression side down per method. A bounded `session:<id>:compressions` ring
  adds one fingerprint per compression: selector, char deltas, FNV-1a hashes of
  input/output/dropped region, and a 120-char sample of what was dropped — so
  context loss can be attributed to a specific method. See "Measuring effects".
- **Recall cache** — compression is lossy to the *prompt* but lossless to the
  *system*: the full pre-compression text of every dropped result is kept in a
  bounded `session:<id>:recall` store (1 MB / 128 entries, oldest evicted), and
  the compressed output gains a recall note naming the id (plus the dropped-region
  sample). The agent retrieves it with the `ctxguard_recall` tool; a human with
  `/ctx-guard recall <id>`. This is the backstop for the fact that no selector —
  literal or model — can know a priori what matters (see the salience eval).
- **Real token usage** — the plugin subscribes to `session.usage.updated` and
  writes the session's cumulative usage to `session:<id>:usage` (`input`,
  `output`, `reasoning`, `cache.read`, `cache.write`, `cost`). This is the
  authoritative token measurement and it replaces the `chars / 4` estimate:
  `cache.read` is the cache-preservation signal (how much of the prompt was
  served from cache).
- **Structural report** — an unused/unusable MCP server + skill report computed
  and persisted per session, with an opt-in, double-gated, `disabled: true`-only
  prune path. Report-only by default (`STRUCTURE_PRUNE_ENABLED = false`).

Not yet implemented: a TUI status display (Phase 4). A read-only `status` RPC
exists on the unmerged `tui-footer-indicator` branch — the footer indicator it
was built for is not merged, so the plugin ships server-side only.

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
  eval.ts               known-answer eval: planted-fact recovery per selector (npm run eval)
  facts.ts              eval corpus: realistic outputs + planted facts
  export-facts.ts       dump the fact corpus to JSON for the Laya probe (npm run eval:export)
  lib/proxies.ts        pure proxies: signal/identifier/novel retention + fragments
  lib/recovery.ts       pure known-answer recovery scoring
  lib/laya.ts           pure Laya-scored selection (consumes a relevance map; no dependency)
  read-savings.ts       dump per-session tokens + static/reread char savings
  lib/reread.ts         the reread multiplier (chars × later model calls; pure)
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
npm run eval        # known-answer recovery of planted facts, per selector
npm run eval:export # dump the fact corpus to JSON for the out-of-process Laya probe
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

### Live, per session

Three ledgers are recorded in `ctx.storage`, and they measure different things.

1. **Real token usage (measured):** the plugin subscribes to
   `session.usage.updated` and stores the session's cumulative usage at
   `session:<id>:usage` — `input` (fresh, uncached), `output`, `reasoning`, and
   `cache.read` / `cache.write`. Total prompt input is
   `input + cache.read + cache.write`, and
   `cache.read / (input + cache.read + cache.write)` is the cache-preservation
   signal: a high ratio means the live prefix stayed cached. This is *measured
   provider usage*, not an estimate.
2. **Characters removed by the transforms (exact):** every
   compression/dedup folds its exact char delta into `session:<id>:savings`
   (`compressions`/`charsOmitted`, `dedups`/`charsDeduped`). For a compression
   the delta is `original - compressed`; for a dedup it is
   `original - marker.length`. These are **characters, not tokens** — they are
   never converted. `bySelector` breaks the compression side down per method
   (`compressions`/`charsOmitted`/`charsKept`), so methods compare directly.
3. **What each method dropped (per event):** a bounded
   `session:<id>:compressions` ring (cap 64) holds one record per compression —
   `selector`, `tool`, char deltas, FNV-1a `inputHash`/`outputHash`/`omittedHash`,
   and a 120-char `omittedSample`. `omittedHash` is the replay key: an external
   eval can ask "did dropping exactly this region break a known-answer query?"
   and attribute a failure to a selector. The dropped region is reconstructed
   from the longest common prefix/suffix of input and output — exact for
   `head-tail`, best-effort for reordering selectors.

### Offline, deterministic

These run against `bench/` corpora rather than your sessions. They are how the
selectors were compared before any of them ran in anger — and how the limits
below were found.

4. **Mechanism ceiling:** `npm run bench` pushes a realistic shell-output corpus
   through the pure `compressText` / dedup functions — a ~95% ceiling on the
   sample corpus.
5. **Selector comparison + fidelity proxies:** `npm run compare` pushes the
   curated corpus (`bench/corpus.ts`) through all five selectors and reports, per
   selector: ratio, uncalibrated ~tokens, four content-retention proxies — signal
   lines, identifiers, novel lines (exact and shape) — and a **fragment count**
   (identifiers the output emits cut mid-token; lower is better, 0 = every
   emitted identifier is whole). Retention cannot separate `head-tail` from
   `token-budget` — both keep the same char budget and a cut fragment never
   counts as retained — while the fragment proxy can: **9 vs 2** fragments over
   the corpus, `token-budget`'s 2 being the no-boundary fallback case only. The
   proxies compare *visible* text (ANSI stripped, so `log-compact`'s ANSI strip is
   not scored as lost content); ratios and token counts stay on the raw bytes.
6. **Known-answer recovery, by salience class:** `npm run eval` plants facts in
   realistic outputs and scores **literal recovery** per selector, grouped by
   **salience** — the shallow feature a selector could use to find a fact,
   *computed* (not hand-tagged) via the exported `SIGNAL_PATTERN` / `lineShape`:
   - `positional` (head/tail): ~100% for every selector (control).
   - `signal` (`SIGNAL_PATTERN`): `signal-preserving` 75%, `extractive` 75%,
     Laya 75%; positional selectors 0%.
   - `shape-novel` (unique `lineShape`): **`extractive` 100% — its own
     `novelty = 1/shapeCount` term, by construction**; everyone else 0% (Laya 45%).
   - `value` (no shallow feature — the hard class): **0% for every arm**,
     Laya included (one coincidental `log-compact` hit).
   Net: each "smart" selector wins exactly its own feature class *by
   construction*; **no** selector — literal or model — recovers non-salient
   content. This is why the earlier "extractive 93%" was circular, and it is now
   retired.
7. **Model-graded tier (optional):** given a Laya relevance map
   (`laya.json`, produced by a scratch Python probe over `npm run eval:export`
   output — Laya is out-of-process; no dependency), `npm run eval` adds a `laya`
   arm that keeps head + tail plus the middle lines Laya judged relevant.
   **Result (2026-10-01).** Question framing is the lever: a vague `noul` scores
   20% salient-class middle recovery, and a graded `score` rubric lifts it to
   **53%** (the fine-tuned `typed-decisions` head gives 47%, no better). That
   sits below `extractive`'s 93% **only on the salient class — a circular
   comparison (see item 6)**; on the non-circular **`value`** class (no shallow
   feature) Laya and `extractive` are **tied at 0%**. Laya's per-line ranking stays
   bimodal (git-diff facts #91-93/93). So the residual gap is the model, not the
   arm.
   (The load warning about "uncalibrated temperatures" is the shipped `choice:11+`
   bucket, which the `noul`/`score` questions don't use.) Details in Basic Memory.

`npm run savings` prints both live ledgers. It reads `opencode.db` directly
because plugin `console.log`/`console.error` does *not* reach `opencode.log`.
The old `~chars / 4` "token estimate" was an uncalibrated guess and has been
removed in favour of the measured `session.usage.updated` numbers.

### Static vs reread — why the two char numbers differ

Each session reports two char figures, and they measure different things:

- **`static`** — characters removed from the transcript *once*.
- **`reread`** — characters that were then **never re-transmitted**. Every model
  call re-sends the whole prompt, and the prompt is now permanently shorter, so
  each removed character would otherwise have been paid for on every later call.
  A compression made early is worth many times one made at the end.

The multiplier between them (`chars ÷ chars`, so no token guess is involved) is
the honest measure of the plugin's effect, and it runs **well above 1x** —
currently ~90x across all recorded sessions, i.e. the static figure understates
the real saving by roughly two orders of magnitude.

Computed in `bench/lib/reread.ts` from the per-compression timestamps in
`session:<id>:compressions` and the session's assistant-message timeline in
`session_message`. An assistant message with K tool parts counts as K+1
invocations, so the figure is a **lower bound**. Dedup is excluded — only an
aggregate is stored, with no per-event timestamps to weight — so it contributes
to `static` alone.

**Read this before judging the savings numbers:** native `tool_output`
truncation (`max_lines: 500` / `max_bytes: 20 000`) runs *before*
`execute.after`, so compression only earns its keep on results that are long but
**few-lined** (diffs, minified JSON, long single log lines). Duplicates are
caught either way. The savings ledger is the way to tell whether that actually
happens in your sessions.

## Notes

- The `chars / 4` heuristic in `lib/quality.ts` is an **occupancy estimate only**
  — it drives the `Context occupancy` line in the continuity block. It is not
  the plugin's token measurement: real provider usage is captured from
  `session.usage.updated` (see "Real token usage" above), and that is what
  `npm run savings` reports.
- Do not disable native auto-compaction — this plugin is designed to work with
  it.
- `file` content parts, `result.output`, and `result.metadata` are never
  touched — only text content is rewritten.
- The tool-hook events are `execute.before` (read-only; records the last command
  for continuity, and tool/skill usage for the structural report) and
  `execute.after` (the only mutating one).

