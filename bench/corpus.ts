/**
 * Curated corpus for the cross-selector bench (`npm run compare`).
 *
 * One item per differentiating axis, so every selector has a sample where it
 * should clearly win — the comparison then reads causally ("why did X win")
 * instead of as a number dump:
 *
 *   token-boundary     head-tail splits tokens at its raw char cut; token-budget
 *                      snaps to a whitespace/delimiter boundary instead
 *   boundary-fallback  no boundaries at all: every selector degrades to a raw
 *                      char cut (the no-differentiation control case)
 *   ansi + repetitive  log-compact strips ANSI and collapses the run to "×N";
 *                      the other selectors keep every byte
 *   near-dup + novel   lines differ only in digits: exact-run collapse cannot
 *                      fire, and digit-masked shapes collide
 *   signal             diagnostics buried in the omitted middle: only
 *                      signal-preserving / extractive rescue them
 *   novelty            a high-ratio repetitive block with one unique line
 *                      inside the middle
 *
 * Everything is generated inline (deterministic, no fixtures) and is well above
 * the selectors' 4000-char gate, so every selector actually engages.
 */

export type CorpusItem = {
  name: string
  /** The axis this item exists to differentiate. */
  axis: string
  text: string
}

/** Deterministic multiplicative scramble: unique ids, no obvious fragments. */
const scramble = (i: number, mod: number): string => ((i * 2654435761) % mod).toString(36)

export const CORPUS: CorpusItem[] = [
  {
    name: "minified JSON (one line)",
    axis: "token-boundary",
    text: JSON.stringify({
      records: Array.from({ length: 3000 }, (_, i) => ({
        id: i,
        token: `tok_${scramble(i, 1_000_000)}`,
        payload: "x".repeat(20),
        checksum: scramble(i, 0xffffffff).padStart(8, "0"),
      })),
    }),
  },
  {
    name: "unified diff (many hunks)",
    axis: "token-boundary",
    text: Array.from(
      { length: 300 },
      (_, i) =>
        `diff --git a/module_${i}.ts b/module_${i}.ts\n` +
        `@@ -${i},3 +${i},3 @@\n` +
        `- old_${i}_value with some trailing words\n` +
        `+ new_${i}_value that is longer than the old one\n` +
        ` context line ${i} is unchanged\n`,
    ).join(""),
  },
  {
    name: "long-token rows (base64-ish)",
    axis: "token-boundary",
    text: Array.from(
      { length: 60 },
      (_, i) =>
        `row_${i}_${"a".repeat(160)} ${"b".repeat(160)}_mid_${i} ${"c".repeat(160)}_end_${i}`,
    ).join("\n"),
  },
  {
    name: "giant one-liner (no boundaries)",
    axis: "boundary-fallback",
    text: "x".repeat(100_000),
  },
  {
    name: "ANSI-colorized repeated error",
    axis: "ansi + repetitive",
    text: "\x1b[31mERROR handler timed out after 5000ms\x1b[0m\n".repeat(300),
  },
  {
    name: "timestamped log (near-duplicate lines)",
    axis: "near-dup + novel-value",
    text: (() => {
      const lines = Array.from(
        { length: 2000 },
        (_, i) =>
          `2026-09-30T00:${String(i % 60).padStart(2, "0")}:00Z INFO task ${i * 7} completed in ${i * 13}ms`,
      )
      lines[499] = "UNIQUE-METRIC throughput=12345 ops/s window=60s"
      lines[999] = "UNIQUE-RATIO cache-hits=98765 cache-misses=12"
      lines[1499] = "UNIQUE-TRACE span-id=0123456789abcdef duration=42ms"
      return lines.join("\n")
    })(),
  },
  {
    name: "buried diagnostics in chatter",
    axis: "signal",
    text: (() => {
      const lines = [
        ...Array.from({ length: 80 }, (_, i) => `startup step ${i} ${"h".repeat(28)}`),
        ...Array.from({ length: 2000 }, (_, i) => `chatter line ${i} ${"c".repeat(28)}`),
        ...Array.from({ length: 80 }, (_, i) => `shutdown note ${i} ${"t".repeat(28)}`),
      ]
      lines[300] = "ERROR: connection refused at src/db.ts:42:7"
      lines[800] = "FATAL: migration failed at src/migrate.ts:118:3"
      lines[1300] = "ERROR: timeout after 5000ms contacting http://localhost:8080/health"
      lines[1800] = "Traceback (most recent call last):"
      lines[2000] = "panic: nil pointer dereference in worker-3"
      return lines.join("\n")
    })(),
  },
  {
    name: "repeated block + buried novel line",
    axis: "novelty",
    text: (() => {
      const lines = [
        ...Array.from({ length: 300 }, () => "WARN cache miss for key shard"),
        "UNIQUE-MIDDLE-VALUE config v9 override active",
        ...Array.from({ length: 150 }, (_, i) => `tail chatter ${i} ${"z".repeat(28)}`),
      ]
      return lines.join("\n")
    })(),
  },
  {
    // The shape a `web_fetch` of a docs page or blog post arrives in. Every
    // line is unique, so there is no run for log-compact to collapse and no
    // repeated shape to lean on — the axis is "prose has no redundancy".
    //
    // NOTE on reading this row: `novel-x` is SATURATED here and cannot
    // discriminate between selectors. On prose every line is novel by
    // definition, so novel-x retention is capped at the kept fraction for all
    // of them. Judge this item on ratio, identifier retention and `frag`;
    // planted-fact recovery lives in the eval corpus instead.
    name: "long-form article (prose)",
    axis: "prose",
    text: Array.from(
      { length: 46 },
      (_, i) =>
        `Section ${i + 1}. The retrieval pipeline normalises each document before it is scored. ` +
        `Passage ${i} expands on how ${["ordering", "caching", "idempotence", "recovery", "observability", "eviction"][i % 6]} ` +
        `behaves once the underlying store starts to degrade, and sets out the trade-off the maintainers settled on.`,
    ).join("\n\n"),
  },
]

/**
 * Mid-sized items — the band a lowered threshold actually reaches.
 *
 * Sizes in the names are the generated lengths, not targets.
 *
 * `CORPUS` above is deliberately all above the 4000-char gate "so every selector
 * actually engages", which makes it structurally unable to answer a question
 * about the threshold: every item compresses at every setting. These items sit
 * between ~900 and ~3800 chars, so a sweep can watch selectors *engage* as the
 * threshold descends past them, which is the whole question.
 *
 * Shapes are drawn from what actually fills that band in real use: directory
 * listings, grep hits, short diffs, compact JSON, a short build/test log, a
 * narrow slice of a large file. Each carries real identifiers so the retention
 * proxies have something to score.
 */
export const SMALL_CORPUS: CorpusItem[] = [
  {
    name: "directory listing (2265)",
    axis: "threshold-band",
    text: Array.from(
      { length: 22 },
      (_, i) =>
        `-rw-r--r-- 1 oca oca ${String(1200 + i * 137).padStart(6)} Oct  1 21:${String(10 + i).padStart(2, "0")} ` +
        `notes_directory/bonsai/record_conjecture_memory_2026-09-3${i % 10}.md`,
    ).join("\n"),
  },
  {
    name: "grep hits (1495)",
    axis: "threshold-band",
    text: Array.from(
      { length: 26 },
      (_, i) =>
        `server/lib/${["selectors", "toolhooks", "config", "storage", "quality"][i % 5]}.ts:${40 + i * 7}:  ` +
        `// ctx-guard ${["selector", "dedup", "threshold", "savings", "occupancy"][i % 5]} path ${i}`,
    ).join("\n"),
  },
  {
    name: "short diff (775)",
    axis: "threshold-band",
    text: [
      "diff --git a/server/lib/config.ts b/server/lib/config.ts",
      "index 8f3a21c..b7e9044 100644",
      "--- a/server/lib/config.ts",
      "+++ b/server/lib/config.ts",
      "@@ -12,7 +12,9 @@ export type CtxGuardConfig = {",
      "   compression: boolean",
      "   dedup: boolean",
      "   selector: SelectorName",
      "+  minChars?: number",
      " }",
      "@@ -41,3 +43,8 @@ export function asConfigOverride(value: unknown)",
      "+  const minChars = asMinChars(v.minChars)",
      "+  if (minChars !== undefined) out.minChars = minChars",
      "   return out",
      " }",
      "@@ -70,6 +77,7 @@ export function resolveConfig(",
      "     dedup: sessionOverride.dedup ?? globalOverride.dedup ?? defaults.dedup,",
      "     selector: sessionOverride.selector ?? globalOverride.selector ?? defaults.selector,",
      "+    minChars: sessionOverride.minChars ?? globalOverride.minChars ?? defaults.minChars,",
      "   }",
      " }",
    ].join("\n"),
  },
  {
    name: "compact JSON (3435)",
    axis: "threshold-band",
    text: JSON.stringify(
      {
        events: Array.from({ length: 26 }, (_, i) => ({
          seq: i + 1,
          type: ["add", "supersede", "flag", "retract"][i % 4],
          slot: `repo/ctx-guard/dependency/${["vitest", "eslint", "tsx", "zod"][i % 4]}`,
          value: `${(i * 37) % 100}`.padStart(3, "0"),
          status: i % 3 === 0 ? "conjecture" : "record",
        })),
      },
      null,
      1,
    ),
  },
  {
    name: "build/test log (2871)",
    axis: "threshold-band",
    text: Array.from(
      { length: 48 },
      (_, i) =>
        i === 18
          ? "FAIL server/lib/selectors.test.ts > threshold override > 3 subtests failed"
          : `ok ${i + 1} - selector ${["head-tail", "token-budget", "log-compact"][i % 3]} budget ok ${"y".repeat(20)}`,
    ).join("\n"),
  },
  {
    name: "file slice (3601)",
    axis: "threshold-band",
    text: Array.from(
      { length: 40 },
      (_, i) =>
        `line ${String(i + 1).padStart(3)} | const value${i} = compute${["Threshold", "Budget", "Reread"][i % 3]}` +
        `(input${i}, factor${i}) // keeps identifier_${i} intact`,
    ).join("\n"),
  },
]
