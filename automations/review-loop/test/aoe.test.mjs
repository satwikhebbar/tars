import assert from "node:assert/strict"
import test from "node:test"
import { createPair, discoverPair, validatePair, waitForSessionReady } from "../lib/aoe.mjs"

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
  assert.equal(client.added[0].tool, "opencode")
  assert.equal(client.added[0].group, WORKTREE)
  assert.equal(client.added[1].tool, "codex")
  assert.equal(client.added[1].group, WORKTREE)
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

  async addSession(path, tool, title, { group } = {}) {
    this.added.push({ path, tool, title, group })
    this.sessionList.push({ id: tool === "opencode" ? "new-open" : "new-codex", path, tool })
  }
}
