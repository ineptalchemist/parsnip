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
]
