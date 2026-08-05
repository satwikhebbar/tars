import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
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

async function laneFixture({ maxRounds = 5 } = {}) {
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
    state: "watching",
    maxRounds,
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
