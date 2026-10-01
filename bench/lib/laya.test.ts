import { test } from "node:test"
import assert from "node:assert/strict"
import { HEAD_CHARS, TAIL_CHARS } from "../../server/lib/selectors.ts"
import { layaMarker, layaSelect, parseRelevance } from "./laya.ts"

/** Head/middle/tail blocks sized so the middle lines land in the middle band. */
function longText(): string {
  const lines: string[] = []
  lines.push("HEADFACT " + "a".repeat(60))
  for (let i = 0; i < 30; i += 1) lines.push(`head filler ${i} ${"h".repeat(60)}`)
  for (let i = 0; i < 60; i += 1) lines.push(`middle line ${i} ${"m".repeat(60)}`)
  for (let i = 0; i < 30; i += 1) lines.push(`tail filler ${i} ${"t".repeat(60)}`)
  lines.push("TAILFACT " + "t".repeat(60))
  return lines.join("\n")
}

test("layaSelect: keeps head + tail plus middle lines over threshold", () => {
  const text = longText()
  const lines = text.split("\n")
  const p = lines.map((line) => (line.startsWith("middle line 30") ? 0.9 : 0.1))
  const out = layaSelect(text, p, 0.5)

  assert.ok(out.includes("HEADFACT"), "head kept")
  assert.ok(out.includes("TAILFACT"), "tail kept")
  assert.ok(out.includes("middle line 30"), "relevant middle line kept")
  assert.ok(!out.includes("middle line 0 "), "irrelevant middle line dropped")
  assert.match(out, /laya kept 1 of \d+ middle lines/)
  assert.ok(out.length < text.length, "must shrink")
})

test("layaSelect: nothing relevant → head + marker + tail (still shrinks)", () => {
  const text = longText()
  const out = layaSelect(text, text.split("\n").map(() => 0), 0.5)
  assert.match(out, /laya kept 0 of \d+ middle lines/)
  assert.ok(out.includes("HEADFACT") && out.includes("TAILFACT"))
  assert.ok(out.length < text.length)
})

test("layaSelect: below the gate is untouched", () => {
  const text = "short\n".repeat(10)
  assert.equal(layaSelect(text, text.split("\n").map(() => 1), 0.5), text)
})

test("layaSelect: a missing score counts as 0 (dropped)", () => {
  const text = longText()
  const out = layaSelect(text, [], 0.5)
  assert.match(out, /laya kept 0 of \d+ middle lines/)
})

test("layaMarker: reports counts", () => {
  assert.equal(layaMarker(2, 40), "… [ctx-guard: laya kept 2 of 40 middle lines] …")
})

test("parseRelevance: accepts a valid map, rejects junk", () => {
  const good = parseRelevance({ threshold: 0.5, items: { x: { task: "t", p: [0.1, 0.9] } } })
  assert.ok(good)
  assert.equal(good?.threshold, 0.5)
  assert.deepEqual(good?.items.x.p, [0.1, 0.9])

  assert.equal(parseRelevance(null), null)
  assert.equal(parseRelevance({ threshold: "x", items: {} }), null)
  assert.equal(parseRelevance({ threshold: 0.5, items: { x: { p: ["nope"] } } }), null)
})

test("constants: HEAD_CHARS + TAIL_CHARS are sane for the band math", () => {
  assert.ok(HEAD_CHARS > 0 && TAIL_CHARS > 0)
})
