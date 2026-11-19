import assert from "node:assert/strict"
import { mkdtemp, rm } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { withIssueLane, issueKey } from "../lib/issue-lanes.mjs"
import { StateStore } from "../lib/state.mjs"

const issue = { number: 99, url: "https://github.com/owner/repo/issues/99" }
const lane = (worktreePath = "/worktrees/custom-name", state = "implementing") => ({ worktreePath, authorSessionId: "author", reviewerSessionId: "reviewer", state, maxRounds: 5 })

async function fixture(t) {
  const directory = await mkdtemp(join(tmpdir(), "tars-issue-lanes-"))
  const state = new StateStore(join(directory, "state.sqlite"))
  await state.open()
  t.after(async () => { state.close(); await rm(directory, { recursive: true, force: true }) })
  return state
}

test("registered issue identity survives reopening the state store and custom lane names", async (t) => {
  const state = await fixture(t)
  const existing = lane()
  state.saveLane(existing)
  state.bindLaneIssue(existing.worktreePath, issueKey(issue.url))
  state.close()
  await state.open()
  for (const status of ["implementing", "blocked", "approved"]) {
    state.saveLane({ ...existing, state: status })
    await assert.rejects(withIssueLane({ state, issue, run: () => assert.fail("must not start") }), /already owns.*custom-name/)
  }
})

test("allows the same issue number in another repository and after retirement", async (t) => {
  const state = await fixture(t)
  const existing = lane()
  state.saveLane(existing)
  state.bindLaneIssue(existing.worktreePath, "https://github.com/owner/other/issues/99")
  assert.equal(await withIssueLane({ state, issue, run: async () => "started" }), "started")
  state.bindLaneIssue(existing.worktreePath, issueKey(issue.url))
  state.deleteLane(existing.worktreePath)
  assert.equal(state.laneIssue(existing.worktreePath), undefined)
  assert.equal(await withIssueLane({ state, issue, run: async () => "started" }), "started")
})

test("recognizes old issue-named lanes using SSH and HTTPS remotes and saves the identity", async (t) => {
  for (const remote of ["git@github.com:Owner/Repo.git", "https://github.com/owner/repo.git", "ssh://git@github.com/owner/repo.git"]) {
    const state = await fixture(t)
    const existing = lane("/worktrees/issue-99-old-summary")
    state.saveLane(existing)
    await assert.rejects(withIssueLane({ state, issue, exec: async () => ({ stdout: remote + "\n" }), run: () => assert.fail("must not start") }), /already owns/)
    assert.equal(state.laneIssue(existing.worktreePath), issueKey(issue.url))
  }
})

test("does not confuse legacy lanes in other repositories or with other issue numbers", async (t) => {
  const state = await fixture(t)
  state.saveLane(lane("/worktrees/issue-99-other-repo"))
  state.saveLane(lane("/worktrees/issue-199-other-issue"))
  let lookups = 0
  assert.equal(await withIssueLane({ state, issue, exec: async () => { lookups++; return { stdout: "git@github.com:owner/other.git" } }, run: () => "started" }), "started")
  assert.equal(lookups, 1)
})

test("serializes concurrent kickoffs and releases the claim after success or failure", async (t) => {
  const state = await fixture(t)
  let finish
  const first = withIssueLane({ state, issue, run: () => new Promise((resolve) => { finish = resolve }) })
  await assert.rejects(withIssueLane({ state, issue, run: () => assert.fail("must not start") }), /already in progress/)
  finish()
  await first
  await assert.rejects(withIssueLane({ state, issue, run: () => { throw new Error("launch failed") } }), /launch failed/)
  assert.equal(await withIssueLane({ state, issue, run: () => "retry" }), "retry")
})
