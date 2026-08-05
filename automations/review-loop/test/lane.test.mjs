import assert from "node:assert/strict"
import test from "node:test"
import { issueOpeningPrompt, startLane } from "../lib/lane.mjs"

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

class FakeAoe {
  constructor() {
    this.added = []
    this.sent = []
    this.titles = []
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
}

class FakeState {
  constructor() {
    this.lanes = []
  }

  saveLane(lane) {
    this.lanes.push(lane)
  }
}
