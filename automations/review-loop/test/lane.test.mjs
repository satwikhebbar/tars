import assert from "node:assert/strict"
import test from "node:test"
import { closeLane, issueOpeningPrompt, startLane } from "../lib/lane.mjs"

test("starts one implementation session and one reviewer in its AoE worktree", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const issue = { number: 44, title: "Add calendar export", url: "https://example.test/issues/44" }
  const lane = await startLane({
    aoe,
    state,
    repoPath: "/repo",
    issue,
    branch: "issue/44-add-calendar-export",
    worktreeName: "issue-44-add-calendar-export",
    maxRounds: 5,
    openingPrompt: issueOpeningPrompt(issue),
  })
  assert.equal(lane.worktreePath, "/repo--issue-44-add-calendar-export")
  assert.deepEqual(aoe.added, [
    ["/repo", "issue/44-add-calendar-export"],
    ["/repo--issue-44-add-calendar-export", "codex"],
  ])
  assert.equal(aoe.sent[0].sessionId, "open-44")
  assert.equal(aoe.titles[0], "issue-44-add-calendar-export")
  assert.match(aoe.sent[0].message, /already-created AoE worktree/)
  assert.equal(state.lanes[0].codexSessionId, "codex-44")
})

test("closes an approved lane through AoE before deleting its worktree", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const worktreePath = "/repo--issue-44-add-calendar-export"
  state.saveLane({
    worktreePath,
    opencodeSessionId: "open-44",
    codexSessionId: "codex-44",
    state: "approved",
    maxRounds: 5,
  })
  aoe.sessions = [
    { id: "open-44", path: worktreePath, tool: "opencode" },
    { id: "codex-44", path: worktreePath, tool: "codex" },
  ]

  await closeLane({ aoe, state, worktreePath })

  assert.deepEqual(aoe.removed, [
    ["codex-44", {}],
    ["open-44", { deleteWorktree: true, deleteBranch: true }],
  ])
  assert.equal(state.lane(worktreePath), null)
})

test("refuses to close a non-approved or shared lane", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const worktreePath = "/repo--issue-44-add-calendar-export"
  state.saveLane({
    worktreePath,
    opencodeSessionId: "open-44",
    codexSessionId: "codex-44",
    state: "watching",
    maxRounds: 5,
  })
  await assert.rejects(closeLane({ aoe, state, worktreePath }), /only approved lanes/)

  state.lanes[0].state = "approved"
  aoe.sessions = [
    { id: "open-44", path: worktreePath, tool: "opencode" },
    { id: "codex-44", path: worktreePath, tool: "codex" },
    { id: "other", path: worktreePath, tool: "opencode" },
  ]
  await assert.rejects(closeLane({ aoe, state, worktreePath }), /unrelated AoE session/)
})

test("force-closes a stopped non-approved lane, but never a live one", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const worktreePath = "/repo--issue-44-add-calendar-export"
  state.saveLane({
    worktreePath,
    opencodeSessionId: "open-44",
    codexSessionId: "codex-44",
    state: "watching",
    maxRounds: 5,
  })
  aoe.sessions = [
    { id: "open-44", path: worktreePath, tool: "opencode" },
    { id: "codex-44", path: worktreePath, tool: "codex" },
  ]

  aoe.runtime = [
    { session: "open-44", substrate: "tmux", state: "running" },
    { session: "codex-44", substrate: "tmux", state: "dead" },
  ]
  await assert.rejects(closeLane({ aoe, state, worktreePath, force: true }), /Not dead: open-44/)
  assert.equal(state.lane(worktreePath)?.state, "watching")

  aoe.runtime[0].state = "dead"
  await closeLane({ aoe, state, worktreePath, force: true })
  assert.deepEqual(aoe.removed, [
    ["codex-44", {}],
    ["open-44", { deleteWorktree: true, deleteBranch: true }],
  ])
  assert.equal(state.lane(worktreePath), null)
})

class FakeAoe {
  constructor() {
    this.added = []
    this.sent = []
    this.titles = []
    this.sessions = []
    this.removed = []
    this.runtime = []
  }

  async findOrCreateWorktreeSession(repoPath, branch, title) {
    this.added.push([repoPath, branch])
    this.titles.push(title)
    return { id: "open-44", path: "/repo--issue-44-add-calendar-export" }
  }

  async addSession(path, tool) {
    this.added.push([path, tool])
    return { id: "codex-44", path }
  }

  async send(sessionId, message) {
    this.sent.push({ sessionId, message })
  }

  async listSessions() {
    return this.sessions
  }

  async runtimeSessions() {
    return this.runtime
  }

  async removeSession(sessionId, options = {}) {
    this.removed.push([sessionId, options])
  }
}

class FakeState {
  constructor() {
    this.lanes = []
  }

  saveLane(lane) {
    this.lanes.push(lane)
  }

  lane(worktreePath) {
    return this.lanes.find((lane) => lane.worktreePath === worktreePath) ?? null
  }

  deleteLane(worktreePath) {
    this.lanes = this.lanes.filter((lane) => lane.worktreePath !== worktreePath)
  }
}
