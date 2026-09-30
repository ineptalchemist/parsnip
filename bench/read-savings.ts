/**
 * Read the per-session savings ledgers out of OpenCode's plugin storage.
 *
 * The live plugin records compression/dedup savings into `ctx.storage`, which
 * OpenCode backs by the `kv` table in `opencode.db` (keyed
 * `plugin:<utf16-hex(id)>:session:<id>:savings`). Plugin `console.log`/`error`
 * does NOT reach `opencode.log`, so this read-only SQLite query is the
 * measurement surface.
 *
 * Usage:
 *   npm run savings                 # default DB (OpenCode's opencode.db)
 *   node bench/read-savings.ts /path/to/opencode.db
 */

import os from "node:os"
import path from "node:path"
import { DatabaseSync } from "node:sqlite"

const defaultDb = path.join(os.homedir(), ".local", "share", "opencode", "opencode.db")
const dbPath = process.argv[2] ?? defaultDb

type Ledger = {
  compressions: number
  charsOmitted: number
  dedups: number
  charsDeduped: number
}

const db = new DatabaseSync(dbPath, { readOnly: true })
const rows = db
  .prepare("SELECT key, value FROM kv WHERE key LIKE ? ORDER BY key")
  .all("%:savings") as Array<{ key: string; value: string }>
db.close()

const tokensOf = (chars: number): number => Math.ceil(chars / 4)

const sessions: Array<{ id: string; ledger: Ledger }> = []
for (const row of rows) {
  const match = row.key.match(/session:([^:]+):savings$/)
  if (!match) continue
  try {
    sessions.push({ id: match[1], ledger: JSON.parse(row.value) as Ledger })
  } catch {
    // Ignore malformed records.
  }
}

if (sessions.length === 0) {
  console.log("no savings ledgers found")
  process.exit(0)
}

let totalSaved = 0
for (const session of sessions) {
  const { compressions, charsOmitted, dedups, charsDeduped } = session.ledger
  const saved = charsOmitted + charsDeduped
  totalSaved += saved
  console.log(
    `${session.id}` +
      `\n  compress x${compressions} (-${charsOmitted} chars)` +
      `\n  dedup    x${dedups} (-${charsDeduped} chars)` +
      `\n  = -${saved} chars (~${tokensOf(saved)} tokens)`,
  )
}

console.log(
  `\ntotal: -${totalSaved} chars (~${tokensOf(totalSaved)} tokens) across ${sessions.length} session(s)`,
)
