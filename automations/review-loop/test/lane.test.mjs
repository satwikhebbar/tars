import assert from "node:assert/strict"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { groupForWorktree } from "../lib/aoe.mjs"
import { closeLane, issueOpeningPrompt, prepareTrashedWorktreeGitPointer, recoverLane, registerLane, setLaneMaxRounds, startExistingLane, startLane, worktreeForIssue } from "../lib/lane.mjs"

test("groups both sessions before watching an existing pair", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const roles = { author: { key: "opencode", tool: "opencode" }, reviewer: { key: "codex", tool: "codex" } }

  await startExistingLane({
    aoe,
    state,
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    pair: { authorSessionId: "open-44", reviewerSessionId: "codex-44" },
    roles,
    maxRounds: 5,
  })

  assert.deepEqual(aoe.moved, [
    ["open-44", groupForWorktree("/repo-worktrees/issue-44-add-calendar-export")],
    ["codex-44", groupForWorktree("/repo-worktrees/issue-44-add-calendar-export")],
  ])
  assert.equal(state.entries[0].state, "watching")
})

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
    ["open-44", groupForWorktree("/repo-worktrees/issue-44-add-calendar-export")],
    ["codex-44", groupForWorktree("/repo-worktrees/issue-44-add-calendar-export")],
  ])
})

test("normalizes legacy pair IDs when registering a lane", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const roles = { author: { key: "opencode", tool: "opencode" }, reviewer: { key: "codex", tool: "codex" } }

  const lane = await registerLane({
    aoe,
    state,
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    maxRounds: 5,
    roles,
    pair: { opencodeSessionId: "open-44", codexSessionId: "codex-44" },
  })

  assert.equal(lane.authorSessionId, "open-44")
  assert.equal(lane.reviewerSessionId, "codex-44")
  assert.equal(state.entries[0].authorSessionId, "open-44")
  assert.equal(state.entries[0].reviewerSessionId, "codex-44")
})

test("updates a lane review budget without changing workflow state or sessions", () => {
  const original = {
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    authorSessionId: "open-44",
    reviewerSessionId: "codex-44",
    state: "approved",
    phase: "post_pr_feedback",
    maxRounds: 5,
  }
  let stored = original
  const state = {
    lane: () => stored,
    saveLane: (lane) => {
      stored = lane
    },
  }

  const updated = setLaneMaxRounds({ state, worktreePath: original.worktreePath, maxRounds: 15 })

  assert.equal(updated.maxRounds, 15)
  assert.equal(updated.state, "approved")
  assert.equal(updated.phase, "post_pr_feedback")
  assert.equal(updated.authorSessionId, "open-44")
  assert.equal(updated.reviewerSessionId, "codex-44")
})

test("explicitly resumes a lane stopped at its round limit when increasing the budget", () => {
  const original = {
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    authorSessionId: "open-44",
    reviewerSessionId: "codex-44",
    state: "blocked",
    phase: "building",
    maxRounds: 5,
  }
  let stored = original
  const state = {
    lane: () => stored,
    saveLane: (lane) => {
      stored = lane
    },
  }

  const updated = setLaneMaxRounds({ state, worktreePath: original.worktreePath, maxRounds: 15, resume: true })

  assert.equal(updated.maxRounds, 15)
  assert.equal(updated.state, "implementing")
  assert.equal(updated.phase, "building")
  assert.equal(updated.authorSessionId, "open-44")
  assert.equal(updated.reviewerSessionId, "codex-44")
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
  const group = groupForWorktree(lane.worktreePath)
  assert.equal(aoe.groups[0], undefined)
  assert.deepEqual(aoe.moved, [["open-44", group]])
  assert.deepEqual(aoe.reviewerOptions, { extraArgs: [], group })
  assert.match(aoe.sent[0].message, /already-created AoE worktree/)
  assert.match(aoe.sent[0].message, /direct-build: begin implementation now/)
  assert.match(aoe.sent[0].message, /do not ask the user to choose a planning workflow/)
  assert.equal(state.entries[0].codexSessionId, "codex-44")
  assert.equal(state.entries[0].phase, "building")
})

test("starts a planning lane with OpenCode's configured Plan agent", async () => {
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
  assert.deepEqual(aoe.extraArgs, ["--agent", "tars-plan", "--model", "deepseek/v4-pro"])
  assert.equal(state.entries[0].phase, "planning")
})

test("groups a newly started lane by its actual worktree path", async () => {
  const aoe = new FakeAoe()
  aoe.worktreePath = "/repo-worktrees/actual-worktree"
  const state = new FakeState()
  const lane = await startLane({
    aoe,
    state,
    repoPath: "/repo",
    issue: { number: 44, title: "Add calendar export" },
    branch: "issue/44-add-calendar-export",
    worktreeName: "display-name-only",
    maxRounds: 5,
    planning: "not_required",
    openingPrompt: "build",
  })

  const group = groupForWorktree(lane.worktreePath)
  assert.deepEqual(aoe.moved, [["open-44", group]])
  assert.deepEqual(aoe.reviewerOptions, { extraArgs: [], group })
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

test("uses the selected harness launch arguments for author and reviewer sessions", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const roles = {
    author: { key: "codex", tool: "codex", launchArgs: ["--approve-for-me"] },
    reviewer: { key: "opencode", tool: "opencode" },
  }
  await startLane({
    aoe, state, roles, repoPath: "/repo", issue: { number: 9, title: "Approved commands" }, branch: "issue/9-approved-commands",
    worktreeName: "issue-9-approved-commands", maxRounds: 5, planning: "not_required", openingPrompt: "author prompt",
  })
  assert.deepEqual(aoe.extraArgs, ["--approve-for-me"])
  assert.deepEqual(aoe.reviewerExtraArgs, [])
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

test("closes an approved lane temporarily masked by an invalid stale handoff", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const worktreePath = "/repo--issue-44-add-calendar-export"
  state.saveLane({
    worktreePath,
    opencodeSessionId: "open-44",
    codexSessionId: "codex-44",
    state: "invalid_handoff",
    invalidResumeState: "approved",
    invalidResumePhase: "post_pr_feedback",
    maxRounds: 5,
  })
  aoe.sessions = [
    { id: "open-44", path: worktreePath, tool: "opencode" },
    { id: "codex-44", path: worktreePath, tool: "codex" },
  ]

  await closeLane({ aoe, state, worktreePath })

  assert.equal(state.lane(worktreePath), null)
  assert.deepEqual(aoe.removed, [
    ["codex-44", {}],
    ["open-44", { deleteWorktree: true, deleteBranch: true }],
  ])
})

test("finishes an interrupted approved-lane close only when both registered sessions are trashed", async () => {
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
  aoe.trashed = new Set(["open-44", "codex-44"])

  await closeLane({ aoe, state, worktreePath })

  assert.equal(state.lane(worktreePath), null)
  assert.deepEqual(aoe.removed, [])
  assert.deepEqual(aoe.deletedGroups, [groupForWorktree(worktreePath)])
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
  assert.deepEqual(aoe.deletedGroups, [groupForWorktree(worktreePath)])
  assert.equal(state.lane(worktreePath), null)
})

test("recovers a trashed author, re-groups it, and starts it without dispatching work", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const worktreePath = "/repo-worktrees/issue-44-add-calendar-export"
  state.saveLane({
    worktreePath,
    authorSessionId: "open-44",
    reviewerSessionId: "codex-44",
    authorTool: "opencode",
    reviewerTool: "codex",
    state: "reviewing",
    maxRounds: 5,
  })
  aoe.sessions = [
    { id: "open-44", path: "/repo-worktrees/.aoe-trash/open-44", tool: "opencode" },
    { id: "codex-44", path: worktreePath, tool: "codex" },
  ]
  aoe.runtime = [{ session: "open-44", state: "dead" }]
  aoe.restorePath = worktreePath

  const result = await recoverLane({ aoe, state, worktreePath, role: "author" })

  assert.deepEqual(result, {
    lane: { ...state.entries[0] },
    sessionId: "open-44",
    role: "author",
    restored: true,
    started: true,
  })
  assert.deepEqual(aoe.restored, ["open-44"])
  assert.deepEqual(aoe.started, ["open-44"])
  assert.deepEqual(aoe.moved.at(-1), ["open-44", groupForWorktree(worktreePath)])
  assert.deepEqual(aoe.sent, [])
})

test("restarts a stopped live reviewer without attempting a trash restore", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const worktreePath = "/repo-worktrees/issue-44-add-calendar-export"
  state.saveLane({ worktreePath, authorSessionId: "open-44", reviewerSessionId: "codex-44", state: "watching", maxRounds: 5 })
  aoe.sessions = [
    { id: "open-44", path: worktreePath, tool: "opencode" },
    { id: "codex-44", path: worktreePath, tool: "codex" },
  ]
  aoe.runtime = [{ session: "codex-44", state: "error" }]

  const result = await recoverLane({ aoe, state, worktreePath, role: "reviewer" })

  assert.equal(result.restored, false)
  assert.equal(result.started, true)
  assert.deepEqual(aoe.restored, [])
  assert.deepEqual(aoe.started, ["codex-44"])
})

test("does not rewrite a valid or unknown trashed git pointer", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tars-recovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const trashed = join(root, ".aoe-trash", "author")
  await mkdir(trashed, { recursive: true })
  const pointer = "gitdir: ../../repo/.git/worktrees/issue-44\n"
  await writeFile(join(trashed, ".git"), pointer)

  assert.equal(await prepareTrashedWorktreeGitPointer(trashed, join(root, "issue-44")), null)
  assert.equal(await readFile(join(trashed, ".git"), "utf8"), pointer)
})

test("temporarily repairs AoE trash's relative git pointer and restores it at the live path", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tars-recovery-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const trashed = join(root, "worktrees", ".aoe-trash", "author")
  const live = join(root, "worktrees", "issue-44")
  const gitdir = join(root, "repo", ".git", "worktrees", "issue-44")
  await mkdir(trashed, { recursive: true })
  await mkdir(gitdir, { recursive: true })
  const pointer = "gitdir: ../../repo/.git/worktrees/issue-44\n"
  await writeFile(join(trashed, ".git"), pointer)

  const finalize = await prepareTrashedWorktreeGitPointer(trashed, live)

  assert.ok(finalize)
  assert.equal(await readFile(join(trashed, ".git"), "utf8"), "gitdir: ../../../repo/.git/worktrees/issue-44\n")
  await mkdir(live, { recursive: true })
  await writeFile(join(live, ".git"), "gitdir: temporary\n")
  await finalize({ restored: true })
  assert.equal(await readFile(join(live, ".git"), "utf8"), pointer)
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
    this.deletedGroups = []
    this.restored = []
    this.started = []
    this.trashed = new Set()
  }

  async findOrCreateWorktreeSession(repoPath, branch, title, { extraArgs = [], group } = {}) {
    this.added.push([repoPath, branch])
    this.titles.push(title)
    this.extraArgs = extraArgs
    this.groups.push(group)
    return { id: "open-44", path: this.worktreePath ?? "/repo--issue-44-add-calendar-export" }
  }

  async addSession(path, tool, title, { extraArgs = [], group } = {}) {
    this.added.push([path, tool])
    this.reviewerExtraArgs = extraArgs
    this.reviewerOptions = { extraArgs, group }
    return { id: "codex-44", path }
  }

  async moveSessionToGroup(sessionId, group) {
    this.moved.push([sessionId, group])
  }

  async deleteGroup(group) {
    this.deletedGroups.push(group)
  }

  async send(sessionId, message) {
    this.sent.push({ sessionId, message })
  }

  async listSessions() {
    return this.sessions
  }

  async listTrashedSessionIds() {
    return this.trashed
  }

  async runtimeSessions() {
    return this.runtime
  }

  async restoreSession(sessionId) {
    this.restored.push(sessionId)
    const session = this.sessions.find((entry) => entry.id === sessionId)
    session.path = this.restorePath
  }

  async startSession(sessionId) {
    this.started.push(sessionId)
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
