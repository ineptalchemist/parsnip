import { test } from "node:test"
import assert from "node:assert/strict"
import {
  asCompactionProbe,
  formatCompactionProbe,
  makeSentinel,
  recordCompactionProbe,
  recordCompactionVerdict,
  compactionProbeKey,
} from "./compaction-probe.ts"

test("recordCompactionProbe: folds a firing, carrying the measured system-part delta", () => {
  const first = recordCompactionProbe(undefined, {
    injected: true,
    blockChars: 120,
    systemPartsBefore: 4,
    systemPartsAfter: 5,
    resultWasSet: false,
    agent: "build",
  }, 1)

  assert.equal(first.fires, 1)
  assert.equal(first.injected, true)
  assert.equal(first.blockChars, 120)
  assert.equal(first.systemPartsBefore, 4)
  assert.equal(first.systemPartsAfter, 5)
  assert.equal(first.resultWasSet, false)
  assert.equal(first.agent, "build")
  assert.equal(first.updatedAt, 1)

  const second = recordCompactionProbe(first, {
    injected: false,
    blockChars: 0,
    systemPartsBefore: 5,
    systemPartsAfter: 5,
    resultWasSet: false,
  }, 2)

  assert.equal(second.fires, 2)
  assert.equal(second.injected, false)
  assert.equal(second.systemPartsBefore, 5)
  assert.equal(second.systemPartsAfter, 5)
})

test("asCompactionProbe: narrows stored JSON and tolerates junk", () => {
  const narrowed = asCompactionProbe({
    fires: 3,
    injected: true,
    blockChars: 200,
    systemPartsBefore: 4,
    systemPartsAfter: 5,
    resultWasSet: false,
    agent: "build",
    updatedAt: 7,
  })
  assert.equal(narrowed?.fires, 3)
  assert.equal(narrowed?.injected, true)
  assert.equal(narrowed?.systemPartsBefore, 4)
  assert.equal(narrowed?.updatedAt, 7)

  assert.equal(asCompactionProbe(undefined), undefined)
  assert.equal(asCompactionProbe(null), undefined)
  assert.equal(asCompactionProbe([]), undefined)
  const zeroed = asCompactionProbe({})
  assert.ok(zeroed, "an empty object narrows to a zero record, not undefined")
  assert.equal(zeroed?.fires, 0)
  assert.equal(zeroed?.injected, false)
  const junk = asCompactionProbe({ fires: "x", injected: 1 })
  assert.equal(junk?.fires, 0)
  assert.equal(junk?.injected, false)
})

test("formatCompactionProbe: empty when unset or never fired", () => {
  assert.equal(formatCompactionProbe(undefined), "")
  assert.equal(
    formatCompactionProbe({ fires: 0, injected: false, blockChars: 0, systemPartsBefore: 0, systemPartsAfter: 0, resultWasSet: false, updatedAt: 0 }),
    "",
  )
})

test("formatCompactionProbe: reports the firing and its observed outcome", () => {
  const probe = recordCompactionProbe(undefined, {
    injected: true,
    blockChars: 320,
    systemPartsBefore: 4,
    systemPartsAfter: 5,
    resultWasSet: false,
    agent: "build",
  })
  const text = formatCompactionProbe(probe)
  assert.match(text, /Compaction probe/)
  assert.match(text, /fired 1 time\(s\) · agent build/)
  assert.match(text, /injected yes · block 320 chars · system 4 -> 5/)
  assert.match(text, /left to the main model/)
})

test("compactionProbeKey: is session-scoped and stable", () => {
  assert.equal(compactionProbeKey("ses_1"), "session:ses_1:compaction-probe")
  assert.notEqual(compactionProbeKey("ses_1"), compactionProbeKey("ses_2"))
})

test("makeSentinel: unique PCOMPACT- tokens with 8 hex chars", () => {
  const a = makeSentinel()
  const b = makeSentinel()
  assert.match(a, /^PCOMPACT-[0-9a-f]{8}$/)
  assert.notEqual(a, b, "each firing must get a fresh token")
})

test("recordCompactionProbe: stores the sentinel and resets the verdict to undefined", () => {
  const probe = recordCompactionProbe(undefined, {
    injected: true,
    blockChars: 300,
    systemPartsBefore: 4,
    systemPartsAfter: 5,
    resultWasSet: false,
    sentinel: "PCOMPACT-abc12345",
  })
  assert.equal(probe.sentinel, "PCOMPACT-abc12345")
  assert.equal(probe.sentinelFound, undefined, "verdict awaits the summary")
})

test("recordCompactionVerdict: records whether the sentinel survived", () => {
  const probe = recordCompactionProbe(undefined, {
    injected: true,
    blockChars: 300,
    systemPartsBefore: 4,
    systemPartsAfter: 5,
    resultWasSet: false,
    sentinel: "PCOMPACT-abc12345",
  })

  const found = recordCompactionVerdict(probe, "summary … PCOMPACT-abc12345 … done")
  assert.equal(found?.sentinelFound, true)

  const missing = recordCompactionVerdict(probe, "summary with no token")
  assert.equal(missing?.sentinelFound, false)
})

test("recordCompactionVerdict: a no-sentinel probe is left untouched", () => {
  const probe = recordCompactionProbe(undefined, {
    injected: false,
    blockChars: 0,
    systemPartsBefore: 4,
    systemPartsAfter: 4,
    resultWasSet: false,
  })
  const result = recordCompactionVerdict(probe, "any summary")
  assert.equal(result, probe, "no sentinel -> no verdict to record")
  assert.equal(result?.sentinelFound, undefined)
})

test("formatCompactionProbe: shows the sentinel and its verdict", () => {
  const probe = recordCompactionProbe(undefined, {
    injected: true,
    blockChars: 320,
    systemPartsBefore: 4,
    systemPartsAfter: 5,
    resultWasSet: false,
    sentinel: "PCOMPACT-abc12345",
  })

  const pending = formatCompactionProbe(probe)
  assert.match(pending, /sentinel PCOMPACT-abc12345 · awaiting summary/)

  const survived = formatCompactionProbe(recordCompactionVerdict(probe, "PCOMPACT-abc12345"))
  assert.match(survived, /sentinel PCOMPACT-abc12345 · survived/)

  const dropped = formatCompactionProbe(recordCompactionVerdict(probe, "nothing here"))
  assert.match(dropped, /sentinel PCOMPACT-abc12345 · NOT found/)
})
