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
    invalidResumeState: null, invalidResumePhase: null,
  })
  state.close()
})
