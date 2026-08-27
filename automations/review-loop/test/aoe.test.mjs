import assert from "node:assert/strict"
import test from "node:test"
import { createPair, discoverPair, findActiveWorktreeSession, groupForWorktree, parseTrashedSessionIds, validatePair, waitForSessionReady } from "../lib/aoe.mjs"

const WORKTREE = "/tmp/kipp-review"

test("discovers exactly one pair from the requested worktree", async () => {
  const pair = await discoverPair(new ListAoe(sessions()), WORKTREE)
  assert.deepEqual(pair, { opencodeSessionId: "open-1", codexSessionId: "codex-1" })
})

test("explicit pair registration rejects a session from another worktree", async () => {
  const client = new ListAoe([...sessions(), { id: "codex-other", path: "/tmp/other", tool: "codex" }])
  await assert.rejects(
    () => validatePair(client, WORKTREE, { opencodeSessionId: "open-1", codexSessionId: "codex-other" }),
    /not a Codex session/,
  )
})

test("creates a pair only when discovery finds none", async () => {
  const client = new CreateAoe()
  const pair = await createPair(client, WORKTREE)
  assert.deepEqual(pair, { opencodeSessionId: "new-open", codexSessionId: "new-codex" })
  assert.equal(client.added.length, 2)
  assert.deepEqual(client.added.map((entry) => entry.options), [
    { extraArgs: [], group: groupForWorktree(WORKTREE) },
    { extraArgs: [], group: groupForWorktree(WORKTREE) },
  ])
})

test("derives a stable TARS group from a worktree path", () => {
  const first = groupForWorktree("/repo-worktrees/issue-44-add-calendar-export")
  assert.match(first, /^TARS\/issue-44-add-calendar-export-[0-9a-f]{10}$/)
  assert.equal(groupForWorktree("/repo-worktrees/issue-44-add-calendar-export/"), first)
  assert.notEqual(first, groupForWorktree("/other-worktrees/issue-44-add-calendar-export"))
  assert.match(groupForWorktree("/"), /^TARS\/worktree-[0-9a-f]{10}$/)
})

test("requires explicit bindings when author and reviewer use the same harness", async () => {
  const roles = { author: { tool: "claude", displayName: "Claude" }, reviewer: { tool: "claude", displayName: "Claude" } }
  const client = new ListAoe([{ id: "author", path: WORKTREE, tool: "claude" }, { id: "reviewer", path: WORKTREE, tool: "claude" }])
  await assert.rejects(() => discoverPair(client, WORKTREE, roles), /supply explicit --author-session/)
  assert.deepEqual(await validatePair(client, WORKTREE, { authorSessionId: "author", reviewerSessionId: "reviewer" }, roles), { authorSessionId: "author", reviewerSessionId: "reviewer" })
})

test("waits for visible terminal content before treating a new session as ready", async () => {
  const captures = [{ content: "" }, { content: "OpenCode is ready" }]
  const waits = []
  await waitForSessionReady({ captureSession: async () => captures.shift() }, "open-1", {
    pollIntervalMs: 1,
    sleep: async (milliseconds) => waits.push(milliseconds),
  })
  assert.deepEqual(waits, [1, 500])
})

test("does not reuse a trashed worktree session", () => {
  const session = findActiveWorktreeSession([
    { id: "trashed", tool: "codex", path: "/repo-worktrees/.aoe-trash/trashed", worktree: { branch: "issue/3", main_repo_path: "/repo/" } },
    { id: "live", tool: "codex", path: "/repo-worktrees/issue-3", worktree: { branch: "issue/3", main_repo_path: "/repo/" } },
  ], "/repo", "issue/3", "codex")
  assert.equal(session.id, "live")
  assert.equal(findActiveWorktreeSession([
    { id: "trashed", tool: "codex", path: "/repo-worktrees/.aoe-trash/trashed", worktree: { branch: "issue/3", main_repo_path: "/repo/" } },
  ], "/repo", "issue/3", "codex"), undefined)
})

test("parses only AoE trash session IDs", () => {
  const ids = parseTrashedSessionIds("Trashed sessions:\n  e874feb8d3c44b59  Issue 1 author\n  f8acc4ad5e1f4902  Issue 1 reviewer\n")
  assert.deepEqual([...ids], ["e874feb8d3c44b59", "f8acc4ad5e1f4902"])
})

function sessions() {
  return [
    { id: "open-1", path: WORKTREE, tool: "opencode" },
    { id: "codex-1", path: WORKTREE, tool: "codex" },
    { id: "open-other", path: "/tmp/other", tool: "opencode" },
  ]
}

class ListAoe {
  constructor(sessionList) {
    this.sessionList = sessionList
  }

  async listSessions() {
    return this.sessionList
  }
}

class CreateAoe extends ListAoe {
  constructor() {
    super([])
    this.added = []
  }

  async addSession(path, tool, title, options) {
    this.added.push({ path, tool, title, options })
    this.sessionList.push({ id: tool === "opencode" ? "new-open" : "new-codex", path, tool })
  }
}
