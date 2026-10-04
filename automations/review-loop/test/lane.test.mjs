import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { mkdir, mkdtemp, readFile, rm, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { promisify } from "node:util"
import { groupForWorktree } from "../lib/aoe.mjs"
import { openCodeServerConfig } from "../lib/investigation-capture.mjs"
import { closeLane, issueOpeningPrompt, prepareTrashedWorktreeGitPointer, recoverLane, registerLane, setLaneLimits, startExistingLane, startLane, worktreeForIssue } from "../lib/lane.mjs"

const execFileAsync = promisify(execFile)

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

  const updated = setLaneLimits({ state, worktreePath: original.worktreePath, maxRounds: 15 })

  assert.equal(updated.maxRounds, 15)
  assert.equal(updated.state, "approved")
  assert.equal(updated.phase, "post_pr_feedback")
  assert.equal(updated.authorSessionId, "open-44")
  assert.equal(updated.reviewerSessionId, "codex-44")
})

test("updates the review budget without touching max_rounds or resetting consumption", () => {
  const original = {
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    authorSessionId: "open-44",
    reviewerSessionId: "codex-44",
    state: "blocked",
    phase: "building",
    maxRounds: 5,
    reviewBudget: 2,
    reviewBudgetConsumed: 2,
  }
  let stored = original
  const state = {
    lane: () => stored,
    saveLane: (lane) => {
      stored = lane
    },
  }

  const updated = setLaneLimits({ state, worktreePath: original.worktreePath, reviewBudget: 10 })

  assert.equal(updated.reviewBudget, 10)
  assert.equal(updated.maxRounds, 5)
  assert.equal(updated.reviewBudgetConsumed, 2)
  assert.equal(updated.state, "blocked")
})

test("raises the review budget and explicitly resumes a blocked lane", () => {
  const original = {
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    authorSessionId: "open-44",
    reviewerSessionId: "codex-44",
    state: "blocked",
    phase: "building",
    maxRounds: 5,
    reviewBudget: 1,
    reviewBudgetConsumed: 1,
  }
  let stored = original
  const state = {
    lane: () => stored,
    saveLane: (lane) => {
      stored = lane
    },
  }

  const updated = setLaneLimits({ state, worktreePath: original.worktreePath, reviewBudget: 3, resume: true })

  assert.equal(updated.reviewBudget, 3)
  assert.equal(updated.state, "implementing")
  assert.equal(updated.phase, "building")
  assert.equal(updated.reviewBudgetConsumed, 1)
})

test("refuses to update a lane with no limit flags", () => {
  const original = {
    worktreePath: "/repo-worktrees/issue-44-add-calendar-export",
    authorSessionId: "open-44",
    reviewerSessionId: "codex-44",
    state: "blocked",
    phase: "building",
    maxRounds: 5,
  }
  const state = {
    lane: () => original,
    saveLane: () => {},
  }

  assert.throws(() => setLaneLimits({ state, worktreePath: original.worktreePath }), /requires --max-rounds or --review-budget/)
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

  const updated = setLaneLimits({ state, worktreePath: original.worktreePath, maxRounds: 15, resume: true })

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

test("starts a capture-enabled Codex lane with separate trace roots under CODEX_HOME", async () => {
  const previousCodexHome = process.env.CODEX_HOME
  const codexHome = await mkdtemp(join(tmpdir(), "tars-codex-home-"))
  process.env.CODEX_HOME = codexHome
  try {
    const aoe = new FakeAoe()
    const state = new FakeState()
    state.path = "/tmp/tars-state/state.sqlite"
    const roles = {
      author: { key: "codex", tool: "codex", launchArgs: ["--approve-for-me"] },
      reviewer: { key: "codex", tool: "codex", launchArgs: ["--approve-for-me"] },
    }
    await startLane({
      aoe, state, roles, repoPath: "/repo", issue: { number: 21, title: "Capture probe" },
      branch: "issue/21-capture-probe", worktreeName: "issue-21-capture-probe", maxRounds: 5,
      planning: "not_required", openingPrompt: "start", investigationCapture: true,
    })

    const traceRoot = `${codexHome}/tars/rollout-traces/lane-[0-9a-f-]+`
    assert.match(aoe.command, new RegExp(`^env CODEX_ROLLOUT_TRACE_ROOT='${traceRoot}/author' codex$`))
    assert.match(aoe.reviewerCommand, new RegExp(`^env CODEX_ROLLOUT_TRACE_ROOT='${traceRoot}/reviewer' codex$`))
    assert.notEqual(aoe.command, aoe.reviewerCommand)
    assert.equal(state.entries[0].investigationCapture, "capture")
    assert.equal(state.entries[0].authorEvidence.harness, "codex")
    assert.equal(state.entries[0].reviewerEvidence.harness, "codex")
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await rm(codexHome, { recursive: true, force: true })
  }
})

test("purges sessions created before a capture reviewer startup failure", async () => {
  const previousCodexHome = process.env.CODEX_HOME
  const codexHome = await mkdtemp(join(tmpdir(), "tars-codex-home-"))
  process.env.CODEX_HOME = codexHome
  try {
    const aoe = new FakeAoe()
    aoe.addError = new Error("reviewer failed")
    aoe.addsBeforeFailure = true
    const state = new FakeState()
    const captureRuntime = new FakeCaptureRuntime()
    state.path = "/tmp/tars-state/state.sqlite"
    const roles = {
      author: { key: "opencode", tool: "opencode" },
      reviewer: { key: "codex", tool: "codex" },
    }

    await assert.rejects(
      () => startLane({
        aoe, state, roles, repoPath: "/repo", issue: { number: 21, title: "Capture probe" },
        branch: "issue/21-capture-probe", worktreeName: "issue-21-capture-probe", maxRounds: 5,
        planning: "not_required", openingPrompt: "start", investigationCapture: true, captureRuntime,
      }),
      /reviewer failed/,
    )

    assert.deepEqual(aoe.removed, [
      ["open-44", { purge: true }],
      ["failed-reviewer", { purge: true, force: true }],
      ["open-attached", { deleteWorktree: true, deleteBranch: true, force: true, purge: true }],
    ])
    assert.deepEqual(captureRuntime.stopped, [6001])
    assert.deepEqual(state.entries, [])
  } finally {
    if (previousCodexHome === undefined) delete process.env.CODEX_HOME
    else process.env.CODEX_HOME = previousCodexHome
    await rm(codexHome, { recursive: true, force: true })
  }
})

test("cleans up the placeholder and worktree when native OpenCode creation fails", async (t) => {
  const fixture = await captureGitFixture(t, "codex/capture-native-failure")
  const captureHome = await mkdtemp(join(tmpdir(), "tars-capture-home-"))
  t.after(() => rm(captureHome, { recursive: true, force: true }))
  const aoe = new FakeAoe()
  aoe.worktreePath = fixture.worktreePath
  const state = new FakeState()
  const runtime = new FakeCaptureRuntime()
  runtime.createSession = async () => { throw new Error("native creation failed") }
  await assert.rejects(startLane({
    aoe, state, captureRuntime: runtime, captureHome, repoPath: fixture.repo,
    issue: { number: 24, title: "Capture" }, branch: "issue/24-capture",
    worktreeName: "issue-24-capture", maxRounds: 5, planning: "not_required",
    openingPrompt: "start", investigationCapture: true,
  }), /native creation failed/)
  assert.deepEqual(runtime.stopped, [6001])
  assert.deepEqual(aoe.removed, [["open-44", { deleteWorktree: true, deleteBranch: true, force: true, purge: true }]])
  assert.deepEqual(state.entries, [])
  await assert.rejects(readFile(join(fixture.worktreePath, "README.md")), { code: "ENOENT" })
  assert.equal((await execFileAsync("git", ["-C", fixture.repo, "branch", "--list", fixture.branch])).stdout.trim(), "")
})

test("cleans up native OpenCode evidence when author attachment fails", async (t) => {
  const fixture = await captureGitFixture(t, "codex/capture-attach-failure")
  const captureHome = await mkdtemp(join(tmpdir(), "tars-capture-home-"))
  t.after(() => rm(captureHome, { recursive: true, force: true }))
  const aoe = new FakeAoe()
  aoe.worktreePath = fixture.worktreePath
  aoe.attachError = new Error("attach failed")
  const state = new FakeState()
  const runtime = new FakeCaptureRuntime()
  await assert.rejects(startLane({
    aoe, state, captureRuntime: runtime, captureHome, repoPath: fixture.repo,
    issue: { number: 25, title: "Capture" }, branch: "issue/25-capture",
    worktreeName: "issue-25-capture", maxRounds: 5, planning: "not_required",
    openingPrompt: "start", investigationCapture: true,
  }), /attach failed/)
  assert.deepEqual(runtime.stopped, [6001])
  assert.deepEqual(aoe.removed, [["open-44", { purge: true }]])
  assert.deepEqual(state.entries, [])
  await assert.rejects(readFile(join(fixture.worktreePath, "README.md")), { code: "ENOENT" })
  assert.equal((await execFileAsync("git", ["-C", fixture.repo, "branch", "--list", fixture.branch])).stdout.trim(), "")
})

test("starts two OpenCode capture roles with distinct native sessions", async (t) => {
  const captureHome = await mkdtemp(join(tmpdir(), "tars-capture-home-"))
  t.after(() => rm(captureHome, { recursive: true, force: true }))
  const aoe = new FakeAoe()
  const state = new FakeState()
  const runtime = new FakeCaptureRuntime()
  await startLane({
    aoe, state, captureRuntime: runtime, captureHome, repoPath: "/repo",
    issue: { number: 26, title: "Capture" }, branch: "issue/26-capture",
    worktreeName: "issue-26-capture", maxRounds: 5, planning: "not_required",
    openingPrompt: "start", investigationCapture: true,
    roles: { author: { key: "opencode", tool: "opencode" }, reviewer: { key: "opencode", tool: "opencode" } },
  })
  const lane = state.entries[0]
  assert.equal(lane.authorEvidence.nativeSessionId, "ses_1")
  assert.equal(lane.reviewerEvidence.nativeSessionId, "ses_2")
  assert.notEqual(lane.authorEvidence.serverPort, lane.reviewerEvidence.serverPort)
  assert.equal(aoe.attachedCommand, "opencode attach http://127.0.0.1:4001 --session ses_1")
  assert.equal(aoe.reviewerCommand, "opencode attach http://127.0.0.1:4002 --session ses_2")
  assert.deepEqual(runtime.created.map(({ worktreePath }) => worktreePath), [lane.worktreePath, lane.worktreePath])
})

test("directly binds an OpenCode author to its native session in the new worktree", async (t) => {
  const captureHome = await mkdtemp(join(tmpdir(), "tars-capture-home-"))
  t.after(() => rm(captureHome, { recursive: true, force: true }))
  const aoe = new FakeAoe()
  const state = new FakeState()
  const captureRuntime = new FakeCaptureRuntime()
  await startLane({
    aoe, state, captureRuntime, captureHome, repoPath: "/repo", issue: { number: 22, title: "Capture" },
    branch: "issue/22-capture", worktreeName: "issue-22-capture", maxRounds: 5,
    planning: "required", openingPrompt: "start", investigationCapture: true,
    authorModel: "author/model", planModel: "plan/model",
  })
  assert.equal(aoe.authorOptions.start, false)
  assert.equal(aoe.attachedCommand, "opencode attach http://127.0.0.1:4001 --session ses_1")
  assert.equal(state.entries[0].authorEvidence.nativeSessionId, "ses_1")
  assert.equal(state.entries[0].authorEvidence.initialAgent, "tars-plan")
  assert.equal(captureRuntime.created[0].worktreePath, aoe.worktreePath ?? "/repo--issue-44-add-calendar-export")
  assert.equal(JSON.parse(captureRuntime.started[0].config).agent.build.model, "author/model")
  assert.equal(JSON.parse(captureRuntime.started[0].config).agent["tars-plan"].model, "plan/model")
})

test("directly binds an OpenCode reviewer while preserving Codex author tracing", async (t) => {
  const captureHome = await mkdtemp(join(tmpdir(), "tars-capture-home-"))
  t.after(() => rm(captureHome, { recursive: true, force: true }))
  const aoe = new FakeAoe()
  const state = new FakeState()
  const captureRuntime = new FakeCaptureRuntime()
  await startLane({
    aoe, state, captureRuntime, captureHome, repoPath: "/repo", issue: { number: 23, title: "Capture" },
    branch: "issue/23-capture", worktreeName: "issue-23-capture", maxRounds: 5,
    planning: "not_required", openingPrompt: "start", investigationCapture: true,
    roles: { author: { key: "codex", tool: "codex" }, reviewer: { key: "opencode", tool: "opencode" } },
    reviewerModel: "review/model",
  })
  assert.match(aoe.command, /CODEX_ROLLOUT_TRACE_ROOT/)
  assert.equal(aoe.reviewerCommand, "opencode attach http://127.0.0.1:4001 --session ses_1")
  assert.equal(state.entries[0].reviewerEvidence.nativeSessionId, "ses_1")
  assert.equal(JSON.parse(captureRuntime.started[0].config).model, "review/model")
})

test("OpenCode capture config preserves existing settings and sets role models", () => {
  const prior = process.env.OPENCODE_CONFIG_CONTENT
  process.env.OPENCODE_CONFIG_CONTENT = JSON.stringify({ permission: { bash: "deny" }, agent: { build: { temperature: 0 } } })
  try {
    const config = JSON.parse(openCodeServerConfig({ model: "plan/model", agent: "tars-plan", buildModel: "build/model" }))
    assert.deepEqual(config.permission, { bash: "deny" })
    assert.deepEqual(config.agent.build, { temperature: 0, model: "build/model" })
    assert.equal(config.default_agent, "tars-plan")
  } finally {
    if (prior === undefined) delete process.env.OPENCODE_CONFIG_CONTENT
    else process.env.OPENCODE_CONFIG_CONTENT = prior
  }
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

test("starts a Codex planning lane without OpenCode-only agent flags", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const roles = {
    author: { key: "codex", tool: "codex", launchArgs: ["--approve-for-me"] },
    reviewer: { key: "codex", tool: "codex", launchArgs: ["--approve-for-me"] },
  }
  await startLane({
    aoe, state, roles, repoPath: "/repo", issue: { number: 66, title: "Plan review" },
    branch: "issue/66-plan-review", worktreeName: "issue-66-plan-review", maxRounds: 5,
    planning: "required", openingPrompt: "plan",
  })

  assert.deepEqual(aoe.extraArgs, ["--approve-for-me"])
  assert.deepEqual(aoe.reviewerExtraArgs, ["--approve-for-me"])
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

test("passes resolved author and reviewer models to AoE and persists them", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  await startLane({
    aoe, state, repoPath: "/repo", issue: { number: 10, title: "Models" },
    branch: "issue/10-models", worktreeName: "issue-10-models", maxRounds: 5,
    planning: "not_required", authorModel: "gpt-5.6-terra", reviewerModel: "gpt-5.6-astra", openingPrompt: "build",
  })
  assert.deepEqual(aoe.extraArgs, ["--model", "gpt-5.6-terra"])
  assert.deepEqual(aoe.reviewerExtraArgs, ["--model", "gpt-5.6-astra"])
  assert.equal(state.entries[0].authorModel, "gpt-5.6-terra")
  assert.equal(state.entries[0].reviewerModel, "gpt-5.6-astra")
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
    ["codex-44", { purge: true }],
    ["open-44", { deleteWorktree: true, deleteBranch: true, force: false, purge: true }],
  ])
  assert.equal(state.lane(worktreePath), null)
})

test("closes a capture lane when AoE retains its custom-command worktree", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tars-capture-close-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, "repo")
  const worktreePath = join(root, "worktree")
  const git = (...args) => execFileAsync("git", args)
  await mkdir(repo)
  await git("init", "-q", repo)
  await writeFile(join(repo, "README.md"), "fixture\n")
  await git("-C", repo, "add", ".")
  await git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init")
  await git("-C", repo, "worktree", "add", "-qb", "codex/capture-test", worktreePath)
  await git("-C", repo, "worktree", "lock", "--reason", "aoe-managed worktree", worktreePath)
  const aoe = new FakeAoe()
  aoe.sessions = [{ id: "author", path: worktreePath, tool: "opencode" }, { id: "reviewer", path: worktreePath, tool: "codex" }]
  const state = new FakeState()
  state.saveLane({
    worktreePath, authorSessionId: "author", reviewerSessionId: "reviewer",
    authorTool: "opencode", reviewerTool: "codex", authorHarness: "opencode",
    investigationCapture: "capture", state: "approved",
  })
  await closeLane({ aoe, state, worktreePath })
  await assert.rejects(() => readFile(join(worktreePath, "README.md")), { code: "ENOENT" })
  const branches = (await git("-C", repo, "branch", "--list", "codex/capture-test")).stdout
  assert.equal(branches.trim(), "")
  assert.equal(state.lane(worktreePath), null)
})

test("refuses to close a dirty capture worktree without force and retains lane evidence", async (t) => {
  const root = await mkdtemp(join(tmpdir(), "tars-capture-dirty-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, "repo")
  const worktreePath = join(root, "worktree")
  const git = (...args) => execFileAsync("git", args)
  await mkdir(repo)
  await git("init", "-q", repo)
  await writeFile(join(repo, "README.md"), "fixture\n")
  await git("-C", repo, "add", ".")
  await git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init")
  await git("-C", repo, "worktree", "add", "-qb", "codex/capture-dirty", worktreePath)
  await git("-C", repo, "worktree", "lock", "--reason", "aoe-managed worktree", worktreePath)
  await writeFile(join(worktreePath, "README.md"), "dirty\n")
  const aoe = new FakeAoe()
  aoe.sessions = [{ id: "author", path: worktreePath, tool: "opencode" }, { id: "reviewer", path: worktreePath, tool: "codex" }]
  const state = new FakeState()
  const evidence = { status: "available", harness: "opencode", nativeSessionId: "ses_existing", serverPort: 4188, serverPid: 700 }
  state.saveLane({
    worktreePath, authorSessionId: "author", reviewerSessionId: "reviewer",
    authorTool: "opencode", reviewerTool: "codex", authorHarness: "opencode",
    investigationCapture: "capture", authorEvidence: evidence, state: "approved",
  })
  await assert.rejects(closeLane({ aoe, state, worktreePath }), /modified|untracked|force/i)
  assert.equal(await readFile(join(worktreePath, "README.md"), "utf8"), "dirty\n")
  assert.match((await git("-C", repo, "branch", "--list", "codex/capture-dirty")).stdout, /codex\/capture-dirty/)
  assert.equal(state.lane(worktreePath).authorEvidence.nativeSessionId, "ses_existing")
  assert.deepEqual(aoe.removed, [])
  assert.deepEqual(aoe.deletedGroups, [])
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
    ["codex-44", { purge: true }],
    ["open-44", { deleteWorktree: true, deleteBranch: true, force: false, purge: true }],
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
    ["codex-44", { purge: true }],
    ["open-44", { deleteWorktree: true, deleteBranch: true, force: true, purge: true }],
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

test("recovers a stopped capture OpenCode session with its recorded native ID", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const worktreePath = "/repo-worktrees/issue-44-add-calendar-export"
  const evidence = { status: "available", harness: "opencode", nativeSessionId: "ses_existing", serverPort: 4188, serverPid: 700, initialAgent: "build" }
  state.saveLane({
    worktreePath, authorSessionId: "open-44", reviewerSessionId: "codex-44",
    authorTool: "opencode", reviewerTool: "codex", authorHarness: "opencode",
    investigationCapture: "capture", authorEvidence: evidence, state: "watching", maxRounds: 5,
  })
  aoe.sessions = [{ id: "open-44", path: worktreePath, tool: "opencode" }, { id: "codex-44", path: worktreePath, tool: "codex" }]
  aoe.runtime = [{ session: "open-44", state: "dead" }]
  const captureRuntime = new FakeCaptureRuntime()
  let checks = 0
  captureRuntime.hasSession = async () => ++checks > 1
  const result = await recoverLane({ aoe, state, worktreePath, role: "author", captureRuntime })
  assert.equal(result.started, true)
  assert.equal(state.entries.at(-1).authorEvidence.nativeSessionId, "ses_existing")
  assert.equal(state.entries.at(-1).authorEvidence.serverPort, 4188)
  assert.equal(captureRuntime.started[0].port, 4188)
  assert.deepEqual(aoe.started, ["open-44"])
})

test("refuses capture recovery when the recorded native ID cannot be restored", async () => {
  const aoe = new FakeAoe()
  const state = new FakeState()
  const worktreePath = "/repo-worktrees/issue-44-add-calendar-export"
  const evidence = { status: "available", harness: "opencode", nativeSessionId: "ses_existing", serverPort: 4188, serverPid: 700 }
  state.saveLane({
    worktreePath, authorSessionId: "open-44", reviewerSessionId: "codex-44",
    authorTool: "opencode", reviewerTool: "codex", authorHarness: "opencode",
    investigationCapture: "capture", authorEvidence: evidence, state: "watching", maxRounds: 5,
  })
  aoe.sessions = [{ id: "open-44", path: worktreePath, tool: "opencode" }, { id: "codex-44", path: worktreePath, tool: "codex" }]
  aoe.runtime = [{ session: "open-44", state: "dead" }]
  const runtime = new FakeCaptureRuntime()
  runtime.hasSession = async () => false
  await assert.rejects(recoverLane({ aoe, state, worktreePath, role: "author", captureRuntime: runtime }), /unavailable after restarting/)
  assert.deepEqual(aoe.started, [])
  assert.equal(state.lane(worktreePath).authorEvidence.nativeSessionId, "ses_existing")
  assert.deepEqual(runtime.stopped, [6001])
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

async function captureGitFixture(t, branch) {
  const root = await mkdtemp(join(tmpdir(), "tars-capture-failure-"))
  t.after(() => rm(root, { recursive: true, force: true }))
  const repo = join(root, "repo")
  const worktreePath = join(root, "worktree")
  const git = (...args) => execFileAsync("git", args)
  await mkdir(repo)
  await git("init", "-q", repo)
  await writeFile(join(repo, "README.md"), "fixture\n")
  await git("-C", repo, "add", ".")
  await git("-C", repo, "-c", "user.name=Test", "-c", "user.email=test@example.invalid", "commit", "-qm", "init")
  await git("-C", repo, "worktree", "add", "-qb", branch, worktreePath)
  await git("-C", repo, "worktree", "lock", "--reason", "aoe-managed worktree", worktreePath)
  return { repo, worktreePath, branch }
}

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

  async findOrCreateWorktreeSession(repoPath, branch, title, options = {}) {
    const { extraArgs = [], group, command } = options
    this.added.push([repoPath, branch])
    this.titles.push(title)
    this.extraArgs = extraArgs
    this.groups.push(group)
    this.command = command
    this.authorOptions = options
    return { id: "open-44", path: this.worktreePath ?? "/repo--issue-44-add-calendar-export" }
  }

  async addSession(path, tool, title, options = {}) {
    const { extraArgs = [], group, command } = options
    if (this.addError) {
      if (this.addsBeforeFailure) this.sessions.push({ id: "failed-reviewer", path, tool })
      throw this.addError
    }
    this.added.push([path, tool])
    this.reviewerExtraArgs = extraArgs
    this.reviewerOptions = { extraArgs, group }
    this.reviewerCommand = command
    return { id: "codex-44", path }
  }

  async attachWorktreeSession(_repo, _branch, _title, command) {
    this.attachedCommand = command
    if (this.attachError) throw this.attachError
    const path = this.worktreePath ?? "/repo--issue-44-add-calendar-export"
    this.sessions.push({ id: "open-attached", path, tool: "opencode" })
    return { id: "open-attached", path }
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

class FakeCaptureRuntime {
  constructor() {
    this.created = []
    this.started = []
    this.stopped = []
  }
  async availablePort() { return 4001 + this.started.length }
  async startServer(options) {
    this.started.push(options)
    return 6001 + this.started.length - 1
  }
  async createSession(options) {
    this.created.push(options)
    return { id: `ses_${this.created.length}`, directory: options.worktreePath }
  }
  async stopServer(pid) { this.stopped.push(pid) }
}
