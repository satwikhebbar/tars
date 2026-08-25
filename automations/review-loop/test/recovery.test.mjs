import assert from "node:assert/strict"
import { mkdir, mkdtemp, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { analyzeLane, formatAnalysis, resumeLane } from "../lib/recovery.mjs"
import { StateStore } from "../lib/state.mjs"

test("an approved lane with no reopen event needs no action", async () => {
  const fixture = await laneFixture({ state: "approved" })
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "no_action")
  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, dispatch: true }),
    /Refusing --dispatch: verdict is no_action/,
  )
  fixture.state.close()
})

test("a blocked lane stays blocked and cannot be dispatched", async () => {
  const fixture = await laneFixture({ state: "blocked" })
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "blocked")
  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, dispatch: true }),
    /Refusing --dispatch: verdict is blocked/,
  )
  fixture.state.close()
})

test("an undispatched event over max_rounds blocks the lane", async () => {
  const fixture = await laneFixture({ maxRounds: 1 })
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response.md",
    `id: fix-r2-response\ntype: implementation-response\nworkflow_id: fix\nround: 2\nhead_commit: abc123`,
  )
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "blocked")
  assert.match(analysis.reasons[0], /max_rounds 1/)
  fixture.state.close()
})

test("resume without flags is read-only", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  const before = fixture.state.lane(fixture.worktree)
  const result = await resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(result.analysis.verdict, "needs_dispatch")
  assert.equal(result.action, null)
  assert.equal(fixture.aoe.sent.length, 0)
  assert.equal(fixture.aoe.addedSessions.length, 0)
  assert.equal(fixture.state.dispatchedEvents(fixture.worktree).size, 0)
  assert.deepEqual(fixture.state.lane(fixture.worktree), before)
  fixture.state.close()
})

test("a single pending event with an idle target reports needs_dispatch and dispatches once", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "done/response.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "needs_dispatch")
  assert.equal(analysis.nextTarget, "codex-1")
  assert.match(formatAnalysis(analysis), /Verdict: {2}needs_dispatch/)

  const result = await resumeLane({
    aoe: fixture.aoe,
    state: fixture.state,
    worktreePath: fixture.worktree,
    dispatch: true,
  })
  assert.equal(result.action.action, "sent:codex")
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["codex-1"],
  )
  assert.equal(fixture.state.lane(fixture.worktree).state, "reviewing")

  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, dispatch: true }),
    /Refusing --dispatch: verdict is in_flight/,
  )
  fixture.state.close()
})

test("multiple pending events are ambiguous and refuse to dispatch", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "done/response-1.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response-2.md",
    `id: fix-r2-response\ntype: implementation-response\nworkflow_id: fix\nround: 2\nhead_commit: def456`,
  )
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "ambiguous")
  assert.equal(analysis.pending.length, 2)
  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, dispatch: true }),
    /Refusing --dispatch: verdict is ambiguous/,
  )
  fixture.state.close()
})

test("an old recorded delivery with no advancement and an idle session is stale and can be re-dispatched", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  fixture.state.markDispatched(fixture.worktree, "implementation:fix-r1-response:abc123")
  ageDispatch(fixture, "implementation:fix-r1-response:abc123")

  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "stale_delivery")

  const result = await resumeLane({
    aoe: fixture.aoe,
    state: fixture.state,
    worktreePath: fixture.worktree,
    dispatch: true,
  })
  assert.equal(result.action.action, "sent:codex")
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["codex-1"],
  )
  assert.equal(fixture.state.dispatchedEvents(fixture.worktree).size, 1)
  fixture.state.close()
})

test("a recent or busy recorded delivery is in flight and refuses to re-dispatch", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  fixture.state.markDispatched(fixture.worktree, "implementation:fix-r1-response:abc123")

  const recent = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(recent.verdict, "in_flight")

  fixture.aoe.runtime[1].state = "running"
  const busy = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(busy.verdict, "in_flight")
  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, dispatch: true }),
    /Refusing --dispatch: verdict is in_flight/,
  )
  fixture.state.close()
})

test("a missing registered session reports sessions_missing and --create-sessions re-registers it", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  fixture.aoe.sessions = fixture.aoe.sessions.filter((session) => session.id !== "codex-1")
  fixture.aoe.runtime = fixture.aoe.runtime.filter((entry) => entry.session !== "codex-1")

  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "sessions_missing")

  const result = await resumeLane({
    aoe: fixture.aoe,
    state: fixture.state,
    worktreePath: fixture.worktree,
    createSessions: true,
    dispatch: true,
  })
  assert.equal(fixture.aoe.addedSessions[0].tool, "codex")
  assert.equal(fixture.state.lane(fixture.worktree).codexSessionId, "codex-new-1")
  assert.equal(result.action.action, "sent:codex")
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["codex-new-1"],
  )
  fixture.state.close()
})

test("a session id reused by another worktree reports sessions_missing and is replaced only by --create-sessions", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  fixture.aoe.sessions.find((session) => session.id === "codex-1").path = "/other/worktree"

  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "sessions_missing")
  assert.match(analysis.reasons[0], /reused by another worktree or tool/)
  assert.equal(fixture.aoe.sent.length, 0)

  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, dispatch: true }),
    /Refusing --dispatch: verdict is sessions_missing/,
  )
  assert.equal(fixture.aoe.sent.length, 0)

  const result = await resumeLane({
    aoe: fixture.aoe,
    state: fixture.state,
    worktreePath: fixture.worktree,
    createSessions: true,
    dispatch: true,
  })
  const codexSession = fixture.aoe.sessions.find((session) => session.id === "codex-new-1")
  assert.equal(codexSession.tool, "codex")
  assert.equal(codexSession.path, fixture.worktree)
  assert.equal(fixture.state.lane(fixture.worktree).codexSessionId, "codex-new-1")
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["codex-new-1"],
  )
  assert.equal(result.action.action, "sent:codex")
  fixture.state.close()
})

test("a session id reused by the wrong tool reports sessions_missing and never dispatches to it", async () => {
  const fixture = await laneFixture()
  await writeWorkflowHandoff(
    fixture.worktree,
    "inbox/response.md",
    `id: fix-r1-response\ntype: implementation-response\nworkflow_id: fix\nround: 1\nhead_commit: abc123`,
  )
  fixture.aoe.sessions.find((session) => session.id === "codex-1").tool = "opencode"

  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "sessions_missing")
  assert.match(analysis.reasons[0], /reused by another worktree or tool/)
  assert.equal(fixture.aoe.sent.length, 0)

  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, dispatch: true }),
    /Refusing --dispatch: verdict is sessions_missing/,
  )
  assert.equal(fixture.aoe.sent.length, 0)

  const result = await resumeLane({
    aoe: fixture.aoe,
    state: fixture.state,
    worktreePath: fixture.worktree,
    createSessions: true,
    dispatch: true,
  })
  assert.equal(fixture.state.lane(fixture.worktree).codexSessionId, "codex-new-1")
  assert.deepEqual(
    fixture.aoe.sent.map((entry) => entry.sessionId),
    ["codex-new-1"],
  )
  assert.equal(result.action.action, "sent:codex")
  fixture.state.close()
})

test("--create-sessions refuses when the verdict is not sessions_missing", async () => {
  const fixture = await laneFixture()
  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, createSessions: true }),
    /Refusing --create-sessions: verdict is no_action/,
  )
  fixture.state.close()
})

test("a dead session reports inactive_sessions and never dispatches", async () => {
  const fixture = await laneFixture()
  fixture.aoe.runtime[1].state = "dead"
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "inactive_sessions")
  await assert.rejects(
    resumeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree, dispatch: true }),
    /Refusing --dispatch: verdict is inactive_sessions/,
  )
  fixture.state.close()
})

test("a fresh registered lane with no handoffs is healthy and awaiting the agent", async () => {
  const fixture = await laneFixture()
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "no_action")
  assert.match(formatAnalysis(analysis), /Worktree: /)
  fixture.state.close()
})

test("a compacting lane is in flight while the plan-to-build transition runs", async () => {
  const fixture = await laneFixture({ state: "implementing", phase: "compacting" })
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "in_flight")
  fixture.state.close()
})

test("lane state with no matching handoff evidence is reported as ambiguous", async () => {
  const fixture = await laneFixture({ state: "reviewing", phase: "post_pr_feedback" })
  const analysis = await analyzeLane({ aoe: fixture.aoe, state: fixture.state, worktreePath: fixture.worktree })
  assert.equal(analysis.verdict, "ambiguous")
  assert.match(analysis.reasons[0], /lane state reviewing but no handoff or session activity evidence/)
  fixture.state.close()
})

async function laneFixture({
  state = "watching",
  phase = "building",
  planning = "not_required",
  maxRounds = 5,
  iterationCount = 1,
  currentIteration = 1,
} = {}) {
  const worktree = await mkdtemp(join(tmpdir(), "agent-review-loop-resume-"))
  await Promise.all([
    mkdir(join(worktree, ".agent-handoff", "inbox"), { recursive: true }),
    mkdir(join(worktree, ".agent-handoff", "done"), { recursive: true }),
  ])
  const store = new StateStore(join(worktree, "state.sqlite"))
  await store.open()
  store.saveLane({
    worktreePath: worktree,
    opencodeSessionId: "opencode-1",
    codexSessionId: "codex-1",
    state,
    maxRounds,
    planning,
    phase,
    iterationCount,
    currentIteration,
  })
  const aoe = new FakeAoe()
  aoe.sessions = [
    { id: "opencode-1", path: worktree, tool: "opencode" },
    { id: "codex-1", path: worktree, tool: "codex" },
  ]
  aoe.runtime = [
    { session: "opencode-1", substrate: "tmux", state: "idle" },
    { session: "codex-1", substrate: "tmux", state: "idle" },
  ]
  return { worktree, state: store, aoe }
}

function ageDispatch(fixture, eventKey) {
  fixture.state.database
    .prepare("UPDATE dispatched_events SET created_at = ? WHERE worktree_path = ? AND event_key = ?")
    .run(new Date(Date.now() - 11 * 60 * 1000).toISOString(), fixture.worktree, eventKey)
}

async function writeWorkflowHandoff(worktree, relativePath, frontmatter) {
  await writeFile(join(worktree, ".agent-handoff", relativePath), `---\n${frontmatter}\n---\n`, "utf8")
}

class FakeAoe {
  constructor() {
    this.sent = []
    this.sessions = []
    this.runtime = []
    this.addedSessions = []
  }

  async listSessions() {
    return this.sessions
  }

  async runtimeSessions({ includeDead = false } = {}) {
    if (includeDead) return this.runtime
    return this.runtime.filter((entry) => entry.state !== "dead")
  }

  async runningSessions() {
    return this.runtime.map(({ session, state }) => ({ session, state }))
  }

  async send(sessionId, message) {
    this.sent.push({ sessionId, message })
  }

  async addSession(worktreePath, tool, title) {
    const id = `${tool}-new-${this.addedSessions.length + 1}`
    this.addedSessions.push({ id, path: worktreePath, tool, title })
    this.sessions.push({ id, path: worktreePath, tool })
    this.runtime.push({ session: id, substrate: "tmux", state: "waiting" })
    return { id, path: worktreePath, tool, title }
  }
}
