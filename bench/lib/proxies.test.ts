import { test } from "node:test"
import assert from "node:assert/strict"
import { SELECTORS } from "../../server/lib/selectors.ts"
import {
  RETAIN_PREFIX,
  fragments,
  identifiers,
  novelExactLines,
  novelShapeLines,
  pct,
  retainedIdentifiers,
  retainedLine,
  retainedLines,
  signalLines,
} from "./proxies.ts"

// --- signalLines ------------------------------------------------------------

test("signalLines: keeps diagnostics, file:line refs and URLs, drops prose", () => {
  const text = [
    "all good here",
    "ERROR: boom at src/foo.ts:42:7",
    "FATAL: migration failed",
    "see https://example.com/x",
    "just a normal line",
  ].join("\n")
  assert.deepEqual(signalLines(text), [
    "ERROR: boom at src/foo.ts:42:7",
    "FATAL: migration failed",
    "see https://example.com/x",
  ])
})

test("signalLines: ignores blank lines", () => {
  assert.deepEqual(signalLines("ERROR: boom\n\n"), ["ERROR: boom"])
})

// --- identifiers ------------------------------------------------------------

test("identifiers: distinct, length >= 2, charset includes . - _ $", () => {
  assert.deepEqual(identifiers("foo foo bar-baz qux.quux a $x"), [
    "foo",
    "bar-baz",
    "qux.quux",
    "$x",
  ])
})

test("identifiers: no word character means no identifiers", () => {
  assert.deepEqual(identifiers(""), [])
  assert.deepEqual(identifiers(".. ,, --"), [])
  assert.deepEqual(identifiers("--verbose"), ["--verbose"])
})

test("proxies: ANSI escapes are formatting, not content", () => {
  const colored = "\x1b[31mERROR handler timed out\x1b[0m"
  assert.deepEqual(signalLines(colored), ["ERROR handler timed out"])
  assert.deepEqual(identifiers(colored), ["ERROR", "handler", "timed", "out"])
  assert.equal(retainedLine(colored, "ERROR handler timed out"), true)
})

// --- novelExactLines --------------------------------------------------------

test("novelExactLines: a line occurring minRun times is not novel; blanks ignored", () => {
  const text = ["a", "a", "a", "b", "c", "c", ""].join("\n")
  assert.deepEqual(novelExactLines(text), ["b", "c", "c"])
})

test("novelExactLines: minRun is configurable", () => {
  const text = ["a", "a", "b"].join("\n")
  assert.deepEqual(novelExactLines(text, 2), ["b"])
  assert.deepEqual(novelExactLines(text, 3), ["a", "a", "b"])
})

// --- novelShapeLines --------------------------------------------------------

test("novelShapeLines: digits are masked, so near-duplicates collide", () => {
  const text = ["filler 0 x", "filler 1 x", "unique here", "another 9 y"].join("\n")
  assert.deepEqual(novelShapeLines(text), ["unique here", "another 9 y"])
})

test("novelShapeLines: a uniformly shaped log has no novel lines", () => {
  const text = ["task 1 done", "task 2 done", "task 3 done"].join("\n")
  assert.deepEqual(novelShapeLines(text), [])
})

// --- retention --------------------------------------------------------------

test("retainedLine: verbatim and 400-char-truncated forms both count", () => {
  const long = "a".repeat(500)
  const truncated = `${long.slice(0, RETAIN_PREFIX - 1)}…`
  assert.equal(retainedLine(`xx ${truncated} yy`, long), true)
  assert.equal(retainedLine(`xx ${long} yy`, long), true)
  assert.equal(retainedLine("zzz", "hello world"), false)
  assert.equal(retainedLine("", ""), false)
})

test("retainedLine: a fragment left by a raw char cut does not count", () => {
  assert.equal(retainedLine("...hello wor", "hello world"), false)
})

test("retainedLines / retainedIdentifiers: count survivors only", () => {
  const out = "alpha beta gamma"
  assert.equal(retainedLines(out, ["alpha", "beta", "delta", ""]), 2)
  assert.equal(retainedIdentifiers(out, ["alpha", "beta", "delta"]), 2)
})

// --- fragments --------------------------------------------------------------

test("fragments: head-tail's raw cut splits tokens, token-budget's snap does not", () => {
  const text = Array.from({ length: 100 }, (_, i) => `tok_${i}_${"x".repeat(60)}`).join(" ")
  assert.ok(text.length > 4000)
  assert.equal(fragments(text, SELECTORS["head-tail"].select(text)), 2)
  assert.equal(fragments(text, SELECTORS["token-budget"].select(text)), 0)
})

test("fragments: a verbatim (below-threshold) output has none", () => {
  const text = "alpha beta gamma delta"
  assert.equal(fragments(text, text), 0)
})

test("fragments: marker vocabulary is stripped before tokenizing", () => {
  const long = `middleware_${"a".repeat(500)}`
  const input = `${long} and more text`
  // Without stripping, the marker's "middle" would look like a fragment of
  // `middleware_aaa…`. Only the truncated long line is a real cut.
  const output = `${long.slice(0, 399)}… [ctx-guard: 5 signal line(s) from the omitted middle] …\nand more text`
  assert.equal(fragments(input, output), 1)
})

test("fragments: a “…”-truncated long line counts as one cut", () => {
  const long = `prefix_${"z".repeat(500)}`
  const input = `${long}\nsecond line`
  const output = `${long.slice(0, 399)}…\nsecond line`
  assert.equal(fragments(input, output), 1)
})

test("fragments: a 1-char cut is below the token minimum and not counted", () => {
  assert.equal(fragments("abcdefgh value", "a value"), 0)
})

test("fragments: a middle substring of an input id is not counted", () => {
  assert.equal(fragments("abcdefgh unique", "cdefg unique"), 0)
})

test("fragments: with no boundaries anywhere, both selectors cut (fallback)", () => {
  const text = "x".repeat(100_000)
  assert.equal(fragments(text, SELECTORS["head-tail"].select(text)), 2)
  assert.equal(fragments(text, SELECTORS["token-budget"].select(text)), 2)
})

// --- pct --------------------------------------------------------------------

test("pct: null for an empty class, a percentage otherwise", () => {
  assert.equal(pct(0, 0), null)
  assert.equal(pct(1, 4), 25)
  assert.equal(pct(3, 3), 100)
})
