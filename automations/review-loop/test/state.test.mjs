import assert from "node:assert/strict"
import { mkdtemp } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { StateStore } from "../lib/state.mjs"

test("persists resolved harness snapshots and ignores unbound legacy rows", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tars-state-"))
  const state = new StateStore(join(directory, "state.sqlite"))
  await state.open()
  state.database.prepare("INSERT INTO lanes (worktree_path, opencode_session_id, codex_session_id, state, max_rounds, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("/legacy", "open", "codex", "watching", 5, new Date().toISOString())
  state.saveLane({
    worktreePath: "/current", authorSessionId: "claude-author", reviewerSessionId: "cursor-reviewer",
    authorHarness: "claude", reviewerHarness: "cursor", authorTool: "claude", reviewerTool: "cursor", state: "watching", maxRounds: 5,
  })
  assert.deepEqual(state.lanes().map((lane) => lane.worktreePath), ["/current"])
  assert.deepEqual(state.lane("/current"), {
    worktreePath: "/current", authorSessionId: "claude-author", reviewerSessionId: "cursor-reviewer",
    authorHarness: "claude", reviewerHarness: "cursor", authorTool: "claude", reviewerTool: "cursor",
    state: "watching", maxRounds: 5, planning: "not_required", phase: "building", planModel: null,
    transitionHandoffPath: null, transitionWorkflowId: null, transitionRequestedAt: null,
    planVerdictPath: null, planVerdictId: null, iterationCount: 1, currentIteration: 1,
    reviewBudget: null, reviewBudgetConsumed: 0,
    invalidResumeState: null, invalidResumePhase: null,
  })
  state.close()
})

test("round-trips the review budget and consumed counter separately from max_rounds", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tars-state-"))
  const state = new StateStore(join(directory, "state.sqlite"))
  await state.open()
  const lane = {
    worktreePath: "/budgeted", authorSessionId: "claude-author", reviewerSessionId: "cursor-reviewer",
    authorHarness: "claude", reviewerHarness: "cursor", authorTool: "claude", reviewerTool: "cursor",
    state: "implementing", maxRounds: 5, planning: "required", phase: "building",
    iterationCount: 3, currentIteration: 2, reviewBudget: 6, reviewBudgetConsumed: 2,
  }
  state.saveLane(lane)
  assert.equal(state.lane("/budgeted").reviewBudget, 6)
  assert.equal(state.lane("/budgeted").reviewBudgetConsumed, 2)
  assert.equal(state.lane("/budgeted").maxRounds, 5)
  state.saveLane({ ...lane, reviewBudgetConsumed: 3 })
  assert.equal(state.lane("/budgeted").reviewBudgetConsumed, 3)
  state.close()
})

test("migrates pre-existing lanes with no review budget to the unbudgeted default", async () => {
  const directory = await mkdtemp(join(tmpdir(), "tars-state-"))
  const state = new StateStore(join(directory, "state.sqlite"))
  await state.open()
  state.database.prepare("INSERT INTO lanes (worktree_path, opencode_session_id, codex_session_id, state, max_rounds, updated_at) VALUES (?, ?, ?, ?, ?, ?)")
    .run("/legacy-budgeted", "open", "codex", "watching", 5, new Date().toISOString())
  assert.equal(state.lane("/legacy-budgeted").reviewBudget, null)
  assert.equal(state.lane("/legacy-budgeted").reviewBudgetConsumed, 0)
  state.close()
})
