# Parsnip (parity + snip)

A low-profile, cache-preserving compressor for [OpenCode](https://opencode.ai) V2.
It trims oversized tool output before it lands in the transcript, so your agent's
context window stays clean and your bill stays small — and it never mutates the
live prompt prefix, so the provider's prompt cache survives. Measured across
recorded sessions: **96.6% of input tokens served from cache**.

Everything it drops is recoverable in one tool call. No summaries, no model in
the loop, no rewriting your conversation.

Parsnip is (a) largely vibecoded and
           (b) still a work in progress. 

So keep that in mind. That being said, I think it's a pretty safe, low-profile way to cut your context window by about 2-5%.

There's simple CLI tools you can call manually, but I mostly just
tell an agent what to activate. 

## Why

Long sessions are expensive because every model call re-sends the whole prompt.
The usual fix — folding stale history into summaries — rewrites the prefix and
throws the prompt cache away. Parsnip does the opposite: it touches tool output
only as it is *committed*, before it enters the window. A compression made early
is then paid for never again; measured across recorded sessions, the effective
saving runs **~109×** the static character delta.

Where it bites, measured on ~500 recorded calls: `websearch` clears the
compression threshold on **100%** of calls (avg 15.8k chars, *above* the native
20,000-byte cap the built-in truncation would have caught), `webfetch` on 93%,
plain `bash` on only 6%. The saving concentrates in search and retrieval, not
the shell. `npm run savings` prints the same figures for your own sessions.

## Install

```bash
git clone https://github.com/ineptalchemist/parsnip
npm install          # types-only devDependency; zero runtime deps
ln -s "$PWD/server" ~/.config/opencode/plugins/parsnip
```

Requires Node 24 (sources run via built-in type stripping — no build step) and
OpenCode 2.0.20+. Auto-discovered on next launch; no config entry, and edits
hot-reload. Then forget it: compression is on by default and announces itself
only when it drops something.

## The safety net: nothing dropped is unrecoverable

Compression is lossy to the *prompt* but lossless to the *system*. Every dropped
result is kept, and the compressed output names its handle:

```
[parsnip: full text dropped — recall parsnip_recall("recall-3") — dropped region starts: "…"]
```

The agent answers from the compressed text *and verifies*, for the cost of one
tool call. After a compaction the markers are gone, so a bare `parsnip_recall`
lists the index instead — id, tool, size, time — and says honestly how many
entries were evicted. The store is bounded (1M chars / 128 entries per session,
oldest first) and pruned on session deletion. Humans get `/parsnip recall <id>`.

Why a net, and not just careful selection? A built-in known-answer eval plants
facts at controlled depths and scores what each selector actually recovers. The
finding: every selector wins exactly the salience class it was built for — and
facts with no distinguishing feature are recovered by **nothing**, 0% for every
method, model-graded arm included. Selection cannot be trusted in general, so
retrieval has to exist. That sentence is the whole design.

## What it does

| Surface | Behaviour |
|---|---|
| `execute.after` | Collapses a byte-identical large result (content-addressed: a changed re-run never collapses), then compresses oversized results before commit. The only mutating surface. |
| `compaction` | Injects a continuity block (task, last command, decisions, active files, occupancy) into the *summarizer's* system prompt. The main model stays the summarizer. |
| `context` / `prompt` / `execute.before` / events | Occupancy readings, continuity state, usage ledger. Strictly read-only on the request. |

Only two surfaces may write content, and both operate on data not yet sent to
the provider. A regression test pins the read-only half.

**Defaults:** compression ON (shell output only), dedup ON, selector
`extractive`, threshold 4000 chars. Search output is deliberately not compressed
— every selector breaks the `Title:`/`URL:`/`Highlights:` record format apart,
separating excerpts from their sources (measured on 28 recorded documents; only
6 of 71 records kept title and excerpt together). Opt in with
`searchCompression: true`; dedup still applies to search tools either way.

Five pluggable selectors, all *faithful* — output is a verbatim subset of input
plus counted `[parsnip: …]` markers, never generated text:

| Selector | Reach for it when |
|---|---|
| `extractive` (default) | Heterogeneous output — lead + tail + highest-scoring middle lines |
| `head-tail` | Predictable baseline |
| `token-budget` | Long identifiers you'd hate to see sliced |
| `log-compact` | Repetitive logs — best ratio by a wide margin |
| `signal-preserving` | Build/test output — rescues error-shaped middle lines |

## Config

Both surfaces persist and take effect on the next tool call — no reload:

```
parsnip_config { compression: false, session: true }    # agent, this session only
/parsnip selector log-compact                           # human
/parsnip threshold 1500   /parsnip search on   /parsnip reset
```

Commands apply silently (V2 commands cannot return output) — confirm with
`parsnip_config`. Threshold range 800–200000; out-of-range is ignored rather
than clamped. The threshold is the effective floor and also sets the kept budget
(40% head / 30% tail); 4000 stays the default because sweeping lower trades
large-corpus retention for small-corpus bytes (the sweep is in
[NOTES.md](./NOTES.md)).

## Also: a compression test bench (early)

The same repo is a small harness for measuring compression methods — this half
is early and actively growing:

| Command | Question it answers |
|---|---|
| `npm run compare` | Five selectors over a curated corpus: ratio + retention proxies + fragment count |
| `npm run eval` | Known-answer recovery of planted facts, per selector, by computed salience class |
| `npm run sweep` | Threshold sweep across nine settings |
| `npm run bench` | Mechanism ceiling on realistic shell output |
| `npm run savings` | Live: real token usage, static chars removed, reread multiplier, and recall activity per session |

The known-answer eval computes salience rather than hand-tagging it, so a method
can't win its own class by authorial accident. Its headline — no selector,
literal or model, recovers non-salient content — is why the recall cache exists.
More harness, corpus, and arms to come.

## Operational notes

- Prefer `read` over shell for file content; `read` is not a compression target.
- Recall when you see a marker you didn't expect, before answering from the
  compressed text. Watch the `misses` count in `npm run savings` — a rising
  miss rate is the early warning that drops are becoming genuinely
  unrecoverable.
- Don't disable native auto-compaction — parsnip is designed to work with it.
- Error results, `result.output`, `result.metadata`, and `file` parts are never
  touched. Parsnip never edits your configuration (the structure report is
  read-only diagnostics; the prune was removed 2026-10-03).
- The `chars / 4` figure is an occupancy estimate only; the authoritative token
  measurement is the `session.usage.updated` ledger.

## Development

```bash
npm test            # server suites
npm run test:bench  # bench suites
```

Zero runtime dependencies — `@opencode/plugin` is types-only, pinned to the
installed OpenCode version. Node 24 runs the `.ts` sources directly. File map,
threshold analysis, the salience finding, and known gaps:
[NOTES.md](./NOTES.md).
