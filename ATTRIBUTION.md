# Context attribution — implementation walkthrough

`parsnip_context` answers the question accounting tools cannot: **what is
filling the window** — which tools and categories the context is made of — not
just what it cost. The design contract (measurement classes, blind spots,
bounds) lives in `NOTES.md` → "Context attribution". This file is the
implementation companion: where the data comes from, how it flows through the
plugin, and what each moving part guarantees.

## What was added

- `server/lib/attribution.ts` — ledger, snapshot parsing, report formatter,
  calibration (pure logic + storage helpers)
- `server/index.ts` — hook wiring (`execute.after`, `context`, usage events)
  and the `parsnip_context` tool
- `bench/calibrate.ts` — offline chars-per-token measurement (`npm run calibrate`)
- `NOTES.md` — the design contract and the calibration record

## Data sources and flow

    execute.after ────────→ session:<id>:attribution    per-tool counters
    context hook ─────────→ session:<id>:snapshot       last request composition
    session.usage.updated → session:<id>:usage          authoritative totals
                          → session:<id>:calibration    live chars/token ratio
                                  │
                                  ▼
                            parsnip_context             rendered report

Three measurement classes, never mixed:

- **exact** — observed character counts, as measured by the plugin
- **~estimated** — tokens, chars ÷ a chars-per-token ratio (calibrated live
  when possible, else the install-measured 3.5 fallback)
- **authoritative** — provider totals from `session.usage.updated`

## Tool-call capture — `execute.after` (`server/index.ts`)

The hook wraps the existing dedup/compression logic rather than replacing it:

    completed tool result
      → observedChars = textLengthOf(result)     (post native limits)
      → existing dedup / compression transforms
      → retainedChars = textLengthOf(result)     (post transforms; recall note included)
      → recordAttribution(...)                   (in a `finally`)

- Every completed call is recorded — including non-target tools like `read`.
- Error results are skipped entirely (`status !== "completed"`).
- `parsnip_context` excludes itself, so asking for a report never inflates it.
- Recording happens in a `finally`, so every early exit (non-target tool, empty
  result, dedup return) still counts.
- Structured-only results record a call with zero characters.
- The hook never alters what the existing transforms do; it only measures the
  result before and after them.

### Concurrency — `enqueue()` (`server/lib/attribution.ts`)

Load → fold → save is not atomic, and parallel tool calls can complete in the
same tick. Each session gets one promise chain: same-session writes serialize,
different sessions proceed independently, a rejected task reaches its caller
without breaking the chain, and drained chains are removed. Covered by a test
that uses deliberately delayed fake storage.

## Request snapshot — `context` hook (`server/index.ts`)

    context event
      → snapshotInputFromContext(event)   classify system / messages / tools
      → buildSnapshot(...)                merge, sort, cap at 64 tool rows
      → saveSnapshot(...)                 session:<id>:snapshot
      → noteSnapshot(...)                 arm the calibration pair

- Strictly read-only on the request: nothing writes to `event.messages`,
  `event.system`, or `event.tools`.
- Reflects what the request will actually carry — compressed and deduplicated
  results included.
- The part vocabulary is pinned to the installed `@opencode/ai` schema:
  `text`, `reasoning`, `tool-result` (which carries `name`), `media`,
  `compaction`, `effort`. Tool-call arguments and `effort` parts are
  deliberately not counted; media and file entries count as `[media]`/`[file]`
  placeholders; unnamed results land in `(unattributed)`.

## Storage keys

| key | written by | content |
|---|---|---|
| `session:<id>:attribution` | `execute.after` | per-tool counters (bounded, 256 rows) |
| `session:<id>:snapshot` | `context` hook | latest request composition |
| `session:<id>:calibration` | `context` + usage events | pairing state + measured ratio |
| `session:<id>:usage` | usage events | authoritative provider totals |

All four are covered by the existing `pruneSession()` prefix scan, so they die
with the session.

## The tool — `parsnip_context` (`server/index.ts` → `contextTool`)

Registered through `ctx.tool.transform` alongside `parsnip_config` /
`parsnip_recall`. Read-only; no model calls; no tool text stored or returned.

| scope | renders |
|---|---|
| `current` (default) | last request composition + provider totals |
| `session` | session-wide per-tool ledger + provider totals |
| `both` | all three blocks |

`topN` widens the per-tool lists (formatter clamps to 1–50, default 10). Empty
stores are stated explicitly, never silently blank.

## Calibration

### Offline — `bench/calibrate.ts` (`npm run calibrate`)

Per-message usage rows (`session_message`) carry each request's own prompt
tokens, so the difference between consecutive requests is exactly what the
added content cost. Comparing that with the chars added in between yields an
empirical ratio. Pairs spanning compaction/agent/model/location switches are
skipped.

Measured 2026-10-08 (282 sessions, 11,751 pairs): **3.47 weighted overall,
3.61 for additions ≥ 2000 chars**; per model the spread is ~3.3–3.9
(`deepseek-v4.1-flash` 3.65). Small pairs read lower because per-message
overhead tokens carry no chars. The 3.5 fallback is the rounded overall figure.

### Live — per session

`session.usage.updated` carries a **cumulative** reading — verified against the
kv table (the row equals the sum of the per-message token rows) — so the delta
between two readings is that request's **full** prompt tokens, paired with the
request's **full** snapshot chars. `noteUsage()` consumes the pending snapshot
only when it is fresh; title/compaction readings arrive without a snapshot, are
skipped, and still advance the baseline so the next delta stays clean.

Once a session has ≥ 3 pairs and ≥ 10k prompt tokens, the report switches its
label and divisor to the measured ratio. Ratios outside 2–6 are treated as
anomalous and fall back to 3.5. The report always states which ratio produced
its numbers.

> Development note: the first live implementation paired char *deltas* with
> token *deltas* — correct for the offline per-message source, wrong for the
> cumulative event — and clamped out. The kv sum check settled the semantics;
> the current pairing is the data-validated one.

## Safety model

- `guarded()` swallows hook-body failures; `register()` isolates registration
  failures. A broken hook must never take down a session, and a broken
  registration must never fail the whole plugin load.
- While editing live-loaded files (`server/index.ts`, `server/lib/*.ts`), the
  development protocol is: move `~/.config/opencode/plugins/parsnip` out of
  discovery → confirm `ctx-guard` is gone from `opencode plugin list` → edit →
  run the full suite → restore the symlink → confirm it loads → verify live.
- Live probes use a throwaway subagent session and read results back from the
  kv table; plugin console output does not reach `opencode.log`.

## Limitations

- Per-tool token figures are estimates; only provider totals are billing facts.
- Code-mode MCP calls surface as `execute`; inner calls are invisible to hooks.
- No backfill: counting starts when capture is enabled.
- Current session only; child sessions keep their own records.
- Media/files count as placeholders; the tool catalogue is a serialized-char
  proxy, not necessarily identical to provider wire encoding.
- `quality.ts` keeps chars/4 for the occupancy reading — a separate relative
  heuristic; changing it would alter compaction behavior.

## Tests

223 → 238 → 245 → 249 → 252 → 261 across the build. Coverage: ledger
accumulation and bounds, snapshot classification, storage round-trips, junk
tolerance, concurrent-write serialization, report formatting and scopes,
calibration pairing (fresh/stale/unpaired), ratio guards, and hook-level
wiring.
