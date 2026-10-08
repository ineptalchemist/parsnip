# File and function map

Where everything lives, and what each module owns. Mapped 2026-10-08 at commit
`0f9eda9` — an orientation snapshot, not a maintained index; when in doubt the
source wins. For the `parsnip_context` feature specifically, see
[`ATTRIBUTION.md`](./ATTRIBUTION.md).

## Repository layout

    parsnip/
    ├── README.md            public overview
    ├── NOTES.md             design contract, research threads, known gaps
    ├── ATTRIBUTION.md       parsnip_context implementation walkthrough
    ├── FILE_MAP.md          this file
    ├── package.json         scripts + the one types-only devDependency
    ├── server/              the plugin (Node runs the .ts sources directly)
    │   ├── index.ts         entrypoint: hooks, tools, commands, events
    │   ├── index.test.ts    wiring tests over a fake OpenCode context
    │   └── lib/             pure logic + storage helpers, one concern per file
    │       ├── attribution.ts   parsnip_context: ledger, snapshot, report, calibration
    │       ├── compaction.ts    continuity block injected at compaction
    │       ├── config.ts        persisted runtime config (global + session)
    │       ├── quality.ts       occupancy estimation + safe part extraction
    │       ├── selectors.ts     the five compression selectors
    │       ├── storage.ts       session storage: continuity, savings, usage
    │       ├── structure.ts     MCP/skill usage report
    │       └── toolhooks.ts     tool-result compression, dedup, recall
    └── bench/               measurement harness (not shipped behavior)
        ├── calibrate.ts     chars-per-token measurement
        ├── read-savings.ts  live savings + token reader
        ├── compare.ts       cross-selector corpus comparison
        ├── eval.ts          known-answer recovery eval
        ├── threshold.ts     threshold sweep
        ├── run.ts           mechanism-ceiling bench
        ├── corpus.ts, facts.ts, export-facts.ts
        └── lib/             pure bench helpers (metrics, proxies, recovery, reread, laya)

## Layering

    server/index.ts   I/O: OpenCode hooks, tool/command registration, event stream
    server/lib/*.ts   pure or storage-parameterized logic — unit-testable without OpenCode
    bench/            read-only measurement over the live SQLite database

`lib/` modules take the storage domain as a parameter and import only sibling
modules; the OpenCode SDK is `import type` only, so nothing resolves at runtime
— the plugin keeps zero runtime dependencies.

## `server/index.ts` — the entrypoint

| function | role |
|---|---|
| `createStructureState` | per-`setup()` runtime state (catalog, caches, attribution chains) |
| `modelKey` | provider/model cache key for context limits |
| `resolveLimit` | context-window limit via the model transform, list fallback |
| `snapshotServers` | MCP config snapshot inside the transform |
| `serverStatuses` | live MCP status (lazy, 5s TTL) |
| `serverEntries` | MCP config + status merge for the report |
| `skillEntries` | skill catalogue (transform snapshot, list fallback) |
| `hydrateUsage` | cached per-session tool/skill usage |
| `refreshStructure` | recompute + persist the structure report |
| `guarded` | hook-body error isolation (exported for tests) |
| `register` | per-registration error isolation |
| `recordUsageUpdate` | usage ledger overwrite + calibration pairing (exported for tests) |
| `promptText` | defensive prompt-text extraction (command payloads) |
| `recordConfigDecision` | log explicit config changes into continuity |
| `configTool` | the `parsnip_config` tool |
| `countRecall` | recall telemetry fold (best-effort) |
| `recallTool` | the `parsnip_recall` tool |
| `contextTool` | the `parsnip_context` tool |
| `configCommand` | the `/parsnip` command |

### Registered surfaces (inside `setup()`)

| surface | purpose |
|---|---|
| `compaction` hook | inject the continuity block into the summarizer prompt |
| `context` hook | occupancy reading, structure refresh, request snapshot, calibration arming |
| `prompt` hook | capture the current task for continuity |
| `execute.before` hook | tool/skill usage + last-command / active-files continuity |
| `execute.after` hook | compression, dedup, recall, attribution capture |
| `model.transform` | cache context-window limits |
| `mcp.transform`, `skill.transform` | read-only catalog snapshots |
| `tool.transform` | register `parsnip_config`, `parsnip_recall`, `parsnip_context` |
| `command.transform` | register `/parsnip` |
| event stream | `session.usage.updated` (usage + calibration), `session.deleted` (prune) |

## `server/lib/attribution.ts` — the attribution feature

### Ledger

| function | role |
|---|---|
| `emptyToolCounters`, `emptyLedger` | zeroed shapes |
| `cleanToolName` | trim; blanks land in `(unknown)` |
| `recordResult` | pure fold of one tool result into the ledger |
| `asAttributionLedger` | junk-tolerant narrowing; re-enforces the 256-row bound |
| `boundTools` (private) | evicts the smallest rows, counts evictions |
| `count` (private) | defensive non-negative integer coercion |

### Snapshot

| function | role |
|---|---|
| `snapshotInputFromContext` | classify system / messages / tools into bins |
| `buildSnapshot` | merge, sort, cap at 64 tool rows, fold overflow |
| `asContextSnapshot` | junk-tolerant narrowing |
| `loadSnapshot`, `saveSnapshot`, `snapshotKey` | `session:<id>:snapshot` storage |
| `textOfPart`, `toolResultChars` (private) | part text + result-value char counting |

### Report

| function | role |
|---|---|
| `estimatedTokensOf` | `ceil(chars / ratio)`; default 3.5 fallback |
| `formatAttributionReport` | renders the requested sections, picks calibrated vs fallback labels |
| `snapshotLines`, `ledgerLines`, `usageLines` (private) | section formatters |

### Capture

| function | role |
|---|---|
| `enqueue` | per-session promise chain for read-modify-write serialization |
| `recordAttribution` | load → fold → save through the chain |

### Calibration

| function | role |
|---|---|
| `emptyCalibration`, `asCalibration` | zeroed / narrowed calibration state |
| `noteSnapshot` | arms the pending snapshot (context hook) |
| `noteUsage` | pairs a cumulative usage reading with the pending snapshot |
| `calibrationRatio` | guards: ≥ 3 pairs, ≥ 10k tokens, ratio 2–6 |
| `calibrationSummary` | the small shape the formatter consumes |
| `loadCalibration`, `saveCalibration`, `calibrationKey` | `session:<id>:calibration` storage |

## `server/lib/` — supporting modules

### `storage.ts` — session state

| function | role |
|---|---|
| `sessionKey`, `asContinuity`, `loadContinuity`, `saveContinuity` | continuity record (`session:<id>`) |
| `filePathOf`, `appendActiveFile`, `describeDecision`, `appendDecision` | continuity fields |
| `savingsKey`, `asSavings`, `loadSavings`, `saveSavings` | compression/dedup savings ledger |
| `tokenUsageKey`, `asTokenUsage`, `tokenUsageFrom`, `loadTokenUsage`, `saveTokenUsage` | authoritative provider usage |

### `toolhooks.ts` — compression, dedup, recall

| function | role |
|---|---|
| `isTargetTool` (+ `SHELL_TOOLS`, `SEARCH_TOOLS`, `TARGET_TOOLS`, `SHELL_ONLY_TARGETS`) | which tools may be rewritten |
| `textLengthOf`, `resultTextOf` | result text measurement/extraction |
| `compressResult`, `replaceResultText`, `appendResultText` | result rewriting (immutable) |
| `signatureOf`, `dedupSignature`, `stableJson` | content-addressed repeat detection |
| `loadRecentSignatures`, `saveRecentSignatures` (+ `toolHistoryKey`) | dedup memory (16 entries) |
| `compressionEvent`, `loadRecentCompressions`, `saveRecentCompressions`, `omittedRegion`, `fnv1a` | fidelity ledger (ring of 64) |
| `loadRecall`, `saveRecall`, `formatRecallIndex`, `recallNote` | full-text recall store (1M chars / 128 entries) |
| `pruneSession` | deletes every `session:<id>:*` key on session deletion |
| `addCompression`, `addDedup`, `addRecall` | savings-ledger folds |
| `commandOf` (+ `MAX_COMMAND_CHARS`) | last-command capture for continuity |

### `quality.ts` — occupancy estimation

| function | role |
|---|---|
| `estimateTokens` | chars/4 — occupancy reading only, never billing |
| `safeJson` | JSON.stringify that never throws |
| `partText` | generic part-text extraction (media/result/input fallbacks) |
| `computeOccupancy`, `measureContext` | occupancy ratio for the continuity block |

### `compaction.ts` — continuity block

| function | role |
|---|---|
| `buildContinuityBlock` | renders task/decisions/files/occupancy for the summarizer |
| `truncate`, `percent`, `promptText`, `lastUserText` | helpers |

### `config.ts` — runtime configuration

| function | role |
|---|---|
| `asMinChars`, `asConfigOverride`, `resolveConfig`, `describeConfig` | validation + resolution + display |
| `loadGlobalConfig`, `saveGlobalConfig`, `clearGlobalConfig` | global override (`parsnip:config`) |
| `loadSessionConfig`, `saveSessionConfig`, `clearSessionConfig` | session override (`session:<id>:parsnip`) |
| `effectiveConfig`, `applyConfigPatch` | resolved config + patch application |

### `selectors.ts` — compression methods

| export | role |
|---|---|
| `SELECTOR_NAMES`, `isSelectorName`, `resolveSelector`, `selectWith` | registry + lookup + apply |
| `headTail`, `tokenBudget`, `logCompact`, `signalPreserving`, `extractive` | the five selectors (faithful: verbatim subsets + counted markers) |

### `structure.ts` — MCP/skill report

| function | role |
|---|---|
| `toolBelongsToServer`, `classifyServers`, `classifySkills`, `computeReport` | read-only classification |
| `appendUsage`, `asToolUsage`, `skillIdOf`, `loadUsage`, `recordToolUsage` | per-session usage sets |
| `saveStructureReport`, `asStructureReport`, `loadStructureReport` | persisted report |

## `bench/` — measurement harness

| script | command | answers |
|---|---|---|
| `calibrate.ts` | `npm run calibrate` | empirical chars-per-token (per model, weighted/median) |
| `read-savings.ts` | `npm run savings` | live token usage, chars removed, reread multiplier, recall activity |
| `compare.ts` | `npm run compare` | five selectors over a curated corpus: ratio + retention proxies |
| `eval.ts` | `npm run eval` | known-answer recovery by computed salience class |
| `threshold.ts` | `npm run sweep` | threshold sweep across nine settings |
| `run.ts` | `npm run bench` | mechanism ceiling on realistic shell output |
| `export-facts.ts` | `npm run eval:export` | export eval fixtures |

`calibrate.ts` internals: `partChars`, `assistantChars`, `promptTokens`
(per-message prompt size), the session walk, and `summarize` (weighted /
median / p10 / p90, grouped by model).

## Tests

| file | covers |
|---|---|
| `server/index.test.ts` | registration, hook wiring, tool behavior, calibration wiring (fake OpenCode context) |
| `server/lib/attribution.test.ts` | ledger, bounds, snapshot parsing, formatter, storage, concurrency, calibration math |
| `server/lib/storage.test.ts` | continuity/savings/usage round-trips + junk tolerance |
| `server/lib/toolhooks.test.ts` | compression, dedup, recall, pruning |
| `server/lib/selectors.test.ts` | selector behavior + budgets |
| `server/lib/quality.test.ts` | occupancy estimation |
| `server/lib/compaction.test.ts` | continuity block rendering |
| `server/lib/config.test.ts` | config resolution + patches |
| `server/lib/structure.test.ts` | classification + report assembly |
| `bench/*.test.ts` | bench helpers (metrics, proxies, recovery, reread, laya) |

## Data flows

    tool completes
      execute.after → existing transforms → recordAttribution → ledger

    model request prepared
      context hook → snapshotInputFromContext → buildSnapshot → snapshot + arm calibration

    provider usage arrives
      event stream → recordUsageUpdate → usage ledger + calibration pair

    report requested
      parsnip_context → load snapshot/ledger/usage/calibration → formatAttributionReport
