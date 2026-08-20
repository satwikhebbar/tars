import assert from "node:assert/strict"
import test from "node:test"
import { closeLane, issueOpeningPrompt, registerLane, startLane, worktreeForIssue } from "../lib/lane.mjs"

test("groups both sessions when registering an existing lane", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const roles = { author: { key: "opencode", tool: "opencode" }, reviewer: { key: "codex", tool: "codex" } }

  await registerLane({
    aoe,
    state,
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    maxRounds: 5,
    roles,
    pair: { authorSessionId: "open-44", reviewerSessionId: "codex-44" },
  })

  assert.deepEqual(aoe.moved, [
    ["open-44", "TARS/issue-44-add-calendar-export"],
    ["codex-44", "TARS/issue-44-add-calendar-export"],
  ])
})

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
    planning: "not_required",
    openingPrompt: issueOpeningPrompt(issue),
  })
  assert.equal(lane.worktreePath, "/repo--issue-44-add-calendar-export")
  assert.deepEqual(aoe.added, [
    ["/repo", "issue/44-add-calendar-export"],
    ["/repo--issue-44-add-calendar-export", "codex"],
  ])
  assert.equal(aoe.sent[0].sessionId, "open-44")
  assert.equal(aoe.titles[0], "issue-44-add-calendar-export")
  assert.equal(aoe.groups[0], "TARS/issue-44-add-calendar-export")
  assert.deepEqual(aoe.moved, [["open-44", "TARS/issue-44-add-calendar-export"]])
  assert.deepEqual(aoe.reviewerOptions, { group: "TARS/issue-44-add-calendar-export" })
  assert.match(aoe.sent[0].message, /already-created AoE worktree/)
  assert.match(aoe.sent[0].message, /direct-build: begin implementation now/)
  assert.match(aoe.sent[0].message, /do not ask the user to choose a planning workflow/)
  assert.equal(state.entries[0].codexSessionId, "codex-44")
  assert.equal(state.entries[0].phase, "building")
})

test("starts a planning lane with OpenCode plan arguments", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  await startLane({
    aoe,
    state,
    repoPath: "/repo",
    issue: { number: 44, title: "Add calendar export" },
    branch: "issue/44-add-calendar-export",
    worktreeName: "issue-44-add-calendar-export",
    maxRounds: 5,
    planning: "required",
    planModel: "deepseek/v4-pro",
    openingPrompt: "plan",
  })
  assert.deepEqual(aoe.extraArgs, ["--agent", "plan", "--model", "deepseek/v4-pro"])
  assert.equal(state.entries[0].phase, "planning")
})

test("allows the same harness in separate author and reviewer roles", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const roles = { author: { key: "claude", tool: "claude" }, reviewer: { key: "claude", tool: "claude" } }
  await startLane({
    aoe, state, roles, repoPath: "/repo", issue: { number: 8, title: "Role flexibility" }, branch: "issue/8-role-flexibility",
    worktreeName: "issue-8-role-flexibility", maxRounds: 5, planning: "not_required", openingPrompt: "author prompt",
  })
  assert.deepEqual(aoe.added, [["/repo", "issue/8-role-flexibility"], ["/repo--issue-44-add-calendar-export", "claude"]])
  assert.equal(state.entries[0].authorHarness, "claude")
  assert.equal(state.entries[0].reviewerHarness, "claude")
  assert.equal(state.entries[0].authorTool, "claude")
  assert.equal(state.entries[0].reviewerTool, "claude")
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

  state.entries[0].state = "approved"
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

test("resolves exactly one conventionally named issue lane", () => {
  const state = new FakeState()
  state.saveLane({
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    opencodeSessionId: "open-44",
    codexSessionId: "codex-44",
    state: "watching",
    maxRounds: 5,
  })
  state.saveLane({
    worktreePath: "/repo-worktrees/feature-44-other-work",
    opencodeSessionId: "open-other",
    codexSessionId: "codex-other",
    state: "watching",
    maxRounds: 5,
  })

  assert.equal(worktreeForIssue(state, 44), "/repo-worktrees/issue-44-add-calendar-export")
  assert.throws(() => worktreeForIssue(state, 45), /No registered lane/)

  state.saveLane({
    worktreePath: "/other-worktrees/issue-44-another-copy",
    opencodeSessionId: "open-duplicate",
    codexSessionId: "codex-duplicate",
    state: "watching",
    maxRounds: 5,
  })
  assert.throws(() => worktreeForIssue(state, 44), /Found 2 registered lanes/)
})

class FakeAoe {
  constructor() {
    this.added = []
    this.sent = []
    this.titles = []
    this.sessions = []
    this.removed = []
    this.runtime = []
    this.groups = []
    this.moved = []
  }

  async findOrCreateWorktreeSession(repoPath, branch, title, { extraArgs = [], group } = {}) {
    this.added.push([repoPath, branch])
    this.titles.push(title)
    this.extraArgs = extraArgs
    this.groups.push(group)
    return { id: "open-44", path: "/repo--issue-44-add-calendar-export" }
  }

  async addSession(path, tool, title, options) {
    this.added.push([path, tool])
    this.reviewerOptions = options
    return { id: "codex-44", path }
  }

  async moveSessionToGroup(sessionId, group) {
    this.moved.push([sessionId, group])
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
    this.entries = []
  }

  saveLane(lane) {
    this.entries.push(lane)
  }

  lane(worktreePath) {
    return this.entries.find((lane) => lane.worktreePath === worktreePath) ?? null
  }

  lanes() {
    return this.entries
  }

  deleteLane(worktreePath) {
    this.entries = this.entries.filter((lane) => lane.worktreePath !== worktreePath)
  }
}
