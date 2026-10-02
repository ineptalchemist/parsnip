# ctx-guard — development notes

Working notes behind the README: how the design decisions were reached, and the
research threads that are not part of the shipped plugin. Nothing here is
load-bearing for using ctx-guard.

---

## Reading the threshold sweep

`npm run sweep` measures nine thresholds across five selectors, split into two
corpora on purpose:

- **`SMALL_CORPUS`** (six items, 775–3601 chars) sits *below* the default gate,
  so items only engage as the threshold descends past them. This is the marginal
  behaviour under test.
- **`CORPUS`** (eight items) is deliberately all *above* the default gate so every
  selector engages at every setting. `npm run compare` needs that; a threshold
  question needs the opposite, which is why the second corpus exists.

Pooled decision view (all five selectors):

| threshold | small removed | small ident | big removed | big ident |
|---|---|---|---|---|
| 800 | 52613 | 48.6% | 3394847 | 15.8% |
| 1200 | 46191 | 54.6% | 3384548 | 16.4% |
| 1500 | 39666 | 63.7% | 3377137 | 17.0% |
| 2000 | 32783 | 70.1% | 3363681 | 17.9% |
| 2500 | 23570 | 77.3% | 3350417 | 18.8% |
| 2800 | 20666 | 80.7% | 3343010 | 19.4% |
| 3200 | 13606 | 87.9% | 3333004 | 20.0% |
| 4000 | 0 | 100.0% | 3313754 | 21.1% |

**Why 4000 stays the default.** There is no knee. Each ~1200-char step down gains
~13–20k chars on the small corpus and costs 10–19pp of its identifier retention —
so the per-step numbers are not what decides it. What decides it is *which*
corpus pays:

- Bytes **gained** are all in small results (52613 at threshold 800, 0 at 4000).
- Retention **lost** is on large results (21.1% → 15.8%), because the kept budget
  scales with the threshold, so lowering it shrinks what big results keep too.

Meanwhile large-corpus removal barely moves: 3313754 → 3394847 is **+2.4%**. So a
lower threshold pays a large-corpus retention bill for a small-corpus byte gain.
The threshold is an escape hatch, not a better default.

### The bug that made every lower threshold inert

Before `budgetFor()` existed, the head/tail budget was a frozen `1600 + 1200 =
2800` while the gate sat at 4000. A selector only omits text once the input
exceeds `head + tail`, so the **frozen budget** was the binding constraint: a
1200-char input came back verbatim at `minChars` 4000, 2000 and 1000 alike.
Measured, not inferred.

`budgetFor(minChars)` now derives the budget as 40% head / 30% tail, so it always
sits below the gate and the **threshold becomes the effective floor**. Bisection
confirms the smallest input that compacts is `threshold + 1`. `budgetFor(4000)`
is exactly the historical 1600+1200, so un-overridden behaviour is byte-identical.

### Two lessons from the threshold work

1. **A threshold and a budget are two dials, and only one of them was wired.**
   Unit tests passed throughout — every selector test called `select(text)` and
   checked the shape, so a budget that never moved could not fail them.
2. **`minChars` was missing from the config tool's "did anything change" check.**
   Setting it alone was silently discarded: written nowhere, recorded nowhere.
   Again, unit tests passed; only calling the live tool caught it. The tool's
   `execute` path is now covered by an integration test.

The generalisable point: a config field is not wired until it appears in *three*
places — the resolver, the apply path, and the change detector. The third is the
one that gets forgotten, and it fails silently by construction.

---

## Salience: why "extractive 93%" was retired

An earlier eval reported `extractive` recovering 93% of planted facts. That number
was an artefact of how the facts were classified.

Facts were hand-tagged as `distinctive` or `plain`, which let the corpus author
decide — after the fact, and with knowledge of which selector would be run — what
counted as interesting. `extractive` then scored well on a test that had been
shaped around it.

The fix is to compute the class instead of tagging it (`bench/lib/recovery.ts`,
`salienceOf`), by asking *what shallow feature could a selector use to find this
fact?*:

- `positional` — in the head/tail, kept verbatim by everything (the control).
- `signal` — the line matches `SIGNAL_PATTERN`.
- `shape-novel` — the line's digit-masked `lineShape` is unique.
- `value` — none of the above. No shallow feature at all.

Now the circularity is visible rather than hidden. Current results:

| class | best arm | note |
|---|---|---|
| `positional` | ~100% for all | control |
| `signal` | `signal-preserving` 75%, `extractive` 75% | *its own* pattern |
| `shape-novel` | `extractive` 100% | *its own* `novelty = 1/shapeCount` term |
| `value` | **0% for every arm** | the hard class |

Each smart selector wins exactly its own feature class **by construction**, so
those columns are not evidence of general value-preservation. The honest finding
is the last row: **no selector — literal or model — recovers non-salient
content.** That is what motivated the recall cache: if nothing can pick the right
middle in advance, keep the whole thing retrievable.

---

## Model-graded tier (research thread, not shipped)

An out-of-process classifier (a local relevance model) was run as an extra eval
arm to see whether a model beats the literal heuristics. It runs as a scratch
Python probe over `npm run eval:export` output and writes a `laya.json`
relevance map; `bench/lib/laya.ts` consumes it with pure TS and turns it into a
faithful compaction. No dependency, nothing in `package.json`.

Findings worth keeping:

- **Question framing is the lever.** A vague single-question framing scored 20%
  salient-class middle recovery; a graded `score` rubric lifted it to **53%**. A
  typed-decision head scored 47% — no better.
- Compared against `extractive`, the Laya arm looked worse. But that comparison
  was on the salient class, which is circular (above). On the non-circular
  `value` class the two are **tied at 0%**.
- Per-line ranking stayed bimodal: it separated obvious signal from filler and
  did little in between.

So the residual gap is the model, not the arm. The experiment is parked; the
relevance-map plumbing is retained in `bench/` because it is the cheapest way to
re-run the comparison against any future local model.

---

## The `chars / 4` retirement

The plugin originally reported savings in tokens using `chars / 4`. That
conversion was never calibrated against a provider and quietly became the headline
number. It is now used in exactly two places, both labelled:

- `server/lib/quality.ts` `estimateTokens` — the occupancy reading only, so the
  continuity block has a cheap relative number.
- `bench/lib/metrics.ts` `tokensOf` — reported for continuity with older bench
  output.

The authoritative token measurement is the `session.usage.updated` ledger, which
is measured provider usage. The reread multiplier is chars ÷ chars, so no
conversion enters it at all.

---

## Phase history

- **Phase 0–1** — server core: compaction injection, occupancy, continuity state.
- **Phase 2** — tool hooks: shell-output compression + duplicate suppression.
- **Phase 3** — structural report (unused/unusable MCP servers and skills), plus
  the opt-in prune path. Report-only by default.
- **Later** — swappable selectors, persisted runtime config, content-addressed
  dedup, fidelity ledger, recall cache, per-session storage pruning, the derived
  threshold budget, and the reread multiplier.

### Fault isolation

Every hook body is wrapped in `guarded()` and every registration is attempted
independently by `register()`. This is not defensive decoration: during Phase 3
the plugin is symlinked live into the plugins directory, and a half-edited hook
throwing a `ReferenceError` made **every session unusable** until it was removed
by hand. A rejected registration is fatal because it makes `setup()` throw,
which fails the whole plugin load.

Practical consequence while editing: keep the repo loadable, or move the symlink
aside first.

---

## Known gaps

- **A TUI status display is unbuilt.** A read-only `status` RPC exists on a local
  `tui-footer-indicator` branch that is unmerged and not pushed, so it is
  unavailable to anyone cloning this repo. The plugin ships server-side only.
- **The structure report has no reader.** `asStructureReport` /
  `loadStructureReport` are tested and stable but nothing in production calls
  them — there is no UI surface yet. They exist so a future reader does not have
  to re-derive the stored shape.
- **`PRUNE_OPTIONS.unusedServers` is a footgun.** With it on, enabling the flag
  disables *every* server unused in the approving session. This was observed
  live: all five configured servers flipped, three of them healthy. The strong
  signal is `unusable` (`failed` / `needs_auth`), not "unused".
- **`validThreshold` (floor 200) and `MIN_CHARS_LIMIT` (800) are separate
  bounds.** Duplicated deliberately while `selectors.ts` stays a leaf module, but
  they can drift.