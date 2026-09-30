import { test } from "node:test"
import assert from "node:assert/strict"
import {
  COMPRESSION_OPTIONS,
  HEAD_CHARS,
  MIN_CHARS,
  SELECTORS,
  SELECTOR_NAMES,
  TAIL_CHARS,
  TOKEN_BUDGET_OPTIONS,
  compressText,
  compressTokenBudget,
  headTail,
  isSelectorName,
  omissionMarker,
  resolveSelector,
  selectWith,
  tokenBudget,
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
