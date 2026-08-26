import assert from "node:assert/strict"
import { mkdir, mkdtemp, rename, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { ReviewLoopCoordinator } from "../lib/coordinator.mjs"
import { StateStore } from "../lib/state.mjs"

test("implementation response wakes only the registered Codex session once", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "done/response.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  const result = await fixture.coordinator.processAll()
  assert.equal(result[0].action, "sent:codex")
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["codex-1"],
  )
  await fixture.coordinator.processAll()
  assert.equal(fixture.aoe.sent.length, 1)
  fixture.state.close()
})

test("accepts a numeric issue number as the stable workflow ID", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response.md",
    `id: 45-response-1\ntype: implementation-response\nworkflow_id: 45\nround: 1\nhead_commit: abc123`,
  )
  const result = await fixture.coordinator.processAll()
  assert.equal(result[0].action, "sent:codex")
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["codex-1"],
  )
  fixture.state.close()
})

test("surfaces a malformed workflow handoff and resumes after it is corrected", async () => {
  const fixture = await laneFixture()
  const frontmatter = "id: missing-round\ntype: implementation-response\nworkflow_id: 64\nhead_commit: abc123"
  await writeWorkflowHandoff(fixture.worktree, "inbox/response.md", frontmatter)

  const invalid = await fixture.coordinator.processAll()
  assert.match(invalid[0].action, /invalid-handoff: missing positive integer round/)
  assert.equal(fixture.state.lane(fixture.worktree).state, "invalid_handoff")
  assert.equal(fixture.aoe.sent.length, 0)

  await writeWorkflowHandoff(fixture.worktree, "inbox/response.md", `${frontmatter}\nround: 1`)
  const recovered = await fixture.coordinator.processAll()
  assert.equal(recovered[0].action, "sent:codex")
  assert.equal(fixture.state.lane(fixture.worktree).state, "reviewing")
  fixture.state.close()
})

test("routes role-based author handoffs to a non-Codex reviewer and ignores the wrong role", async () => {
  const fixture = await laneFixture({ authorHarness: "claude", reviewerHarness: "cursor" })
  await writeWorkflowHandoff(fixture.worktree, "inbox/ignored.md", `id: wrong-role\ntype: implementation-response\ncreated_by: reviewer\nworkflow_id: 45\nround: 1\nhead_commit: abc123`)
  await writeWorkflowHandoff(fixture.worktree, "inbox/author.md", `id: author-response\ntype: implementation-response\ncreated_by: author\nworkflow_id: 45\nround: 1\nhead_commit: def456`)
  const result = await fixture.coordinator.processAll()
  assert.equal(result[0].action, "sent:cursor")
  assert.deepEqual(fixture.aoe.sent.map((entry) => entry.sessionId), ["codex-1"])
  fixture.state.close()
})

test("a non-OpenCode author starts approved plan work without an OpenCode compact command", async () => {
  const fixture = await laneFixture({ authorHarness: "claude", reviewerHarness: "codex" })
  await writeWorkflowHandoff(fixture.worktree, "inbox/plan-verdict.md", `id: plan-verdict\ntype: plan-review-verdict\ncreated_by: reviewer\nworkflow_id: 45\nround: 1\noutcome: approved\niteration_count: 1`)
  const result = await fixture.coordinator.processAll()
  assert.equal(result[0].action, "sent:author:build")
  assert.equal(fixture.aoe.sent[0].sessionId, "opencode-1")
  assert.doesNotMatch(fixture.aoe.sent[0].message, /^\/compact$/)
  assert.doesNotMatch(fixture.aoe.sent[0].message, /^\/tars-build/)
  fixture.state.close()
})

test("plan approval compacts then starts Build mode without approving the lane", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/plan.md",
    `id: 53-plan-review-1\ntype: plan-review\ncreated_by: opencode\nworkflow_id: 53\nround: 1\ntarget:\n  - plans/example.md`,
  )
  await fixture.coordinator.processAll()
  assert.deepEqual(fixture.aoe.sent.map((entry) => entry.sessionId), ["codex-1"])
  assert.match(fixture.aoe.sent[0].message, /plan-review-verdict/)

  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/plan-verdict.md",
    `id: 53-plan-review-1-verdict\ntype: plan-review-verdict\ncreated_by: codex\nworkflow_id: 53\nround: 1\noutcome: approved\niteration_count: 1\nresponds_to: 53-plan-review-1`,
  )
  await fixture.coordinator.processAll()
  assert.deepEqual(fixture.aoe.sent.map((entry) => entry.sessionId), ["codex-1", "opencode-1"])
  assert.equal(fixture.aoe.sent[1].message, "/compact")
  assert.equal(fixture.state.lane(fixture.worktree).phase, "compacting")

  const compactingLane = fixture.state.lane(fixture.worktree)
  fixture.state.saveLane({ ...compactingLane, transitionRequestedAt: new Date(Date.now() - 3_000).toISOString() })
  await fixture.coordinator.processAll()
  assert.equal(fixture.state.lane(fixture.worktree).state, "implementing")
  assert.equal(fixture.state.lane(fixture.worktree).phase, "building")
  assert.match(fixture.aoe.sent[2].message, /^\/tars-build /)
  assert.match(fixture.aoe.sent[2].message, /Continue the approved TARS plan/)
  assert.match(fixture.aoe.sent[2].message, /round 2/)
  assert.doesNotMatch(fixture.aoe.sent[2].message, /push the approved branch/i)
  fixture.state.close()
})

test("a planned lane reviews each approved iteration before opening a PR", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/plan-verdict.md",
    `id: 53-plan-review-1-verdict\ntype: plan-review-verdict\ncreated_by: codex\nworkflow_id: 53\nround: 1\noutcome: approved\niteration_count: 2\nresponds_to: 53-plan-review-1`,
  )
  await fixture.coordinator.processAll()
  const compactingLane = fixture.state.lane(fixture.worktree)
  fixture.state.saveLane({ ...compactingLane, transitionRequestedAt: new Date(Date.now() - 3_000).toISOString() })
  await fixture.coordinator.processAll()
  assert.match(fixture.aoe.sent.at(-1).message, /iteration 1 of 2/)
  await mkdir(join(fixture.worktree, ".agent-handoff", "archive"), { recursive: true })
  await rename(
    join(fixture.worktree, ".agent-handoff", "inbox", "plan-verdict.md"),
    join(fixture.worktree, ".agent-handoff", "archive", "plan-verdict.md"),
  )

  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/iteration-1-response.md",
    `id: 53-iteration-1-response\ntype: implementation-response\nworkflow_id: 53\nround: 2\niteration: 1\nhead_commit: abc123`,
  )
  await fixture.coordinator.processAll()
  assert.equal(fixture.aoe.sent.at(-1).sessionId, "codex-1")
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/iteration-1-review.md",
    `id: 53-iteration-1-review\ntype: code-review\nworkflow_id: 53\nround: 2\niteration: 1\noutcome: approved\nresponds_to: 53-iteration-1-response`,
  )
  await fixture.coordinator.processAll()
  assert.equal(fixture.state.lane(fixture.worktree).currentIteration, 2)
  assert.equal(fixture.state.lane(fixture.worktree).state, "implementing")
  assert.match(fixture.aoe.sent.at(-1).message, /iteration 2 of 2/)
  assert.match(fixture.aoe.sent.at(-1).message, /\.agent-handoff\/archive\/plan-verdict\.md/)

  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/iteration-2-response.md",
    `id: 53-iteration-2-response\ntype: implementation-response\nworkflow_id: 53\nround: 3\niteration: 2\nhead_commit: def456`,
  )
  await fixture.coordinator.processAll()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/iteration-2-review.md",
    `id: 53-iteration-2-review\ntype: code-review\nworkflow_id: 53\nround: 3\niteration: 2\noutcome: approved\nresponds_to: 53-iteration-2-response`,
  )
  await fixture.coordinator.processAll()
  assert.equal(fixture.state.lane(fixture.worktree).state, "approved")
  assert.match(fixture.aoe.sent.at(-1).message, /^\/tars-build /)
  assert.match(fixture.aoe.sent.at(-1).message, /create a pull request/i)
  fixture.state.close()
})

test("changes requested wakes OpenCode and approval tells OpenCode to push and open a PR", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/review.md",
    `id: fix-r1-review\ntype: code-review\nworkflow_id: fix\nround: 1\noutcome: changes_requested`,
  )
  await fixture.coordinator.processAll()
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["opencode-1"],
  )
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/approval.md",
    `id: fix-r2-review\ntype: code-review\nworkflow_id: fix\nround: 2\noutcome: approved`,
  )
  await fixture.coordinator.processAll()
  assert.equal(fixture.state.lane(fixture.worktree).state, "approved")
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["opencode-1", "opencode-1"],
  )
  assert.match(fixture.aoe.sent[1].message, /push the approved branch/i)
  assert.match(fixture.aoe.sent[1].message, /create a pull request/i)
  fixture.state.close()
})

test("planned-build changes requested re-enters OpenCode Build mode", async () => {
  const fixture = await laneFixture()
  fixture.state.saveLane({ ...fixture.state.lane(fixture.worktree), phase: "building" })
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/review.md",
    `id: planned-r1-review\ntype: code-review\nworkflow_id: planned\nround: 1\niteration: 1\noutcome: changes_requested`,
  )

  await fixture.coordinator.processAll()
  assert.equal(fixture.aoe.sent.at(-1).sessionId, "opencode-1")
  assert.match(fixture.aoe.sent.at(-1).message, /^\/tars-build /)
  fixture.state.close()
})

test("an explicitly reopened approved lane re-reviews PR feedback and updates its existing PR", async () => {
  const fixture = await laneFixture()
  fixture.state.saveLane({ ...fixture.state.lane(fixture.worktree), state: "approved", phase: "building" })
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/pr-feedback-response.md",
    `id: fix-pr-feedback-response-1\ntype: implementation-response\nworkflow_id: fix\nround: 1\niteration: 1\nreopen: true\nhead_commit: def456`,
  )
  await fixture.coordinator.processAll()
  assert.equal(fixture.aoe.sent.at(-1).sessionId, "codex-1")
  assert.equal(fixture.state.lane(fixture.worktree).state, "reviewing")
  assert.equal(fixture.state.lane(fixture.worktree).phase, "post_pr_feedback")

  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/pr-feedback-approval.md",
    `id: fix-pr-feedback-review-1\ntype: code-review\nworkflow_id: fix\nround: 1\niteration: 1\noutcome: approved\nresponds_to: fix-pr-feedback-response-1`,
  )
  await fixture.coordinator.processAll()
  assert.equal(fixture.state.lane(fixture.worktree).state, "approved")
  assert.match(fixture.aoe.sent.at(-1).message, /^\/tars-build /)
  assert.match(fixture.aoe.sent.at(-1).message, /existing pull request/i)
  assert.doesNotMatch(fixture.aoe.sent.at(-1).message, /create a pull request/i)
  fixture.state.close()
})

test("a lane blocks instead of dispatching beyond its round limit", async () => {
  const fixture = await laneFixture({ maxRounds: 1 })
  await writeWorkflowHandoff(
    fixture.worktree,
    "done/response.md",
    `id: fix-r2-response\ntype: implementation-response\nworkflow_id: fix\nround: 2\nhead_commit: abc123`,
  )
  const result = await fixture.coordinator.processAll()
  assert.equal(result[0].action, "blocked")
  assert.equal(fixture.aoe.sent.length, 0)
  fixture.state.close()
})

async function laneFixture({ maxRounds = 5, authorHarness = "opencode", reviewerHarness = "codex" } = {}) {
  const worktree = await mkdtemp(join(tmpdir(), "agent-review-loop-"))
  await Promise.all([
    mkdir(join(worktree, ".agent-handoff", "inbox"), { recursive: true }),
    mkdir(join(worktree, ".agent-handoff", "done"), { recursive: true }),
  ])
  const state = new StateStore(join(worktree, "state.sqlite"))
  await state.open()
  state.saveLane({
    worktreePath: worktree,
    opencodeSessionId: "opencode-1",
    codexSessionId: "codex-1",
    authorSessionId: "opencode-1",
    reviewerSessionId: "codex-1",
    authorHarness,
    reviewerHarness,
    authorTool: authorHarness,
    reviewerTool: reviewerHarness,
    state: "watching",
    maxRounds,
    planning: "required",
    phase: "planning",
  })
  const aoe = new FakeAoe()
  return { worktree, state, aoe, coordinator: new ReviewLoopCoordinator({ aoe, state }) }
}

async function writeWorkflowHandoff(worktree, relativePath, frontmatter) {
  await writeFile(join(worktree, ".agent-handoff", relativePath), `---\n${frontmatter}\n---\n`, "utf8")
}

class FakeAoe {
  constructor() {
    this.sent = []
  }

  async runningSessions() {
    return [
      { session: "opencode-1", state: "idle" },
      { session: "codex-1", state: "waiting" },
    ]
  }

  async send(sessionId, message) {
    this.sent.push({ sessionId, message })
  }
}
