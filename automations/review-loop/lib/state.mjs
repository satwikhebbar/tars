import { randomUUID } from "node:crypto"
import { mkdir } from "node:fs/promises"
import { dirname } from "node:path"
import { DatabaseSync } from "node:sqlite"

const CLAIM_TIMEOUT_MS = 60_000

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
      PRAGMA busy_timeout = 5000;
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
        invalid_resume_state TEXT,
        invalid_resume_phase TEXT,
        updated_at TEXT NOT NULL
      );
      CREATE TABLE IF NOT EXISTS dispatched_events (
        worktree_path TEXT NOT NULL,
        event_key TEXT NOT NULL,
        created_at TEXT NOT NULL,
        PRIMARY KEY (worktree_path, event_key)
      );
      CREATE TABLE IF NOT EXISTS lane_claims (
        worktree_path TEXT PRIMARY KEY,
        claimed_at TEXT NOT NULL,
        token TEXT NOT NULL DEFAULT ''
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
      "invalid_resume_state TEXT",
      "invalid_resume_phase TEXT",
    ]) {
      try {
        this.database.exec(`ALTER TABLE lanes ADD COLUMN ${column}`)
      } catch (error) {
        if (!String(error.message).includes("duplicate column name")) throw error
      }
    }
    try {
      this.database.exec(`ALTER TABLE lane_claims ADD COLUMN token TEXT NOT NULL DEFAULT ''`)
    } catch (error) {
      if (!String(error.message).includes("duplicate column name")) throw error
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
      .prepare(`INSERT INTO lanes (worktree_path, opencode_session_id, codex_session_id, author_session_id, reviewer_session_id, author_harness, reviewer_harness, author_tool, reviewer_tool, state, max_rounds, planning, phase, plan_model, transition_handoff_path, transition_workflow_id, transition_requested_at, plan_verdict_path, plan_verdict_id, iteration_count, current_iteration, invalid_resume_state, invalid_resume_phase, updated_at)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
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
          invalid_resume_state = excluded.invalid_resume_state,
          invalid_resume_phase = excluded.invalid_resume_phase,
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
        lane.invalidResumeState ?? null,
        lane.invalidResumePhase ?? null,
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

  /** Returns dispatched event keys and their recorded delivery timestamps. */
  dispatchedEvents(worktreePath) {
    const rows = this.database
      .prepare("SELECT event_key, created_at FROM dispatched_events WHERE worktree_path = ?")
      .all(worktreePath)
    return new Map(rows.map((row) => [row.event_key, row.created_at]))
  }

  /** Removes one recorded delivery so an operator-approved retry can re-dispatch it. */
  clearDispatched(worktreePath, eventKey) {
    this.database
      .prepare("DELETE FROM dispatched_events WHERE worktree_path = ? AND event_key = ?")
      .run(worktreePath, eventKey)
  }

  /**
   * Atomically claims a lane for dispatch and returns an ownership token, or
   * `null` when another dispatcher holds the current claim. Only the holder of
   * the returned token may release the claim, so a dispatcher whose stale lease
   * was taken over cannot delete the replacement claim. A claim abandoned by a
   * crashed process is stolen once it is older than the timeout.
   */
  claimLane(worktreePath) {
    this.database.exec("BEGIN IMMEDIATE")
    try {
      const existing = this.database
        .prepare("SELECT claimed_at FROM lane_claims WHERE worktree_path = ?")
        .get(worktreePath)
      const token = randomUUID()
      const now = new Date().toISOString()
      if (existing) {
        const age = Date.now() - Date.parse(existing.claimed_at)
        if (Number.isFinite(age) && age < CLAIM_TIMEOUT_MS) return null
        this.database
          .prepare("UPDATE lane_claims SET token = ?, claimed_at = ? WHERE worktree_path = ?")
          .run(token, now, worktreePath)
        return token
      }
      const inserted = this.database
        .prepare("INSERT OR IGNORE INTO lane_claims (worktree_path, token, claimed_at) VALUES (?, ?, ?)")
        .run(worktreePath, token, now)
      return inserted.changes > 0 ? token : null
    } finally {
      this.database.exec("COMMIT")
    }
  }

  /** Releases a dispatch claim only if the caller owns its current generation. */
  releaseLane(worktreePath, token) {
    const result = this.database
      .prepare("DELETE FROM lane_claims WHERE worktree_path = ? AND token = ?")
      .run(worktreePath, token)
    return result.changes > 0
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
    invalidResumeState: row.invalid_resume_state,
    invalidResumePhase: row.invalid_resume_phase,
  }
}
