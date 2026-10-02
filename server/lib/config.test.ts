import { test } from "node:test"
import assert from "node:assert/strict"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import {
  DEFAULT_CONFIG,
  MAX_CHARS_LIMIT,
  MIN_CHARS_LIMIT,
  GLOBAL_CONFIG_KEY,
  applyConfigPatch,
  asConfigOverride,
  asMinChars,
  clearGlobalConfig,
  describeConfig,
  effectiveConfig,
  loadGlobalConfig,
  loadSessionConfig,
  resolveConfig,
  saveGlobalConfig,
  saveSessionConfig,
  sessionConfigKey,
} from "./config.ts"

function makeStorage() {
  const store = new Map<string, unknown>()
  const storage = {
    get: async (key: string) => store.get(key),
    set: async (key: string, value: unknown) => void store.set(key, value),
    remove: async (key: string) => void store.delete(key),
    scan: async () => ({ entries: [] }),
  } as unknown as StorageDomain
  return { store, storage }
}

test("DEFAULT_CONFIG: compression off, dedup on, selector head-tail", () => {
  assert.deepEqual(DEFAULT_CONFIG, { compression: false, dedup: true, selector: "head-tail" })
})

test("sessionConfigKey: namespaces by session", () => {
  assert.equal(sessionConfigKey("ses_1"), "session:ses_1:ctx-guard")
  assert.equal(GLOBAL_CONFIG_KEY, "ctx-guard:config")
})

test("resolveConfig: session override beats global beats default", () => {
  assert.deepEqual(resolveConfig(), {
    compression: false,
    dedup: true,
    selector: "head-tail",
    minChars: undefined,
  })
  assert.deepEqual(resolveConfig({ compression: true }), {
    compression: true,
    dedup: true,
    selector: "head-tail",
    minChars: undefined,
  })
  assert.deepEqual(
    resolveConfig({ compression: true, dedup: false }, { compression: false }),
    { compression: false, dedup: false, selector: "head-tail", minChars: undefined },
  )
})

test("resolveConfig: fields resolve independently", () => {
  // Session only sets dedup; compression falls through to the global override.
  assert.deepEqual(resolveConfig({ compression: true }, { dedup: false }), {
    compression: true,
    dedup: false,
    selector: "head-tail",
    minChars: undefined,
  })
})

test("resolveConfig: selector resolves session > global > default", () => {
  assert.equal(resolveConfig({ selector: "head-tail" }).selector, "head-tail")
  assert.equal(
    resolveConfig({ selector: "head-tail" }, { selector: "head-tail" }).selector,
    "head-tail",
  )
  // A defaults override wins only when neither level sets the field.
  assert.equal(resolveConfig({}, {}, { compression: false, dedup: true, selector: "head-tail" }).selector, "head-tail")
})

test("asConfigOverride: narrows to booleans/selector names, drops junk", () => {
  assert.deepEqual(asConfigOverride(undefined), {})
  assert.deepEqual(asConfigOverride(null), {})
  assert.deepEqual(asConfigOverride([1, 2]), {})
  assert.deepEqual(asConfigOverride({ compression: "yes", dedup: true }), { dedup: true })
  assert.deepEqual(asConfigOverride({ compression: false, extra: 1 }), { compression: false })
  assert.deepEqual(asConfigOverride({ selector: "head-tail" }), { selector: "head-tail" })
  assert.deepEqual(asConfigOverride({ selector: "nope" }), {})
  assert.deepEqual(asConfigOverride({ selector: 3 }), {})
})

test("describeConfig: on/off summary plus the selector", () => {
  assert.equal(
    describeConfig({ compression: false, dedup: true, selector: "head-tail" }),
    "compression off, dedup on, selector head-tail, threshold default",
  )
  assert.equal(
    describeConfig({ compression: true, dedup: true, selector: "extractive", minChars: 1500 }),
    "compression on, dedup on, selector extractive, threshold 1500 chars",
  )
})

test("storage: global + session overrides round-trip independently", async () => {
  const { storage } = makeStorage()
  assert.deepEqual(await loadGlobalConfig(storage), {})
  assert.deepEqual(await loadSessionConfig(storage, "ses_1"), {})

  await saveGlobalConfig(storage, { compression: true })
  await saveSessionConfig(storage, "ses_1", { dedup: false })
  assert.deepEqual(await loadGlobalConfig(storage), { compression: true })
  assert.deepEqual(await loadSessionConfig(storage, "ses_1"), { dedup: false })
  assert.deepEqual(await loadSessionConfig(storage, "ses_2"), {})
})

test("effectiveConfig: merges both levels", async () => {
  const { storage } = makeStorage()
  await saveGlobalConfig(storage, { compression: true })
  await saveSessionConfig(storage, "ses_1", { compression: false })

  assert.deepEqual(await effectiveConfig(storage, "ses_1"), {
    compression: false,
    dedup: true,
    selector: "head-tail",
    minChars: undefined,
  })
  assert.deepEqual(await effectiveConfig(storage, "ses_2"), {
    compression: true,
    dedup: true,
    selector: "head-tail",
    minChars: undefined,
  })
})

test("applyConfigPatch: merges at the chosen scope; reset clears it", async () => {
  const { storage } = makeStorage()

  await applyConfigPatch(storage, "ses_1", { compression: true }, { scope: "global" })
  await applyConfigPatch(storage, "ses_1", { dedup: false }, { scope: "global" })
  assert.deepEqual(await loadGlobalConfig(storage), { compression: true, dedup: false })

  await applyConfigPatch(storage, "ses_1", { dedup: true }, { scope: "session" })
  assert.deepEqual(await loadSessionConfig(storage, "ses_1"), { dedup: true })
  // A session patch leaves the global override untouched.
  assert.deepEqual(await loadGlobalConfig(storage), { compression: true, dedup: false })

  await applyConfigPatch(storage, "ses_1", {}, { scope: "session", reset: true })
  assert.deepEqual(await loadSessionConfig(storage, "ses_1"), {})
  await applyConfigPatch(storage, "ses_1", {}, { scope: "global", reset: true })
  assert.deepEqual(await loadGlobalConfig(storage), {})
})

test("clearGlobalConfig: removes the key", async () => {
  const { store, storage } = makeStorage()
  await saveGlobalConfig(storage, { dedup: false })
  await clearGlobalConfig(storage)
  assert.equal(store.has(GLOBAL_CONFIG_KEY), false)
})

// --- threshold (minChars) ----------------------------------------------------
//
// The threshold is the one config field whose value changes COMPRESSION
// BEHAVIOUR rather than just enabling it: it overrides both the gate and the
// derived head/tail budget, so the effective floor moves with it.

test("asMinChars: accepts an in-range integer", () => {
  assert.equal(asMinChars(1500), 1500)
  assert.equal(asMinChars(MIN_CHARS_LIMIT), MIN_CHARS_LIMIT)
  assert.equal(asMinChars(MAX_CHARS_LIMIT), MAX_CHARS_LIMIT)
})

test("asMinChars: floors a fractional threshold", () => {
  assert.equal(asMinChars(1500.7), 1500)
  assert.equal(asMinChars(2000.2), 2000)
})

test("asMinChars: rejects rather than clamps a mangled value", () => {
  // A stored 1500 truncated to 150 must fall back to the selector default, not
  // silently become a far more aggressive setting.
  for (const bad of [
    0,
    -1,
    150,
    MIN_CHARS_LIMIT - 1,
    MAX_CHARS_LIMIT + 1,
    Number.NaN,
    Number.POSITIVE_INFINITY,
    Number.NEGATIVE_INFINITY,
    "1500",
    null,
    undefined,
    {},
    [],
  ]) {
    assert.equal(asMinChars(bad), undefined, `${String(bad)} was not rejected`)
  }
})

test("asConfigOverride: keeps a valid minChars and drops an invalid one", () => {
  assert.deepEqual(asConfigOverride({ minChars: 1500 }), { minChars: 1500 })
  assert.deepEqual(asConfigOverride({ minChars: 150 }), {})
  assert.deepEqual(asConfigOverride({ minChars: "1500" }), {})
  assert.deepEqual(asConfigOverride({}), {})
})

test("resolveConfig: minChars resolves session > global > default", () => {
  assert.equal(resolveConfig({ minChars: 2000 }).minChars, 2000)
  assert.equal(resolveConfig({ minChars: 2000 }, { minChars: 1200 }).minChars, 1200)
  assert.equal(resolveConfig({}, { minChars: 1200 }).minChars, 1200)
  assert.equal(resolveConfig().minChars, undefined, "unset must stay unset, not 0")
})

test("resolveConfig: an explicit 0 in a session override still wins", () => {
  // Precedence is by presence, not truthiness — but asMinChars would have
  // rejected 0 on the way in, so this can only arrive via a hand-written record.
  assert.equal(resolveConfig({ minChars: 2000 }, { minChars: 0 }).minChars, 0)
})

test("storage: minChars round-trips and survives alongside the other fields", async () => {
  const { storage } = makeStorage()
  await saveGlobalConfig(storage, { compression: true, minChars: 1500 })
  const loaded = await loadGlobalConfig(storage)
  assert.equal(loaded.minChars, 1500)
  assert.equal(loaded.compression, true)

  // A second patch must not drop the threshold.
  await applyConfigPatch(storage, "ses_1", { selector: "extractive" }, { scope: "global" })
  const after = await loadGlobalConfig(storage)
  assert.equal(after.minChars, 1500)
  assert.equal(after.selector, "extractive")
})

test("storage: a stored out-of-range minChars is discarded on read", async () => {
  const { storage } = makeStorage()
  await storage.set(GLOBAL_CONFIG_KEY, { minChars: 42 })
  assert.deepEqual(await loadGlobalConfig(storage), {})
  assert.equal(resolveConfig(await loadGlobalConfig(storage)).minChars, undefined)
})
