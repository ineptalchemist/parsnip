/**
 * Offline benchmark: measures the *ceiling* of the compression + dedup
 * mechanism by pushing a realistic shell-output corpus through the pure
 * functions.
 *
 * Run with `npm run bench`. Pure — imports only `server/lib/toolhooks.ts`
 * (whose SDK reference is a type-only import), so nothing is resolved at
 * runtime beyond Node's own type stripping.
 *
 * This answers "how much *could* compression/dedup save", not "how much does it
 * save in a real session" (that is the per-session savings ledger in the live
 * plugin). The two numbers are different because OpenCode's native
 * `tool_output.max_lines` (500 lines / 20000 bytes) truncates *multi-line*
 * output before the plugin ever sees it — so ctx-guard's compression only earns
 * its keep on results that are long but *few-lined* (diffs, minified JSON, long
 * single log lines).
 */

import {
  COMPRESSION_OPTIONS,
  DEDUP_MARKER,
  compressText,
  replaceResultText,
  textLengthOf,
} from "../server/lib/toolhooks.ts"

/** Token heuristic from `server/lib/quality.ts` — chars / 4 (uncalibrated). */
const tokensOf = (chars: number): number => Math.ceil(chars / 4)

type Item = {
  name: string
  text: string
  /** Multi-line output is pre-truncated by native max_lines, so compression
   * never sees it in a live session. */
  nativeTruncates: boolean
}

const CORPUS: Item[] = [
  {
    name: "minified JSON (one line)",
    text: JSON.stringify({
      records: Array.from({ length: 3000 }, (_, i) => ({ id: i, payload: "x".repeat(24) })),
    }),
    nativeTruncates: false,
  },
  {
    name: "unified diff (many hunks)",
    text: Array.from(
      { length: 300 },
      (_, i) => `@@ -${i},3 +${i},3 @@\n- old ${i}\n+ new ${i} with a longer description\n context ${i}\n`,
    ).join(""),
    nativeTruncates: false,
  },
  {
    name: "one long error line",
    text: `2026-09-30T00:00:00Z ERROR ${"x".repeat(12000)} traceback`,
    nativeTruncates: false,
  },
  {
    name: "multi-line log (native max_lines:500 pre-truncates)",
    text: Array.from({ length: 4000 }, (_, i) => `2026-09-30T00:${i % 60}:00Z INFO line ${i}\n`).join(""),
    nativeTruncates: true,
  },
  {
    name: "repeated identical block (dedup target)",
    text: "WARN handler timed out after 5000ms\n".repeat(300),
    nativeTruncates: false,
  },
]

const O = COMPRESSION_OPTIONS

function main(): void {
  console.log("ctx-guard offline benchmark")
  console.log(
    `compression: min ${O.minChars} chars, keep head ${O.headChars} + tail ${O.tailChars}`,
  )
  console.log(`token heuristic: chars / 4\n`)

  let totalOriginal = 0
  let totalCompressed = 0

  for (const item of CORPUS) {
    const original = item.text.length
    const compressed = compressText(item.text, O)
    const compressedLen = compressed.length
    const omitted = original - compressedLen
    const changed = compressed !== item.text
    totalOriginal += original
    totalCompressed += changed ? compressedLen : original

    const pct = ((omitted / original) * 100).toFixed(1)
    const flag = changed ? "compressed" : "unchanged"
    console.log(`- ${item.name}`)
    console.log(
      `    ${original} -> ${compressedLen} chars  (−${omitted}, ${pct}%)  ~${tokensOf(omitted)} tokens  [${flag}]`,
    )
    if (item.nativeTruncates) {
      console.log(`    NOTE: multi-line — native max_lines truncates first, so the hook never sees this`)
    }
  }

  const totalOmitted = totalOriginal - totalCompressed
  console.log(`\nif every item were a single oversized result:`)
  console.log(
    `    ${totalOriginal} -> ${totalCompressed} chars  (−${totalOmitted}, ${((totalOmitted / totalOriginal) * 100).toFixed(1)}%)  ~${tokensOf(totalOmitted)} tokens`,
  )

  // Dedup: the same large result arriving a second time collapses to a marker.
  const repeated = CORPUS[CORPUS.length - 1]
  const dedupResult = replaceResultText({ content: [{ type: "text", text: repeated.text }] }, DEDUP_MARKER)
  const dedupLen = textLengthOf(dedupResult)
  const dedupSaved = repeated.text.length - dedupLen
  console.log(`\ndedup: a repeated ${repeated.text.length}-char result collapses to ${dedupLen} chars`)
  console.log(`    (−${dedupSaved} chars, ~${tokensOf(dedupSaved)} tokens saved per repeat)`)
}

main()
