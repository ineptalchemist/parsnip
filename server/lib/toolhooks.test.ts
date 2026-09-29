import { test } from "node:test"
import assert from "node:assert/strict"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import {
  DEDUP_MARKER,
  asSignatures,
  commandOf,
  compressResult,
  compressText,
  isTargetTool,
  loadRecentSignatures,
  omissionMarker,
  replaceResultText,
  saveRecentSignatures,
  shouldCompress,
  signatureOf,
  stableJson,
  textLengthOf,
  toolHistoryKey,
} from "./toolhooks.ts"

const OPTS = { minChars: 100, headChars: 20, tailChars: 10 }

// --- isTargetTool -----------------------------------------------------------

test("isTargetTool: matches shell/bash case-insensitively, rejects others", () => {
  assert.equal(isTargetTool("shell"), true)
  assert.equal(isTargetTool("SHELL"), true)
  assert.equal(isTargetTool("bash"), true)
  assert.equal(isTargetTool("shellcheck"), true)
  assert.equal(isTargetTool("read"), false)
  assert.equal(isTargetTool("write"), false)
  assert.equal(isTargetTool("parallel_web_search"), false)
})

// --- shouldCompress / compressText -----------------------------------------

test("shouldCompress: boundary is exclusive at minChars", () => {
  assert.equal(shouldCompress("a".repeat(99), OPTS), false)
  assert.equal(shouldCompress("a".repeat(100), OPTS), false)
  assert.equal(shouldCompress("a".repeat(101), OPTS), true)
})

test("compressText: below the threshold is untouched", () => {
  const text = "a".repeat(100)
  assert.equal(compressText(text, OPTS), text)
})

test("compressText: keeps exact head and tail with a counted omission marker", () => {
  const text = `${"H".repeat(20)}${"m".repeat(71)}${"T".repeat(10)}`
  const out = compressText(text, OPTS)

  assert.ok(out.startsWith("H".repeat(20)))
  assert.ok(out.endsWith("T".repeat(10)))
  assert.equal(out, `H`.repeat(20) + `\n${omissionMarker(71)}\n` + "T".repeat(10))
  assert.match(out, /\[ctx-guard: 71 chars omitted\]/)
})

test("compressText: single-char edge with a zero threshold cannot go negative", () => {
  assert.equal(compressText("x", { minChars: 0, headChars: 20, tailChars: 10 }), "x")
  assert.equal(compressText("", { minChars: 0, headChars: 20, tailChars: 10 }), "")
})

test("compressText: a text that cannot shrink is returned verbatim", () => {
  const text = "a".repeat(30) // > minChars, but head+tail >= length
  assert.equal(compressText(text, { minChars: 10, headChars: 20, tailChars: 10 }), text)
})

// --- textLengthOf -----------------------------------------------------------

test("textLengthOf: sums string content and text parts only", () => {
  assert.equal(textLengthOf({ content: "abcd" }), 4)
  assert.equal(
    textLengthOf({
      content: [
        { type: "text", text: "abcd" },
        { type: "file", uri: "file:///x", mime: "text/plain" },
        { type: "text", text: "ef" },
      ],
    }),
    6,
  )
  assert.equal(textLengthOf({ output: { exit: 0 } }), 0)
  assert.equal(textLengthOf(undefined), 0)
})

// --- compressResult ---------------------------------------------------------

test("compressResult: compresses string content", () => {
  const result = { content: "a".repeat(150), metadata: { exit: 0 } }
  const out = compressResult(result, OPTS)

  assert.notEqual(out, result)
  assert.match(String(out.content), /chars omitted/)
  assert.deepEqual(out.metadata, { exit: 0 })
})

test("compressResult: array content compresses text parts and leaves file parts", () => {
  const file = { type: "file", uri: "file:///tmp/a.png", mime: "image/png" }
  const result = {
    content: [{ type: "text", text: "b".repeat(150) }, file],
    output: { exit: 0, truncated: false },
    metadata: { shell: "ok" },
  }
  const out = compressResult(result, OPTS)
  const parts = out.content as Array<Record<string, unknown>>

  assert.match(String(parts[0].text), /chars omitted/)
  assert.equal(parts[1], file)
  // output/metadata are deliberately untouched.
  assert.equal(out.output, result.output)
  assert.equal(out.metadata, result.metadata)
})

test("compressResult: immutable — the caller's object is not mutated", () => {
  const original = { content: [{ type: "text", text: "c".repeat(150) }] }
  const snapshot = JSON.stringify(original)
  compressResult(original, OPTS)
  assert.equal(JSON.stringify(original), snapshot)
})

test("compressResult: small or structured-only results return the same object", () => {
  const small = { content: "tiny" }
  assert.equal(compressResult(small, OPTS), small)

  const structured = { output: { exit: 0, output: "x".repeat(9000) } }
  assert.equal(compressResult(structured, OPTS), structured)

  const empty = {}
  assert.equal(compressResult(empty, OPTS), empty)
})

// --- replaceResultText ------------------------------------------------------

test("replaceResultText: replaces text parts, keeps file parts and output", () => {
  const file = { type: "file", uri: "file:///tmp/a.png", mime: "image/png" }
  const result = {
    content: [{ type: "text", text: "long output" }, file],
    output: { exit: 0 },
  }
  const out = replaceResultText(result, DEDUP_MARKER)
  const parts = out.content as Array<Record<string, unknown>>

  assert.equal(parts[0].text, DEDUP_MARKER)
  assert.equal(parts[1], file)
  assert.equal(out.output, result.output)
  assert.equal((result.content as Array<Record<string, unknown>>)[0].text, "long output")
})

// --- signatures -------------------------------------------------------------

test("signatureOf: identical inputs match, key order is irrelevant, args differ", () => {
  const a = signatureOf("shell", { command: "ls -la", cwd: "/tmp" })
  const b = signatureOf("shell", { cwd: "/tmp", command: "ls -la" })
  const c = signatureOf("shell", { command: "ls", cwd: "/tmp" })
  const d = signatureOf("bash", { command: "ls -la", cwd: "/tmp" })

  assert.equal(a, b)
  assert.notEqual(a, c)
  assert.notEqual(a, d)
})

test("stableJson: sorts nested keys, handles arrays and primitive edge cases", () => {
  assert.equal(stableJson({ b: 1, a: [{ d: 2, c: 3 }] }), '{"a":[{"c":3,"d":2}],"b":1}')
  assert.equal(stableJson(undefined), "undefined")
  assert.equal(stableJson(null), "null")
  assert.equal(stableJson("x"), '"x"')
})

test("stableJson: a cyclic input terminates instead of recursing forever", () => {
  const cyclic: Record<string, unknown> = { name: "loop" }
  cyclic.self = cyclic
  const out = stableJson(cyclic)
  assert.match(out, /\[deep\]/)
})

// --- command continuity -----------------------------------------------------

test("commandOf: reads command/cmd, trims, truncates, tolerates junk", () => {
  assert.equal(commandOf({ command: "  ls -la  " }), "ls -la")
  assert.equal(commandOf({ cmd: "echo hi" }), "echo hi")
  assert.equal(commandOf({ command: "" }), "")
  assert.equal(commandOf(null), "")

  const long = commandOf({ command: "x".repeat(500) }, 50)
  assert.equal(long.length, 50)
  assert.ok(long.endsWith("…"))
})

// --- dedup memory -----------------------------------------------------------

test("toolHistoryKey / asSignatures: namespaced, bounded, string-only", () => {
  assert.equal(toolHistoryKey("ses_1"), "session:ses_1:toolHistory")
  assert.deepEqual(asSignatures(undefined), [])
  assert.deepEqual(asSignatures("nope"), [])
  assert.deepEqual(asSignatures(["a", 2, null, "b"]), ["a", "b"])
  assert.deepEqual(asSignatures(["a", "b", "c"], 2), ["b", "c"])
})

test("recent signatures: round-trip through storage, capped at the memory size", async () => {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
  } as unknown as StorageDomain

  assert.deepEqual(await loadRecentSignatures(storage, "ses_1"), [])

  await saveRecentSignatures(storage, "ses_1", ["a", "b"], 3)
  assert.deepEqual(await loadRecentSignatures(storage, "ses_1"), ["a", "b"])

  await saveRecentSignatures(storage, "ses_1", ["a", "b", "c", "d"], 3)
  assert.deepEqual(await loadRecentSignatures(storage, "ses_1"), ["b", "c", "d"])
  // A different session has its own memory.
  assert.deepEqual(await loadRecentSignatures(storage, "ses_2"), [])
})
