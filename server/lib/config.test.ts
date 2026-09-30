import { test } from "node:test"
import assert from "node:assert/strict"
import type { StorageDomain } from "@opencode/plugin/promise/storage"
import {
  DEFAULT_CONFIG,
  GLOBAL_CONFIG_KEY,
  applyConfigPatch,
  asConfigOverride,
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

test("DEFAULT_CONFIG: compression off, dedup on", () => {
  assert.deepEqual(DEFAULT_CONFIG, { compression: false, dedup: true })
})

test("sessionConfigKey: namespaces by session", () => {
  assert.equal(sessionConfigKey("ses_1"), "session:ses_1:ctx-guard")
  assert.equal(GLOBAL_CONFIG_KEY, "ctx-guard:config")
})

test("resolveConfig: session override beats global beats default", () => {
  assert.deepEqual(resolveConfig(), { compression: false, dedup: true })
  assert.deepEqual(resolveConfig({ compression: true }), { compression: true, dedup: true })
  assert.deepEqual(
    resolveConfig({ compression: true, dedup: false }, { compression: false }),
    { compression: false, dedup: false },
  )
})

test("resolveConfig: fields resolve independently", () => {
  // Session only sets dedup; compression falls through to the global override.
  assert.deepEqual(resolveConfig({ compression: true }, { dedup: false }), {
    compression: true,
    dedup: false,
  })
})

test("asConfigOverride: narrows to booleans, drops junk", () => {
  assert.deepEqual(asConfigOverride(undefined), {})
  assert.deepEqual(asConfigOverride(null), {})
  assert.deepEqual(asConfigOverride([1, 2]), {})
  assert.deepEqual(asConfigOverride({ compression: "yes", dedup: true }), { dedup: true })
  assert.deepEqual(asConfigOverride({ compression: false, extra: 1 }), { compression: false })
})

test("describeConfig: on/off summary", () => {
  assert.equal(describeConfig({ compression: false, dedup: true }), "compression off, dedup on")
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

  assert.deepEqual(await effectiveConfig(storage, "ses_1"), { compression: false, dedup: true })
  assert.deepEqual(await effectiveConfig(storage, "ses_2"), { compression: true, dedup: true })
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
