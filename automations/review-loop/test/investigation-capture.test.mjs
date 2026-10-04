import assert from "node:assert/strict"
import test from "node:test"
import { createOpenCodeEvidence, ensureOpenCodeServer, openCodeAttachCommand, stopOpenCodeServer } from "../lib/investigation-capture.mjs"

test("creates one directly attributed native session and an exact attach command", async () => {
  const runtime = new FakeRuntime()
  const evidence = await createOpenCodeEvidence({
    worktreePath: "/repo-worktrees/issue-1", role: "author", model: "provider/model",
    agent: "tars-plan", buildModel: "provider/build", runtime,
  })
  assert.equal(evidence.nativeSessionId, "ses_native1")
  assert.equal(evidence.serverPort, 4188)
  assert.equal(evidence.initialAgent, "tars-plan")
  assert.equal(openCodeAttachCommand(evidence), "opencode attach http://127.0.0.1:4188 --session ses_native1")
  assert.deepEqual(runtime.sessions[0], { port: 4188, worktreePath: "/repo-worktrees/issue-1", title: "TARS author" })
  assert.equal(JSON.parse(runtime.servers[0].config).model, "provider/model")
})

test("rejects a native session created in the wrong worktree and stops its server", async () => {
  const runtime = new FakeRuntime()
  runtime.directory = "/another-worktree"
  await assert.rejects(
    createOpenCodeEvidence({ worktreePath: "/repo-worktrees/issue-1", role: "reviewer", runtime }),
    /outside the lane worktree/,
  )
  assert.deepEqual(runtime.stopped, [901])
})

test("stops the server when native session creation fails", async () => {
  const runtime = new FakeRuntime()
  runtime.createSession = async () => { throw new Error("native creation failed") }
  await assert.rejects(
    createOpenCodeEvidence({ worktreePath: "/repo-worktrees/issue-1", role: "author", runtime }),
    /native creation failed/,
  )
  assert.deepEqual(runtime.stopped, [901])
})

test("restarts a missing OpenCode server on its recorded port and retains the ID", async () => {
  const runtime = new FakeRuntime()
  const evidence = await createOpenCodeEvidence({ worktreePath: "/repo-worktrees/issue-1", role: "author", runtime })
  runtime.available = false
  const restarted = await ensureOpenCodeServer({ evidence, worktreePath: "/repo-worktrees/issue-1", runtime })
  assert.equal(restarted.nativeSessionId, evidence.nativeSessionId)
  assert.equal(restarted.serverPort, evidence.serverPort)
  assert.equal(restarted.serverPid, 902)
  assert.equal(runtime.servers[1].port, evidence.serverPort)
  await stopOpenCodeServer(restarted, runtime)
  assert.deepEqual(runtime.stopped, [902])
})

test("stops a restarted server if the recorded native session remains unavailable", async () => {
  const runtime = new FakeRuntime()
  const evidence = await createOpenCodeEvidence({ worktreePath: "/repo-worktrees/issue-1", role: "author", runtime })
  runtime.hasSession = async () => false
  await assert.rejects(
    ensureOpenCodeServer({ evidence, worktreePath: "/repo-worktrees/issue-1", runtime }),
    /unavailable after restarting/,
  )
  assert.equal(evidence.nativeSessionId, "ses_native1")
  assert.equal(runtime.servers[1].port, 4188)
  assert.deepEqual(runtime.stopped, [902])
})

class FakeRuntime {
  constructor() {
    this.servers = []
    this.sessions = []
    this.stopped = []
    this.available = true
    this.directory = null
  }
  async availablePort() { return 4188 }
  async startServer(options) {
    this.servers.push(options)
    this.available = true
    return 900 + this.servers.length
  }
  async createSession(options) {
    this.sessions.push(options)
    return { id: "ses_native1", directory: this.directory ?? options.worktreePath }
  }
  async hasSession() { return this.available }
  async stopServer(pid) { this.stopped.push(pid) }
}
