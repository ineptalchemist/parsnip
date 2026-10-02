/**
 * Eval corpus: realistic tool outputs with **planted, unique** facts at
 * controlled positions, for the known-answer harness (`bench/eval.ts`).
 *
 * Each item is generated inline (deterministic, no fixtures) and sized into the
 * *live-valid window*: over the selectors' 4000-char gate so compression runs,
 * but under OpenCode's native `tool_output` caps (500 lines / 20000 bytes) so
 * native truncation does not pre-empt it — i.e. these are the few-line-but-long
 * outputs where parsnip actually earns its keep.
 *
 * Fact bands (`head` / `middle` / `tail`) are declared against the head-tail
 * baseline cut and validated by `recovery.test.ts` against `bandOf`.
 */

import type { CorpusItem } from "./lib/recovery.ts"

const range = (n: number, f: (i: number) => string): string[] =>
  Array.from({ length: n }, (_, i) => f(i))

const join = (...blocks: string[][]): string => blocks.flat().join("\n")

// --- 1. build log with a buried failure -------------------------------------

const BUILD_HASH = "3f9a1c7e5b2d8f0a4c6e1b3d7a9f2c4e6b8d0a2c"
const BUILD_URL = "https://ci.example.com/build/8842/artifacts"

function buildLog(): CorpusItem {
  const head = [
    "== ci build 8842 ==",
    "toolchain: gcc 13.2.1 node v20.11.0 app v2.14.3",
    `commit ${BUILD_HASH}`,
    ...range(27, (i) => `[head] preparing step ${i} ${"h".repeat(24)}`),
  ]
  const middle = range(100, (i) => `[mid] compiling unit ${i} ${"c".repeat(24)}`)
  middle[20] = "FAIL: integration suite exceeded 5000ms budget"
  middle[40] = "ERROR: tests failed at src/core_test.ts:142:7"
  middle[60] = "WARN: retrying after transient failure at src/parser.rs:27:11"
  middle[80] = "assertion mismatch: expected 4096 got 3998"
  const tail = [
    ...range(29, (i) => `[tail] artifact ${i} written ${"t".repeat(24)}`),
    `done: 3 checks, see ${BUILD_URL}`,
  ]
  return {
    name: "build log (buried failure)",
    task: "Which test failed, and at what file and line?",
    text: join(head, middle, tail),
    facts: [
      { text: "v2.14.3", label: "value", band: "head" },
      { text: BUILD_HASH, label: "hash", band: "head" },
      { text: "FAIL: integration suite exceeded 5000ms budget", label: "error", band: "middle" },
      { text: "ERROR: tests failed at src/core_test.ts:142:7", label: "error", band: "middle" },
      { text: "src/parser.rs:27:11", label: "file:line", band: "middle" },
      { text: "assertion mismatch: expected 4096 got 3998", label: "value", band: "middle" },
      { text: "compiling unit 55", label: "value", band: "middle" },
      { text: BUILD_URL, label: "url", band: "tail" },
    ],
  }
}

// --- 2. python stack trace --------------------------------------------------

function stackTrace(): CorpusItem {
  const head = [
    "Traceback (most recent call last):",
    '  File "src/main.py", line 12, in <module>',
    ...range(22, (i) => `  File "src/app/handler_${i}.py", line ${10 + i}, in handle`),
  ]
  const middle = range(100, (i) => `  File "src/pool/worker_${i}.py", line ${20 + i}, in run`)
  middle[30] = '  File "src/pool/worker.py", line 88, in process'
  middle[50] = "ValueError: division by zero in pool_size=64"
  middle[70] = '  File "src/queue/dispatch.py", line 401, in <module>'
  const tail = [
    ...range(22, (i) => `  File "src/exit/via_${i}.py", line ${5 + i}, in <module>`),
    "Process exited with code 137",
  ]
  return {
    name: "python stack trace",
    task: "What error was raised, and where in the code?",
    text: join(head, middle, tail),
    facts: [
      { text: '"src/main.py", line 12', label: "file:line", band: "head" },
      { text: '"src/pool/worker.py", line 88', label: "file:line", band: "middle" },
      { text: "ValueError: division by zero", label: "error", band: "middle" },
      { text: "pool_size=64", label: "value", band: "middle" },
      { text: 'worker_42.py", line 62', label: "value", band: "middle" },
      { text: "Process exited with code 137", label: "value", band: "tail" },
    ],
  }
}

// --- 3. git diff ------------------------------------------------------------

const DIFF_HASH_A = "1a2b3c4d5e6f708192a3b4c5d6e7f8091a2b3c4d"
const DIFF_HASH_B = "9f8e7d6c5b4a39281706f5e4d3c2b1a0aabbccdd"

function gitDiff(): CorpusItem {
  const head = [
    "diff --git a/src/parser.py b/src/parser.py",
    `index ${DIFF_HASH_A}..${DIFF_HASH_B} 100644`,
    "--- a/src/parser.py",
    "+++ b/src/parser.py",
    "@@ -12,7 +12,9 @@ def parse(self):",
    ...range(24, (i) => ` context line ${i} unchanged ${"x".repeat(20)}`),
  ]
  const middle = range(100, (i) => `@@ -${200 + i},3 +${200 + i},3 @@ def step_${i}`)
  middle[30] = "-def parse_queries_impl(req):"
  middle[31] = "+def parse_queries_impl(req, limit=10):"
  middle[60] = "+    timeout_seconds=4096"
  const tail = [
    ...range(24, (i) => ` context tail ${i} unchanged ${"y".repeat(20)}`),
    '+    checksum = "9f8e7d6c5b4a"',
  ]
  return {
    name: "git diff (rename hunks)",
    task: "What code changed — which symbols were renamed and what values were added?",
    text: join(head, middle, tail),
    facts: [
      { text: DIFF_HASH_A, label: "hash", band: "head" },
      { text: "-def parse_queries_impl(req):", label: "identifier", band: "middle" },
      { text: "+def parse_queries_impl(req, limit=10):", label: "identifier", band: "middle" },
      { text: "timeout_seconds=4096", label: "value", band: "middle" },
      { text: "@@ -242,3 +242,3 @@", label: "value", band: "middle" },
      { text: 'checksum = "9f8e7d6c5b4a"', label: "value", band: "tail" },
    ],
  }
}

// --- 4. minified JSON / API response (one line) -----------------------------

const API_HEX = "9f8e7d6c5b4a39281706f5e4d3c2b1a09f8e7d6c5b4a39281706f5e4d3c2b1a0"
const API_URL = "https://api.example.com/v2/schema"

function apiResponse(): CorpusItem {
  const records = range(
    150,
    (i) => `{"id":${i},"name":"item_${i}","value":${i * 31}}`,
  ).join(",")
  const prefix = `{"request":"req_7f3a2b9c","generated":"2026-09-30T12:00:00Z","filler":"${"x".repeat(3000)}",`
  const mid = `"checksum":"${API_HEX}",`
  const body = `"records":[${records}],`
  const suffix = `"docs":"${API_URL}"}`
  return {
    name: "minified JSON (one line)",
    task: "What is the request id, the checksum, and the docs URL?",
    text: prefix + mid + body + suffix,
    facts: [
      { text: "req_7f3a2b9c", label: "value", band: "head" },
      { text: API_HEX, label: "hash", band: "middle" },
      { text: API_URL, label: "url", band: "tail" },
    ],
  }
}

// --- 5. dependency list -----------------------------------------------------

function dependencyList(): CorpusItem {
  const head = [
    "package resolutions (200):",
    ...range(40, (i) => `  dep_head_${i}@${i}.0.${i}`),
    "  requests@2.31.0",
    ...range(10, (i) => `  dep_more_${i}@${i}.1.0`),
  ]
  const middle = range(120, (i) => `  package_${i}@${i}.2.${i}`)
  middle[30] = "  parse_queries@1.4.2"
  middle[60] = "  sqlalchemy@2.0.30"
  const tail = [
    ...range(40, (i) => `  dep_tail_${i}@${i}.3.0`),
    "  urllib3@2.2.1",
  ]
  return {
    name: "dependency list",
    task: "Which versions are pinned for requests, parse_queries, sqlalchemy, and urllib3?",
    text: join(head, middle, tail),
    facts: [
      { text: "requests@2.31.0", label: "value", band: "head" },
      { text: "parse_queries@1.4.2", label: "identifier", band: "middle" },
      { text: "sqlalchemy@2.0.30", label: "value", band: "middle" },
      { text: "package_42@42.2.42", label: "value", band: "middle" },
      { text: "package_99@99.2.99", label: "value", band: "middle" },
      { text: "urllib3@2.2.1", label: "value", band: "tail" },
    ],
  }
}

// --- 6. timestamped log -----------------------------------------------------

function timestampedLog(): CorpusItem {
  const head = [
    "2026-09-30T00:00:00Z INFO boot worker_id=4412",
    ...range(40, (_, i) => `2026-09-30T00:00:${String(i % 60).padStart(2, "0")}Z INFO heartbeat ${i}`),
  ]
  const middle = range(
    120,
    (i) => `2026-09-30T00:01:${String(i % 60).padStart(2, "0")}Z INFO task ${i} done`,
  )
  middle[40] = "2026-09-30T00:02:12Z ERROR: timeout after 5000ms calling upstream"
  middle[70] = "2026-09-30T00:02:44Z INFO processed REQ-ID=8f3a2b9c in 42ms"
  const tail = [
    ...range(40, (_, i) => `2026-09-30T00:03:${String(i % 60).padStart(2, "0")}Z INFO shutdown ${i}`),
    "2026-09-30T00:03:59Z INFO see https://status.example.com/incidents/2026-09-30",
  ]
  return {
    name: "timestamped log (near-duplicate lines)",
    task: "What error occurred, and which request id was processed?",
    text: join(head, middle, tail),
    facts: [
      { text: "worker_id=4412", label: "value", band: "head" },
      { text: "ERROR: timeout after 5000ms calling upstream", label: "error", band: "middle" },
      { text: "REQ-ID=8f3a2b9c", label: "value", band: "middle" },
      { text: "task 77 done", label: "value", band: "middle" },
      { text: "task 21 done", label: "value", band: "middle" },
      {
        text: "https://status.example.com/incidents/2026-09-30",
        label: "url",
        band: "tail",
      },
    ],
  }
}

export const FACT_CORPUS: readonly CorpusItem[] = [
  buildLog(),
  stackTrace(),
  gitDiff(),
  apiResponse(),
  dependencyList(),
  timestampedLog(),
]
