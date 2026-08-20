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
        planning TEXT NOT NULL DEFAULT 'not_required',
        phase TEXT NOT NULL DEFAULT 'building',
        plan_model TEXT,
        transition_handoff_path TEXT,
        transition_workflow_id TEXT,
        transition_requested_at TEXT,
        plan_verdict_path TEXT,
        plan_verdict_id TEXT,
        iteration_count INTEGER NOT NULL DEFAULT 1,
        current_iteration INTEGER NOT NULL DEFAULT 1,
        author_session_id TEXT,
        reviewer_session_id TEXT,
        author_harness TEXT,
        reviewer_harness TEXT,
        author_tool TEXT,
        reviewer_tool TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatched_events (
        worktree_path TEXT NOT NULL,
        event_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (worktree_path, event_key)
      );
    `)
    for (const column of [
      "planning TEXT NOT NULL DEFAULT 'not_required'",
      "phase TEXT NOT NULL DEFAULT 'building'",
      "plan_model TEXT",
      "transition_handoff_path TEXT",
      "transition_workflow_id TEXT",
      "transition_requested_at TEXT",
      "plan_verdict_path TEXT",
      "plan_verdict_id TEXT",
      "iteration_count INTEGER NOT NULL DEFAULT 1",
      "current_iteration INTEGER NOT NULL DEFAULT 1",
      "author_session_id TEXT",
      "reviewer_session_id TEXT",
      "author_harness TEXT",
      "reviewer_harness TEXT",
      "author_tool TEXT",
      "reviewer_tool TEXT",
    ]) {
      try {
        this.database.exec(`ALTER TABLE lanes ADD COLUMN ${column}`)
      } catch (error) {
        if (!String(error.message).includes("duplicate column name")) throw error
      }
    }
  }

  close() {
    this.database?.close()
    this.database = null
  }

  saveLane(lane) {
    const authorSessionId = lane.authorSessionId ?? lane.opencodeSessionId
    const reviewerSessionId = lane.reviewerSessionId ?? lane.codexSessionId
    const authorHarness = lane.authorHarness ?? "opencode"
    const reviewerHarness = lane.reviewerHarness ?? "codex"
    const authorTool = lane.authorTool ?? "opencode"
    const reviewerTool = lane.reviewerTool ?? "codex"
    this.database
      .prepare(`INSERT INTO lanes (worktree_path, opencode_session_id, codex_session_id, author_session_id, reviewer_session_id, author_harness, reviewer_harness, author_tool, reviewer_tool, state, max_rounds, planning, phase, plan_model, transition_handoff_path, transition_workflow_id, transition_requested_at, plan_verdict_path, plan_verdict_id, iteration_count, current_iteration, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON CONFLICT(worktree_path) DO UPDATE SET
          author_session_id = excluded.author_session_id,
          reviewer_session_id = excluded.reviewer_session_id,
          author_harness = excluded.author_harness,
          reviewer_harness = excluded.reviewer_harness,
          author_tool = excluded.author_tool,
          reviewer_tool = excluded.reviewer_tool,
          state = excluded.state,
          max_rounds = excluded.max_rounds,
          planning = excluded.planning,
          phase = excluded.phase,
          plan_model = excluded.plan_model,
          transition_handoff_path = excluded.transition_handoff_path,
          transition_workflow_id = excluded.transition_workflow_id,
          transition_requested_at = excluded.transition_requested_at,
          plan_verdict_path = excluded.plan_verdict_path,
          plan_verdict_id = excluded.plan_verdict_id,
          iteration_count = excluded.iteration_count,
          current_iteration = excluded.current_iteration,
          updated_at = excluded.updated_at`)
      .run(
        lane.worktreePath,
        authorSessionId,
        reviewerSessionId,
        authorSessionId,
        reviewerSessionId,
        authorHarness,
        reviewerHarness,
        authorTool,
        reviewerTool,
        lane.state,
        lane.maxRounds,
        lane.planning ?? "not_required",
        lane.phase ?? "building",
        lane.planModel ?? null,
        lane.transitionHandoffPath ?? null,
        lane.transitionWorkflowId ?? null,
        lane.transitionRequestedAt ?? null,
        lane.planVerdictPath ?? null,
        lane.planVerdictId ?? null,
        lane.iterationCount ?? 1,
        lane.currentIteration ?? 1,
        new Date().toISOString(),
      )
  }

  lane(worktreePath) {
    const row = this.database.prepare("SELECT * FROM lanes WHERE worktree_path = ?").get(worktreePath)
    return row ? toLane(row) : null
  }

  lanes() {
    return this.database.prepare("SELECT * FROM lanes ORDER BY worktree_path").all().map(toLane).filter((lane) => lane.authorSessionId && lane.reviewerSessionId)
  }

  deleteLane(worktreePath) {
    this.database.prepare("DELETE FROM lanes WHERE worktree_path = ?").run(worktreePath)
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
    authorSessionId: row.author_session_id,
    reviewerSessionId: row.reviewer_session_id,
    authorHarness: row.author_harness,
    reviewerHarness: row.reviewer_harness,
    authorTool: row.author_tool,
    reviewerTool: row.reviewer_tool,
    state: row.state,
    maxRounds: row.max_rounds,
    planning: row.planning,
    phase: row.phase,
    planModel: row.plan_model,
    transitionHandoffPath: row.transition_handoff_path,
    transitionWorkflowId: row.transition_workflow_id,
    transitionRequestedAt: row.transition_requested_at,
    planVerdictPath: row.plan_verdict_path,
    planVerdictId: row.plan_verdict_id,
    iterationCount: row.iteration_count,
    currentIteration: row.current_iteration,
  }
}
