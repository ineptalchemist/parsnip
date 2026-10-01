import { test } from "node:test"
import assert from "node:assert/strict"
import {
  COMPRESSION_OPTIONS,
  EXTRACTIVE_OPTIONS,
  HEAD_CHARS,
  LOG_COMPACT_OPTIONS,
  MIN_CHARS,
  SELECTORS,
  SELECTOR_NAMES,
  SIGNAL_OPTIONS,
  SIGNAL_PATTERN,
  TAIL_CHARS,
  TOKEN_BUDGET_OPTIONS,
  collapseRuns,
  compressExtractive,
  compressLog,
  compressSignal,
  compressText,
  compressTokenBudget,
  extractive,
  headTail,
  isSelectorName,
  lineShape,
  logCompact,
  omissionMarker,
  resolveSelector,
  scoreLine,
  selectWith,
  signalLines,
  signalPreserving,
  stripAnsi,
  tokenBudget,
  truncateLine,
} from "./selectors.ts"

// --- registry ---------------------------------------------------------------

test("registry: every SELECTOR_NAME has an entry, and ids match their keys", () => {
  for (const name of SELECTOR_NAMES) {
    const selector = SELECTORS[name]
    assert.ok(selector, `missing selector for ${name}`)
    assert.equal(selector.id, name)
    assert.equal(typeof selector.select, "function")
  }
  assert.deepEqual(Object.keys(SELECTORS).sort(), [...SELECTOR_NAMES].sort())
})

test("isSelectorName: accepts known names, rejects everything else", () => {
  assert.equal(isSelectorName("head-tail"), true)
  assert.equal(isSelectorName("nope"), false)
  assert.equal(isSelectorName(undefined), false)
  assert.equal(isSelectorName(1), false)
})

test("resolveSelector: known name resolves, unknown falls back to head-tail", () => {
  assert.equal(resolveSelector("head-tail"), SELECTORS["head-tail"])
  assert.equal(resolveSelector("does-not-exist"), headTail)
})

// --- head-tail selector -----------------------------------------------------

test("head-tail select: identical to the legacy compressText on the same options", () => {
  const big = "H".repeat(2000) + "m".repeat(5000) + "T".repeat(2000)
  assert.equal(headTail.select(big), compressText(big, COMPRESSION_OPTIONS))
  assert.equal(headTail.select("small"), "small")
})

test("head-tail select: faithful — the kept bytes are verbatim from the input", () => {
  const head = "H".repeat(HEAD_CHARS)
  const tail = "T".repeat(TAIL_CHARS)
  const text = `${head}${"m".repeat(MIN_CHARS)}${tail}`
  const out = headTail.select(text)

  const omitted = text.length - HEAD_CHARS - TAIL_CHARS
  // Removing the marker leaves exactly the verbatim head + tail — nothing added,
  // nothing reordered.
  const stripped = out.replace(`\n${omissionMarker(omitted)}\n`, "")
  assert.equal(stripped, head + tail)
  assert.equal(stripped.length, HEAD_CHARS + TAIL_CHARS)
  assert.match(out, /\[ctx-guard: 4000 chars omitted\]/)
})

test("head-tail select: below the threshold is untouched", () => {
  const text = "a".repeat(MIN_CHARS)
  assert.equal(headTail.select(text), text)
})

// --- selectWith -------------------------------------------------------------

test("selectWith: applies the named selector; unknown names fall back to head-tail", () => {
  const text = "x".repeat(MIN_CHARS + 1000)
  assert.match(selectWith("head-tail", text), /chars omitted/)
  assert.equal(selectWith("does-not-exist", text), selectWith("head-tail", text))
  assert.equal(selectWith("head-tail", "tiny"), "tiny")
})

// --- token-budget selector --------------------------------------------------

test("token-budget select: below the threshold is untouched", () => {
  const text = "a".repeat(TOKEN_BUDGET_OPTIONS.minTokens * 4)
  assert.equal(tokenBudget.select(text), text)
})

test("token-budget select: cuts on word boundaries, keeping whole words", () => {
  const text = "word ".repeat(3000)
  const out = tokenBudget.select(text)

  const head = out.slice(0, out.indexOf("\n… [ctx-guard:"))
  assert.ok(head.length > 0 && text.startsWith(head), "head must be a prefix")
  assert.equal(head.at(-1), " ", "head must end right after a boundary")
  assert.equal(head.length % 5, 0, "head must end on a word boundary")

  const tail = out.slice(out.lastIndexOf("\n") + 1)
  assert.ok(text.endsWith(tail), "tail must be a suffix")
  assert.equal((text.length - tail.length) % 5, 0, "tail must start on a word boundary")
})

test("token-budget select: no boundary in range falls back to the raw char cut", () => {
  const text = "x".repeat(8000) // one giant token: no boundary anywhere
  assert.equal(tokenBudget.select(text), compressText(text, COMPRESSION_OPTIONS))
})

test("token-budget select: never splits a surrogate pair on the fallback cut", () => {
  const text = `${"x".repeat(1599)}${"\u{1F600}".repeat(2000)}`
  const out = tokenBudget.select(text)
  const head = out.slice(0, out.indexOf("\n… [ctx-guard:"))
  const last = head.charCodeAt(head.length - 1)
  assert.ok(!(last >= 0xd800 && last <= 0xdbff), "head must not end on a lone high surrogate")
  assert.equal(head.length, 1599)
})

test("compressTokenBudget: overlapping windows return the text unchanged", () => {
  const text = "word word word word"
  assert.equal(
    compressTokenBudget(text, { minTokens: 0, headTokens: 4, tailTokens: 4, snapLimit: 0 }),
    text,
  )
})

// --- log-compact selector ---------------------------------------------------

test("stripAnsi: removes SGR and OSC escapes, leaving visible text", () => {
  assert.equal(stripAnsi("\x1b[31mred\x1b[0m"), "red")
  assert.equal(stripAnsi("\x1b]8;;http://example\x07link\x1b]8;;\x07"), "link")
  assert.equal(stripAnsi("plain text"), "plain text")
})

test("collapseRuns: a run >= minRun becomes one line plus a count marker", () => {
  assert.equal(collapseRuns("a\na\na\nb\n", 3), "a  [ctx-guard: ×3]\nb\n")
  // A pair is below minRun 3 and is left alone.
  assert.equal(collapseRuns("a\na\nb\n", 3), "a\na\nb\n")
  // Distinct lines are never collapsed.
  assert.equal(collapseRuns("a\nb\nc\n", 3), "a\nb\nc\n")
})

test("log-compact select: below the threshold is untouched", () => {
  const text = "x".repeat(LOG_COMPACT_OPTIONS.minChars)
  assert.equal(logCompact.select(text), text)
})

test("log-compact select: strips ANSI and collapses a repeated run", () => {
  const text = `${"\x1b[33mWARN timed out\x1b[0m\n".repeat(300)}done`
  const out = logCompact.select(text)
  assert.ok(!out.includes("\x1b"), "ANSI must be stripped")
  assert.match(out, /WARN timed out {2}\[ctx-guard: ×300\]/)
  assert.ok(out.endsWith("done"))
})

test("log-compact select: many distinct lines fall back to the head-tail bound", () => {
  const text = Array.from(
    { length: 600 },
    (_, i) => `distinct line number ${i} ${"p".repeat(30)}`,
  ).join("\n")
  assert.match(logCompact.select(text), /\[ctx-guard: \d+ chars omitted\]/)
})

test("log-compact select: retained lines are verbatim", () => {
  const text = `${"the quick brown fox\n".repeat(300)}tail`
  const out = logCompact.select(text)
  assert.ok(out.startsWith("the quick brown fox  [ctx-guard: ×300]"))
  assert.ok(out.endsWith("tail"))
})

test("compressLog: bounds a still-oversized result with the fallback", () => {
  const text = Array.from({ length: 400 }, (_, i) => `line ${i} ${"z".repeat(30)}`).join("\n")
  const out = compressLog(text, {
    minChars: 0,
    minRun: 3,
    fallback: { minChars: 0, headChars: 20, tailChars: 10 },
  })
  assert.match(out, /chars omitted/)
})

// --- signal-preserving selector ---------------------------------------------

test("SIGNAL_PATTERN: matches diagnostics, file:line and hashes; rejects prose", () => {
  assert.ok(SIGNAL_PATTERN.test("Fatal error: boom"))
  assert.ok(SIGNAL_PATTERN.test("at src/foo.ts:42:7"))
  assert.ok(SIGNAL_PATTERN.test("commit 0123456789abcdef0123456789abcdef01234567"))
  assert.ok(SIGNAL_PATTERN.test("see https://example.com/x"))
  assert.ok(!SIGNAL_PATTERN.test("all good here, nothing to see"))
})

test("signalLines: keeps matching lines in order, bounded by the caps", () => {
  const middle = ["plain", "ERROR one", "plain", "ERROR two"].join("\n")
  assert.deepEqual(signalLines(middle, SIGNAL_OPTIONS), ["ERROR one", "ERROR two"])

  const many = Array.from({ length: 40 }, (_, i) => `ERROR ${i}`).join("\n")
  assert.equal(signalLines(many, { ...SIGNAL_OPTIONS, maxSignalLines: 5 }).length, 5)
  assert.equal(
    signalLines(many, { ...SIGNAL_OPTIONS, maxSignalLines: 40, maxSignalChars: 20 }).length,
    2,
  )
})

test("signal-preserving select: below the threshold is untouched", () => {
  const text = "x".repeat(SIGNAL_OPTIONS.minChars)
  assert.equal(signalPreserving.select(text), text)
})

test("signal-preserving select: rescues a middle error line; head stays whole lines", () => {
  const head = Array.from({ length: 120 }, (_, i) => `head line ${i} ${"h".repeat(24)}`).join("\n")
  const mid = Array.from({ length: 400 }, (_, i) => `chatter ${i} ${"c".repeat(24)}`).join("\n")
  const tail = Array.from({ length: 120 }, (_, i) => `tail line ${i} ${"t".repeat(24)}`).join("\n")
  const text = `${head}\nERROR: the thing failed at src/foo.ts:42:7\n${mid}\n${tail}`

  const out = signalPreserving.select(text)
  assert.match(out, /ERROR: the thing failed at src\/foo\.ts:42:7/)
  assert.match(out, /signal line\(s\) from the omitted middle/)

  const headPart = out.slice(0, out.indexOf("\n… [ctx-guard:"))
  assert.ok(text.startsWith(headPart), "head must be a verbatim prefix")
  assert.ok(headPart.endsWith("\n"), "head must end at a line boundary")
})

test("signal-preserving select: no signal in the middle degenerates to head-tail", () => {
  const lines = Array.from({ length: 500 }, (_, i) => `chatter ${i} ${"c".repeat(24)}`)
  const out = signalPreserving.select(lines.join("\n"))
  assert.match(out, /\[ctx-guard: \d+ chars omitted\]/)
  assert.ok(!out.includes("signal line"), "no signal header when nothing matches")
})

test("signal-preserving select: a giant one-liner falls back to a bounded char cut", () => {
  const out = signalPreserving.select("x".repeat(8000))
  assert.match(out, /\[ctx-guard: \d+ chars omitted\]/)
  assert.ok(out.length < 3000, `expected a bounded result, got ${out.length}`)
})

// --- extractive selector ----------------------------------------------------

test("truncateLine: trims above the cap with an ellipsis", () => {
  assert.equal(truncateLine("abcdef", 10), "abcdef")
  assert.equal(truncateLine("abcdefghij", 5), "abcd…")
})

test("scoreLine: signal outranks a plain line; the ends outrank the middle", () => {
  const plain = "filler line with ordinary words"
  const mid = scoreLine(plain, 50, 100, EXTRACTIVE_OPTIONS)
  assert.ok(scoreLine(plain, 0, 100, EXTRACTIVE_OPTIONS) > mid, "head must outrank the middle")
  assert.ok(
    scoreLine("ERROR: boom", 50, 100, EXTRACTIVE_OPTIONS) > mid,
    "a signal line must outrank a plain line at the same position",
  )
})

test("extractive select: below the threshold is untouched", () => {
  const text = "x".repeat(EXTRACTIVE_OPTIONS.minChars)
  assert.equal(extractive.select(text), text)
})

test("extractive select: few long lines fall back to the head-tail bound", () => {
  const text = Array.from({ length: 10 }, (_, i) => `line ${i} ${"q".repeat(495)}`).join("\n")
  assert.match(extractive.select(text), /chars omitted/)
})

test("extractive select: keeps lead + tail and rescues the best middle line", () => {
  const lines = [
    "FIRST LINE",
    "second line",
    "third line",
    ...Array.from({ length: 200 }, (_, i) => `filler ${i} ${"f".repeat(30)}`),
    "penultimate",
    "last-1",
    "LAST LINE",
  ]
  lines[3 + 100] = "ERROR: unique diagnostic marker at src/bar.ts:9:9"
  const out = extractive.select(lines.join("\n"))

  assert.ok(out.startsWith("FIRST LINE\nsecond line\nthird line\n"))
  assert.ok(out.endsWith("penultimate\nlast-1\nLAST LINE"))
  assert.match(out, /kept \d+ of \d+ middle lines/)
  assert.ok(
    out.includes("ERROR: unique diagnostic marker"),
    "the diagnostic middle line must be kept",
  )
})

test("extractive select: retained lines are verbatim", () => {
  const lines = [
    "alpha first",
    "beta second",
    "gamma third",
    ...Array.from({ length: 200 }, (_, i) => `filler ${i} ${"f".repeat(30)}`),
    "delta penult",
    "epsilon last",
    "zeta final",
  ]
  const text = lines.join("\n")
  const out = extractive.select(text)

  for (const line of out.split("\n")) {
    if (line === "" || line.startsWith("… [ctx-guard:")) continue
    assert.ok(text.includes(line), `not verbatim: ${line}`)
  }
})

test("lineShape: masks digits so near-duplicate lines collapse", () => {
  assert.equal(lineShape("filler 0 fffff"), lineShape("filler 199 fffff"))
  assert.notEqual(lineShape("filler 0 fffff"), lineShape("unique line"))
})

test("extractive select: a novel non-signal middle line outranks repetitive fillers", () => {
  const lines = [
    "FIRST LINE",
    "second line",
    "third line",
    ...Array.from({ length: 200 }, (_, i) => `filler ${i} ${"f".repeat(30)}`),
    "penultimate",
    "last-1",
    "LAST LINE",
  ]
  lines[3 + 100] = "UNIQUE-MIDDLE-VALUE this dense line matters"
  const out = extractive.select(lines.join("\n"))

  assert.ok(out.includes("UNIQUE-MIDDLE-VALUE"), "a novel middle line must be kept")
})
