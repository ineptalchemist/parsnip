# Parsnip (parity + snip)

A cache-preserving token-snipper for [OpenCode](https://opencode.ai) V2. Parsnip compresses tokens
from specific tool calls (`bash`/`shell`, plus search and retrieval tools such as `websearch`, `web_fetch`,
`firecrawl_scrape`) with the goal of preventing repetitive or non-relevant 
tool outputs from being pushed through your agent's context window on every single prompt. This is ideal, as it 
saves you money. However, this is also not ideal, as missing context can lead you and your agent down
frustrating rabbit holes. 

So, Parsnip keeps the context it cuts preserved in a cache that your agent can reference if something looks off. 
All the information you need is preserved, your agents context window is cleared from debris, and you save a couple bucks. 

Designed to work in tandem with OpenCode's native token-compaction processes. So, compression hardly actually fires off. It only engages when a tool
returns something large *and* few-lined, which means the saving depends almost entirely on your workload — run `npm run savings` to see your own.
The effect compounds: because the prompt is now permanently shorter, compressed tokens are never re-transmitted on any later call, so the static
figure understates the real saving by roughly two orders of magnitude. And its free, with zero context actually stripped. Inspired by the [Token Optimizer](https://github.com/alexgreensh/token-optimizer) approach, 
which tries to avoid model-led summarization as it can be context-destructive and cost you more tokens in the long-run. 

This project was largely vibecoded, and thrown together very fast. It's still in its early stages, and was mostly conceived of as a way to learn about and measure types of 
token-compression and attempt context retrieval. It includes agent and cli-toggleable compression modes and a dedup that will fire very rarely. 

Long sessions get expensive because the prompt grows. The usual fix is to fold
stale history into summaries — but that rewrites the live conversation prefix and
throws away the provider's prompt cache. parsnip takes the opposite approach:
**it never mutates the live prefix.** It works only at the native compaction
boundary, and on new tool output as it enters the window.

Everything it drops is recoverable, and it publishes what it dropped.

## Nothing dropped is unrecoverable

This is the property that makes the rest defensible. Compression is lossy to the
**prompt** — the model sees a compacted result — but lossless to the **system**:
the full pre-compression text of every dropped result is kept, and the compacted
output carries a note naming it.

```
[parsnip: full text dropped — recall parsnip_recall("recall-3") — dropped region starts: "…"]
```

So the agent can answer from the compressed text *and verify*, for the cost of one
tool call:

```
parsnip_recall { id: "recall-3" }
```

A human gets `/parsnip recall <id>`, which only logs the size — V2 commands cannot
return output, so the tool is the real retrieval path. The store is bounded at
**1 MB / 128 entries per session**, oldest evicted first.

**Why this is a guarantee and not a promise.** A built-in known-answer eval plants
unique facts at controlled depths and scores what each compression method actually
recovers, grouped by *salience* — the shallow feature a method could use to find a
fact, computed rather than hand-tagged:

| salience class | best method | note |
|---|---|---|
| `positional` (head/tail) | 100% for all | control — every method keeps the edges |
| `signal` (error keywords, `file:line`, hashes) | `signal-preserving` 75% | *its own* pattern |
| `shape-novel` (unique line shape) | `extractive` 100% | *its own* `novelty = 1/shapeCount` term |
| `value` (no shallow feature at all) | **0% — one coincidental hit** | model-graded arm included |

The bottom row is the point. Each method wins exactly the class it was built for,
by construction — and on facts with nothing distinguishing about them, **nothing
reliably recovers them**. That is not a bug to be tuned away; it is why selection
cannot be trusted in the general case, and why retrieval has to exist.

### Prose is a different problem than logs

Logs carry redundancy for `log-compact` to collapse. A fetched article carries
none — every paragraph is a unique line. Measured on two prose fixtures (a
long-form article and a docs page, with facts planted at known depths), `extractive`
recovered **4/4** middle facts on both, while every other method recovered **2/4**
— and both of those from the head/tail the baseline keeps anyway.

Two caveats, because the number is flattering. `extractive` wins there on its own
salience class, since unique paragraph shapes are precisely what its novelty term
detects. And the `compare` harness cannot measure prose at all: `novel-x` saturates
at the kept fraction (26.1% across all five methods), so planted-fact recovery is
the only signal worth reading.

The general lesson is the one the recall cache exists for: **"it worked in that one
case" is not a safety property.** Selection can look reliable exactly where it
happens to succeed.

Dedup drops are not in the recall store — the original is already in context from
the first occurrence.

## Why the cache survives

Prompt caching only pays off if the prefix stays byte-identical. So parsnip is
built around a single rule, and the rule is narrow on purpose:

> **The only surfaces allowed to alter content are:**
> 1. the `compaction` hook (`event.system.push`), and
> 2. `tool.hook("execute.after")` on `status: "completed"` (`event.result` only),
>    which rewrites a result *about to be committed as new content*.
>
> The `context` hook is **strictly read-only** — it must never touch
> `event.messages`, `event.system`, or `event.tools`. `event.input` in the tool
> hooks is readonly and is never mutated.

Both surfaces operate on content that has not been sent to the provider yet.
Nothing already in the conversation is ever edited, so the cached prefix stays
intact. A regression test pins the read-only half of this.

Measured across recorded sessions: **96.6% of input tokens served from cache**
(`npm run savings`).

## Install

Requires Node 24 (the `.ts` sources run directly via built-in type stripping —
there is no build step) and OpenCode 2.0.20+.

```bash
git clone https://github.com/ineptalchemist/parsnip
npm install          # devDependency only; the plugin has zero runtime deps
```

Symlink the `server/` directory into OpenCode's plugins directory:

```bash
ln -s "$PWD/server" ~/.config/opencode/plugins/parsnip
```

No `opencode.jsonc` entry is needed — server plugins are auto-discovered. Editing
a file in the directory hot-reloads the plugin, so there is no service restart.

## Turning it on

Both toggles persist in `ctx.storage` and survive reloads and restarts. Precedence
is **session override → global override → default**.

**Defaults: compression ON, dedup ON, selector `extractive`, threshold 4000.**

Compression was opt-in from 2026-09-30 until 2026-10-03, pending the quality
harness. The harness landed and the verdict is two-sided: `extractive` wins its
own salience classes outright, while facts with *no* distinguishing feature are
recovered by nothing. That residual gap is why enabling compression by default
is defensible rather than careless — nothing dropped is unrecoverable, so the
worst case is a `parsnip_recall` call.

As the agent, call the `parsnip_config` tool:

```
parsnip_config { compression: true }              # turn compression on
parsnip_config { selector: "log-compact" }        # swap the method
parsnip_config { minChars: 1500 }                 # lower the threshold
parsnip_config { compression: false, session: true }  # this session only
parsnip_config                                     # view; changes nothing
```

As a human, run the slash command:

```
/parsnip compression off
/parsnip selector log-compact
/parsnip threshold 1500        # or: threshold default
/parsnip dedup on session
/parsnip reset
```

V2 commands cannot return output, so these apply silently — confirm with the
`parsnip_config` tool. `execute.after` reads the effective config fresh on every
call, so a toggle takes effect on the next tool call with no hot reload.

### The threshold

`minChars` sets both the gate **and** how much is kept: 40% from the front, 30%
from the back. Range 800–200000; an out-of-range value is rejected rather than
clamped. Because the budget always sits below the gate, the threshold is the
effective floor — nothing under it compacts.

The default stays at 4000 because sweeping lower costs more than it saves on the
results that matter. It is an escape hatch, not a better default; see
[NOTES.md](./NOTES.md) for the sweep.

## What it does

| Surface | What happens | Writes |
|---|---|---|
| `session.hook("compaction")` | Pushes a continuity block — agent mode, current task, last command, recent decisions, active files, last occupancy — into the compaction system prompt. Does **not** set `event.result`, so the main model stays the summarizer. | transcript (allowed) |
| `session.hook("context")` | Resolves the model's real context limit, estimates tokens, records an occupancy reading, refreshes the structure report. Strictly read-only. | storage |
| `session.hook("prompt")` | Records the current task. | storage |
| `tool.hook("execute.before")` | Records the last command (shell) or the active file (file tools), and tool/skill usage. `event.input` is never mutated. | storage |
| `tool.hook("execute.after")` | Deduplicates, then compresses, an oversized result before it is committed. The only mutating surface. | transcript (allowed) |
| `ctx.event.subscribe` | Captures real token usage from `session.usage.updated`; prunes a deleted session's storage keys. | storage |
| `mcp` / `skill` / `tool` / `command` transforms | Observe catalogs; inject the two agent tools and the slash command. | config |

Every other hook writes only to `ctx.storage`.

## Compression

Applies to shell (`bash`/`shell`) and search/retrieval tools (`websearch`,
`web_fetch`, `firecrawl_*`) over the threshold. All selectors are pure,
synchronous, and **faithful**: the output is a verbatim subset of the input — a
selector never invents content, only drops and adds delimited `[parsnip: …]`
markers carrying counts.

| Selector | Behaviour | Reach for it when |
|---|---|---|
| `head-tail` *(default)* | Head + tail with a counted omission marker | You want the predictable baseline |
| `token-budget` | Same budget, cut on token boundaries so identifiers are never split | Output is full of long identifiers you'd hate to see sliced |
| `log-compact` | Strips ANSI, collapses runs of identical lines (`[parsnip: ×N]`), then bounds with head-tail | Output is repetitive logs — best ratio by a wide margin |
| `signal-preserving` | Head + tail plus bounded middle lines matching a diagnostic pattern (errors, `file:line`, hashes, URLs) | You are reading build/test output and want the failures |
| `extractive` | 3-line lead + tail plus the highest-scoring middle lines (position, length, signal, shape novelty) | Output is heterogeneous and you want the "interesting" lines |

Every selector's dropped text is recoverable — see "Nothing dropped is
unrecoverable" above.

## Duplicate suppression

A repeated **byte-identical** large result (> 1000 chars) collapses to a marker.
The signature is content-addressed — `tool + args + FNV-1a(output)` — so a re-run
whose *output changed* never matches, which is the freshness hazard an args-only
key would create. Applies to shell and search/retrieval tools; state-query tools
(`read`, `grep`) are deliberately excluded. The per-session ring holds 16
signatures.

## What compression can and cannot do

`read` and `grep` are **not** compression targets. Neither are `result.output`,
`result.metadata`, or `{ type: "file" }` content parts, and error results are never
touched. Only the text content of a completed result from a target tool is
rewritten.

## Measuring effects

### Live, per session

`npm run savings` reads `opencode.db` directly (plugin console output does not
reach the log) and prints three things per session:

1. **Real token usage** — measured provider usage from `session.usage.updated`.
   Total prompt input is `input + cache.read + cache.write`; the
   `cache.read / total` ratio is the cache-preservation signal.
2. **Static chars removed** — the exact character delta each compression/dedup
   removed from the transcript, broken down per selector. Characters, not tokens;
   never converted.
3. **Reread chars** — see below.

Also recorded per compression, in a bounded ring: the selector, char deltas,
FNV-1a hashes of input/output/dropped region, and a 120-char sample of what was
dropped. The `omittedHash` is a replay key, so an external eval can ask "did
dropping exactly this region break a known-answer query?" and attribute the
failure to a specific method.

### Static vs reread

Two char figures are reported because they measure different things:

- **static** — characters removed from the transcript *once*.
- **reread** — characters then **never re-transmitted**. Every model call re-sends
  the whole prompt, and the prompt is now permanently shorter, so each removed
  character would otherwise have been paid for on every later call.

The multiplier between them (chars ÷ chars, so no token guess is involved) is the
honest measure of the effect. Across all recorded sessions at the time of writing
it runs **~109x** — a compression made early in a session is worth many times one
made at the end, which the static figure alone cannot show.

Computed from per-compression timestamps plus the session's assistant-message
timeline. An assistant message with K tool parts counts as K+1 invocations, so the
figure is a **lower bound**. Dedup is excluded — only an aggregate is stored, with
no per-event timestamps to weight — so it contributes to static alone.

### Offline, deterministic

| Command | Question it answers |
|---|---|
| `npm run bench` | Mechanism ceiling: how much could compression/dedup save on realistic shell output? |
| `npm run compare` | Selector comparison over a curated corpus — ratio, content-retention proxies, fragment count |
| `npm run sweep` | Threshold sweep across nine settings; decides the default |
| `npm run eval` | Known-answer recovery of planted facts, per selector, by salience class |

Selectors were compared this way before any ran in anger.

Retention proxies cannot separate `head-tail` from `token-budget` — both keep the
same budget, and a cut fragment never counts as retained. The fragment proxy can,
and does: **10 vs 2** fragments over the corpus, `token-budget`'s 2 being the
no-boundary fallback case only.

The proxies compare *visible* text (ANSI stripped, so `log-compact`'s ANSI strip
is not scored as lost content); ratios stay on raw bytes. They are retention
proxies, not a fidelity verdict — a threshold that holds every identifier while
destroying the argument connecting them scores well. Read them as a floor on
damage.

## Operational notes

- **Read before judging the numbers.** Native `tool_output` truncation
  (`max_lines: 500` / `max_bytes: 20000`) runs *before* `execute.after`, so
  compression only earns its keep on results that are long but **few-lined** —
  diffs, minified JSON, long single log lines. Duplicates are caught either way.
  The savings ledger is how you tell whether that actually happens in your
  sessions.
- **Prefer `read` over shell for file content.** `read` is not a compression
  target; `cat` / `grep` / `sed` / `head` are shell output and get compressed.
  Use shell to *compute over* bulk data, not to display it.
- **Recall when you see a marker you did not expect**, before answering from the
  compressed text.
- Do not disable native auto-compaction — this plugin is designed to work with it.
- `file` content parts, `result.output`, and `result.metadata` are never touched.
  Only text content is rewritten.
- The `chars / 4` heuristic in `lib/quality.ts` is an **occupancy estimate only**,
  used for the `Context occupancy` line in the continuity block. It is not the
  plugin's token measurement.
- The structure report (unused/unusable MCP servers and skills) is report-only.
  The prune path is off by default, double-gated, and only ever sets
  `disabled: true` — never removes an entry, since removal would lose
  `command`/`url`/`oauth`.

## Development

```bash
npm test            # node --test 'server/**/*.test.ts'
npm run test:bench  # node --test 'bench/**/*.test.ts'
```

Everything else is a harness — see "Measuring effects".

Zero runtime dependencies. The only `devDependency` is `@opencode/plugin`, pinned
to the installed OpenCode version, and used for **types only** — every SDK
reference in the source is an `import type`, which Node strips.

Node 24 runs the `.ts` sources directly. Keep types single-line-friendly: no
multi-line nested function types inside `interface` bodies, and no constructor
parameter properties.

```
server/
  index.ts              plugin entry: { id, setup } + hook wiring + tool/command
  lib/selectors.ts      pluggable compression selectors (pure, leaf)
  lib/toolhooks.ts      result handling + dedup + savings/fidelity/recall (pure)
  lib/config.ts         persisted runtime config + resolver
  lib/compaction.ts     continuity block rendering (pure, leaf)
  lib/structure.ts      structural report + prune plan (pure)
  lib/storage.ts        per-session continuity + savings + token usage
  lib/quality.ts        token estimate + occupancy (pure, leaf)
  *.test.ts             node:test suites (no framework)
bench/
  run.ts                offline ceiling benchmark
  corpus.ts             curated 9-item corpus, one per differentiating axis
  compare.ts            cross-selector comparison
  threshold.ts          threshold sweep; decides the default
  eval.ts               known-answer eval: planted-fact recovery per selector
  facts.ts              eval corpus: realistic outputs (logs, diffs, prose) + planted facts
  export-facts.ts       dump the fact corpus to JSON for the relevance probe
  read-savings.ts       dump per-session tokens + static/reread savings
  lib/metrics.ts        shared metrics for compare + sweep
  lib/proxies.ts        retention proxies + fragment detection
  lib/recovery.ts       known-answer recovery + salience classification
  lib/reread.ts         the reread multiplier (pure)
  lib/laya.ts           relevance-scored selection (consumes a map; no dependency)
  *.test.ts             proxy / recovery / reread tests
```

Development history, the threshold analysis, the salience finding, and known gaps
are in [NOTES.md](./NOTES.md).
