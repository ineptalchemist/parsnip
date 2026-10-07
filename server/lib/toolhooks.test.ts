import { test } from "node:test"
import assert from "node:assert/strict"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import {
  DEDUP_MARKER,
  addCompression,
  addDedup,
  asBySelector,
  asCompressionEvents,
  asSignatures,
  commandOf,
  compressResult,
  compressText,
  compressionsKey,
  compressionEvent,
  dedupSignature,
  emptySavings,
  fnv1a,
  isTargetTool,
  loadRecentCompressions,
  loadRecentSignatures,
  omissionMarker,
  omittedRegion,
  replaceResultText,
  resultTextOf,
  saveRecentCompressions,
  saveRecentSignatures,
  shouldCompress,
  signatureOf,
  stableJson,
  textLengthOf,
  toolHistoryKey,
  RECALL_CHAR_LIMIT,
  formatRecallIndex,
  RECALL_MEMORY,
  appendResultText,
  asRecallState,
  loadRecall,
  recallKey,
  recallNote,
  pruneSession,
  saveRecall,
} from "./toolhooks.ts"

const OPTS = { minChars: 100, headChars: 20, tailChars: 10 }
const select = (text: string) => compressText(text, OPTS)

// --- isTargetTool -----------------------------------------------------------

test("isTargetTool: matches shell/bash and search tools, rejects state-query tools", () => {
  // shell
  assert.equal(isTargetTool("shell"), true)
  assert.equal(isTargetTool("SHELL"), true)
  assert.equal(isTargetTool("bash"), true)
  assert.equal(isTargetTool("shellcheck"), true)
  // search / retrieval (case-insensitive substring, namespace-robust)
  assert.equal(isTargetTool("parallel_web_search"), true)
  assert.equal(isTargetTool("parallel.web_search"), true)
  assert.equal(isTargetTool("websearch"), true)
  assert.equal(isTargetTool("firecrawl_search"), true)
  assert.equal(isTargetTool("firecrawl.firecrawl_search"), true)
  assert.equal(isTargetTool("parallel_web_fetch"), true)
  // not targeted: state-query tools keep their freshness
  assert.equal(isTargetTool("read"), false)
  assert.equal(isTargetTool("read_file"), false)
  assert.equal(isTargetTool("grep"), false)
  assert.equal(isTargetTool("write"), false)
  assert.equal(isTargetTool("glob"), false)
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
  assert.match(out, /\[parsnip: 71 chars omitted\]/)
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
  const out = compressResult(result, select)

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
  const out = compressResult(result, select)
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
  compressResult(original, select)
  assert.equal(JSON.stringify(original), snapshot)
})

test("compressResult: small or structured-only results return the same object", () => {
  const small = { content: "tiny" }
  assert.equal(compressResult(small, select), small)

  const structured = { output: { exit: 0, output: "x".repeat(9000) } }
  assert.equal(compressResult(structured, select), structured)

  const empty = {}
  assert.equal(compressResult(empty, select), empty)
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

test("dedupSignature: identical (tool, input, output) match; changed output differs", () => {
  const input = { command: "ls -la", cwd: "/tmp" }
  // Key order in the input is irrelevant (inherited from signatureOf).
  assert.equal(
    dedupSignature("shell", input, "same bytes"),
    dedupSignature("shell", { cwd: "/tmp", command: "ls -la" }, "same bytes"),
  )
  // Changed output → different signature (the whole point: no stale collapse).
  assert.notEqual(
    dedupSignature("shell", input, "same bytes"),
    dedupSignature("shell", input, "same bytes!"),
  )
  // Different tool → different signature.
  assert.notEqual(
    dedupSignature("shell", input, "same bytes"),
    dedupSignature("bash", input, "same bytes"),
  )
  // Shape: starts with the args-keyed signature + an 8-hex content hash.
  assert.match(dedupSignature("shell", input, "same bytes"), /^shell:\{.*\}:[0-9a-f]{8}$/)
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

// --- savings ledger ---------------------------------------------------------

test("emptySavings: all fields zero, empty selector breakdown", () => {
  assert.deepEqual(emptySavings(), {
    compressions: 0,
    charsOmitted: 0,
    dedups: 0,
    charsDeduped: 0,
    bySelector: {},
    recall: { retrieved: 0, chars: 0, misses: 0, lists: 0 },
  })
})

test("addCompression: accumulates the exact omitted delta, globally and per selector", () => {
  let ledger = emptySavings()
  ledger = addCompression(ledger, "head-tail", 6000, 2800)
  assert.equal(ledger.compressions, 1)
  assert.equal(ledger.charsOmitted, 3200)
  assert.deepEqual(ledger.bySelector["head-tail"], {
    compressions: 1,
    charsOmitted: 3200,
    charsKept: 2800,
  })

  ledger = addCompression(ledger, "head-tail", 5000, 3000)
  assert.equal(ledger.compressions, 2)
  assert.equal(ledger.charsOmitted, 5200)
  assert.deepEqual(ledger.bySelector["head-tail"], {
    compressions: 2,
    charsOmitted: 5200,
    charsKept: 5800,
  })
})

test("addCompression: a second selector gets its own tally", () => {
  let ledger = addCompression(emptySavings(), "head-tail", 6000, 2800)
  ledger = addCompression(ledger, "log-compact", 10_000, 1000)
  assert.equal(ledger.compressions, 2)
  assert.deepEqual(ledger.bySelector["head-tail"], {
    compressions: 1,
    charsOmitted: 3200,
    charsKept: 2800,
  })
  assert.deepEqual(ledger.bySelector["log-compact"], {
    compressions: 1,
    charsOmitted: 9000,
    charsKept: 1000,
  })
})

test("addCompression: a zero/negative delta changes nothing", () => {
  const ledger = emptySavings()
  assert.equal(addCompression(ledger, "head-tail", 100, 100), ledger)
  assert.equal(addCompression(ledger, "head-tail", 100, 200), ledger)
})

test("addDedup: accumulates chars replaced by the marker", () => {
  const markerLen = DEDUP_MARKER.length
  let ledger = emptySavings()
  ledger = addDedup(ledger, 6000)
  assert.equal(ledger.dedups, 1)
  assert.equal(ledger.charsDeduped, 6000 - markerLen)

  ledger = addDedup(ledger, 4000, markerLen)
  assert.equal(ledger.dedups, 2)
  assert.equal(ledger.charsDeduped, 10000 - 2 * markerLen)
})

test("addDedup: nothing saved when the result is no larger than the marker", () => {
  const ledger = emptySavings()
  assert.equal(addDedup(ledger, DEDUP_MARKER.length), ledger)
  assert.equal(addDedup(ledger, 0), ledger)
})

// --- fidelity ledger --------------------------------------------------------

test("asBySelector: narrows malformed entries, coerces to finite numbers", () => {
  assert.deepEqual(asBySelector(undefined), {})
  assert.deepEqual(asBySelector([1, 2]), {})
  assert.deepEqual(
    asBySelector({ "head-tail": { compressions: 2, charsOmitted: 100, charsKept: 40 } }),
    { "head-tail": { compressions: 2, charsOmitted: 100, charsKept: 40 } },
  )
  // A junk tally is dropped; missing fields become 0.
  assert.deepEqual(asBySelector({ a: "nope", b: { compressions: 1 } }), {
    b: { compressions: 1, charsOmitted: 0, charsKept: 0 },
  })
})

test("fnv1a: deterministic, 8 hex chars, sensitive to content", () => {
  assert.match(fnv1a("hello"), /^[0-9a-f]{8}$/)
  assert.equal(fnv1a("hello"), fnv1a("hello"))
  assert.notEqual(fnv1a("hello"), fnv1a("hello!"))
  assert.equal(fnv1a(""), "811c9dc5")
})

test("resultTextOf: concatenates text parts; length matches textLengthOf", () => {
  const result = {
    content: [
      { type: "text", text: "abc" },
      { type: "file", uri: "file:///x" },
      { type: "text", text: "de" },
    ],
  }
  assert.equal(resultTextOf(result), "abcde")
  assert.equal(resultTextOf(result).length, textLengthOf(result))
  assert.equal(resultTextOf({ content: "xy" }), "xy")
  assert.equal(resultTextOf({ output: { exit: 0 } }), "")
  assert.equal(resultTextOf(undefined), "")
})

test("omittedRegion: recovers the exact dropped middle of a head-tail compression", () => {
  const O = { minChars: 100, headChars: 20, tailChars: 10 }
  const middle = "m".repeat(150)
  const text = `${"H".repeat(20)}${middle}${"T".repeat(10)}`
  assert.equal(omittedRegion(text, compressText(text, O)), middle)
})

test("compressionEvent: records chars, FNV-1a hashes, and a sample of the drop", () => {
  const input = `${"H".repeat(20)}${"m".repeat(150)}${"T".repeat(10)}`
  const output = compressText(input, { minChars: 100, headChars: 20, tailChars: 10 })
  const event = compressionEvent({ selector: "head-tail", tool: "shell", input, output, now: 7 })

  assert.equal(event.selector, "head-tail")
  assert.equal(event.tool, "shell")
  assert.equal(event.at, 7)
  assert.equal(event.inputChars, input.length)
  assert.equal(event.outputChars, output.length)
  assert.equal(event.omittedChars, input.length - output.length)
  assert.equal(event.inputHash, fnv1a(input))
  assert.equal(event.outputHash, fnv1a(output))
  assert.equal(event.omittedHash, fnv1a("m".repeat(150)))
  assert.equal(event.omittedSample, "m".repeat(120))
})

test("asCompressionEvents: keeps plausible events, bounded", () => {
  assert.deepEqual(asCompressionEvents(undefined), [])
  assert.deepEqual(asCompressionEvents("nope"), [])
  const events = asCompressionEvents([{ selector: "x", at: 1 }, "junk", { foo: 1 }])
  assert.equal(events.length, 1)
  assert.equal(events[0].selector, "x")
})

test("compression events: round-trip through storage, capped at the memory size", async () => {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
  } as unknown as StorageDomain

  assert.equal(compressionsKey("ses_1"), "session:ses_1:compressions")
  assert.deepEqual(await loadRecentCompressions(storage, "ses_1"), [])

  const make = (n: number) =>
    compressionEvent({
      selector: "head-tail",
      tool: "shell",
      input: "x".repeat(10 + n),
      output: "x",
      now: n,
    })

  await saveRecentCompressions(storage, "ses_1", [make(1), make(2)])
  assert.deepEqual(
    (await loadRecentCompressions(storage, "ses_1")).map((e) => e.at),
    [1, 2],
  )

  await saveRecentCompressions(storage, "ses_1", Array.from({ length: 70 }, (_, i) => make(i)))
  const kept = await loadRecentCompressions(storage, "ses_1")
  assert.equal(kept.length, 64)
  assert.equal(kept[kept.length - 1].at, 69)

  // A different session has its own ring.
  assert.deepEqual(await loadRecentCompressions(storage, "ses_2"), [])
})

// --- recall cache -----------------------------------------------------------

const memStorage = () => {
  const store = new Map<string, unknown>()
  return {
    storage: {
      get: async (key: string) => store.get(key),
      set: async (key: string, value: unknown) => void store.set(key, value),
    } as unknown as StorageDomain,
    store,
  }
}

const recallEntry = (n: number, bytes: number) => ({
  id: `recall-${n}`,
  tool: "shell",
  at: n,
  inputChars: bytes,
  inputHash: "h",
  sample: "s",
  text: "x".repeat(bytes),
})

test("asRecallState: narrows stored JSON, tolerating junk", () => {
  assert.deepEqual(asRecallState(undefined), { seq: 0, entries: [] })
  const good = recallEntry(1, 4)
  assert.deepEqual(asRecallState({ seq: 3, entries: [good, { id: "nope" }] }), {
    seq: 3,
    entries: [good],
  })
  assert.equal(asRecallState({ seq: -1, entries: "no" }).seq, 0)
})

// --- formatRecallIndex -------------------------------------------------------
//
// The index is what makes dropped output reachable after a compaction: the
// history (and its omission markers) is replaced, the store is not.

test("formatRecallIndex: an empty session says so plainly", () => {
  const out = formatRecallIndex({ seq: 0, entries: [] })
  assert.match(out, /nothing has been dropped/i)
  assert.equal(formatRecallIndex({ seq: 0, entries: [] }), out, "deterministic")
})

test("formatRecallIndex: entries all evicted is reported as eviction, not emptiness", () => {
  const out = formatRecallIndex({ seq: 9, entries: [] })
  assert.match(out, /no dropped text is retained/i)
  assert.match(out, /All 9 drop\(s\)/)
  assert.match(out, /evicted/)
})

test("formatRecallIndex: lists newest first with id, tool, size and a UTC clock", () => {
  const state = {
    seq: 2,
    entries: [
      { ...recallEntry(1, 1200), tool: "shell", at: Date.UTC(2026, 9, 3, 17, 52, 3) },
      { ...recallEntry(2, 34664), tool: "websearch", at: Date.UTC(2026, 9, 3, 18, 4, 9) },
    ],
  }
  const out = formatRecallIndex(state)
  const lines = out.split("\n").filter((l) => l.trim().startsWith("recall-"))

  assert.equal(lines.length, 2)
  assert.match(lines[0], /recall-2\s+websearch\s+34664 chars\s+18:04:09Z/)
  assert.match(lines[1], /recall-1\s+shell\s+1200 chars\s+17:52:03Z/)
  assert.ok(out.indexOf("recall-2") < out.indexOf("recall-1"), "newest first")
})

test("formatRecallIndex: never leaks the dropped text", () => {
  const secret = "SECRET-PAYLOAD-DO-NOT-LIST"
  const state = { seq: 1, entries: [{ ...recallEntry(1, secret.length), text: secret, sample: secret }] }
  const out = formatRecallIndex(state)
  assert.ok(!out.includes(secret), "entry text must not appear in the index")
})

test("formatRecallIndex: reports how many were evicted by the retention bound", () => {
  const out = formatRecallIndex({
    seq: 140,
    entries: [recallEntry(140, 10), recallEntry(139, 10)],
  })
  assert.match(out, /2 of 140 drop\(s\) retained/)
  assert.match(out, /138 evicted/)
})

test("formatRecallIndex: caps the listing and says how many were unlisted", () => {
  const entries = Array.from({ length: 5 }, (_, i) => recallEntry(i + 1, 10))
  const out = formatRecallIndex({ seq: 5, entries }, 3)

  const listed = out.split("\n").filter((l) => l.trim().startsWith("recall-"))
  assert.equal(listed.length, 3)
  assert.match(out, /and 2 older entries not listed/)
  assert.match(out, /still retrievable by id/)

  // Singular wording, so the message never reads as broken.
  assert.match(formatRecallIndex({ seq: 2, entries: entries.slice(0, 2) }, 1), /and 1 older entry not listed/)
})

test("recall: round-trips, keeps seq, and is bounded by entries and chars", async () => {
  const { storage, store } = memStorage()
  assert.deepEqual(await loadRecall(storage, "ses_1"), { seq: 0, entries: [] })

  // Entry cap.
  await saveRecall(storage, "ses_1", {
    seq: 40,
    entries: Array.from({ length: RECALL_MEMORY + 5 }, (_, i) => recallEntry(i, 1)),
  })
  let state = await loadRecall(storage, "ses_1")
  assert.equal(state.entries.length, RECALL_MEMORY)
  assert.equal(state.seq, 40) // seq is preserved through trimming
  assert.equal(state.entries.at(-1)?.id, `recall-${RECALL_MEMORY + 4}`)

  // Character cap: the oldest entries are evicted until under the limit.
  const big = Math.ceil(RECALL_CHAR_LIMIT / 4) + 10
  await saveRecall(storage, "ses_2", {
    seq: 5,
    entries: [1, 2, 3, 4, 5].map((n) => recallEntry(n, big)),
  })
  state = await loadRecall(storage, "ses_2")
  const chars = state.entries.reduce((n, e) => n + e.text.length, 0)
  assert.ok(chars <= RECALL_CHAR_LIMIT, `kept ${chars} chars`)
  assert.equal(state.entries.at(-1)?.id, "recall-5") // newest kept
  assert.ok(!state.entries.some((e) => e.id === "recall-1")) // oldest evicted
  assert.ok(store.has(recallKey("ses_2")))
})

test("recallNote: names the id and the dropped-region sample", () => {
  assert.equal(
    recallNote("recall-7", "ERROR: boom"),
    '[parsnip: full text dropped — recall parsnip_recall("recall-7") — dropped region starts: "ERROR: boom"]',
  )
})

test("appendResultText: appends to the last text part, leaving output/metadata alone", () => {
  const output = { exit: 0 }
  const withString = appendResultText({ content: "hi", output }, "\nNOTE")
  assert.equal(withString.content, "hi\nNOTE")
  assert.equal((withString as { output: unknown }).output, output)

  const parts = [
    { type: "text", text: "a" },
    { type: "file", uri: "u", mime: "m" },
    { type: "text", text: "b" },
  ]
  const appended = appendResultText({ content: parts }, "\nNOTE")
  const out = appended.content as Array<Record<string, unknown>>
  assert.equal(out[0].text, "a", "not the last text part")
  assert.equal(out[1].type, "file", "file parts untouched")
  assert.equal(out[2].text, "b\nNOTE", "the last text part gets the suffix")
})

test("pruneSession: removes only the given session's keys", async () => {
  const store = new Map<string, unknown>()
  store.set("session:ses_a:recall", { seq: 1 })
  store.set("session:ses_a:savings", { compressions: 1 })
  store.set("session:ses_b:recall", { seq: 2 })
  store.set("global:thing", 1)
  const storage = {
    scan: async ({ prefix }: { prefix: string }) => ({
      entries: [...store.entries()]
        .filter(([key]) => key.startsWith(prefix))
        .map(([key, value]) => ({ key, value })),
    }),
    remove: async (key: string) => void store.delete(key),
  } as unknown as StorageDomain

  const removed = await pruneSession(storage, "ses_a")
  assert.equal(removed, 2)
  assert.equal(store.has("session:ses_a:recall"), false)
  assert.equal(store.has("session:ses_a:savings"), false)
  assert.equal(store.has("session:ses_b:recall"), true, "another session untouched")
  assert.equal(store.has("global:thing"), true, "non-session keys untouched")
})
