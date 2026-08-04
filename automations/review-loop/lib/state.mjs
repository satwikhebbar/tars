import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

/** Persistent lane registry and idempotency journal. */
export class StateStore {
  constructor(path) {
    this.path = path
    this.database = null
  }

  async open() {
    await mkdir(dirname(this.path), { recursive: true })
    this.database = new DatabaseSync(this.path)
    this.database.exec(`
      PRAGMA journal_mode = WAL;
      CREATE TABLE IF NOT EXISTS lanes (
        worktree_path TEXT PRIMARY KEY,
        opencode_session_id TEXT NOT NULL,
        codex_session_id TEXT NOT NULL,
        state TEXT NOT NULL,
        max_rounds INTEGER NOT NULL,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatched_events (
        worktree_path TEXT NOT NULL,
        event_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (worktree_path, event_key)
      );
    `)
  }

  close() {
    this.database?.close()
    this.database = null
  }

  saveLane(lane) {
    this.database
      .prepare(`INSERT INTO lanes (worktree_path, opencode_session_id, codex_session_id, state, max_rounds, updated_at)
        VALUES (?, ?, ?, ?, ?, ?)
        ON CONFLICT(worktree_path) DO UPDATE SET
          opencode_session_id = excluded.opencode_session_id,
          codex_session_id = excluded.codex_session_id,
          state = excluded.state,
          max_rounds = excluded.max_rounds,
          updated_at = excluded.updated_at`)
      .run(
        lane.worktreePath,
        lane.opencodeSessionId,
        lane.codexSessionId,
        lane.state,
        lane.maxRounds,
        new Date().toISOString(),
      )
  }

  lane(worktreePath) {
    const row = this.database.prepare("SELECT * FROM lanes WHERE worktree_path = ?").get(worktreePath)
    return row ? toLane(row) : null
  }

  lanes() {
    return this.database.prepare("SELECT * FROM lanes ORDER BY worktree_path").all().map(toLane)
  }

  hasDispatched(worktreePath, eventKey) {
    return Boolean(
      this.database
        .prepare("SELECT 1 FROM dispatched_events WHERE worktree_path = ? AND event_key = ?")
        .get(worktreePath, eventKey),
    )
  }

  markDispatched(worktreePath, eventKey) {
    this.database
      .prepare("INSERT OR IGNORE INTO dispatched_events (worktree_path, event_key, created_at) VALUES (?, ?, ?)")
      .run(worktreePath, eventKey, new Date().toISOString())
  }
}

function toLane(row) {
  return {
    worktreePath: row.worktree_path,
    opencodeSessionId: row.opencode_session_id,
    codexSessionId: row.codex_session_id,
    state: row.state,
    maxRounds: row.max_rounds,
  }
}
