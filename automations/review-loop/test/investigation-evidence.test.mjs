import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, stat, writeFile } from "node:fs/promises"
import { tmpdir } from "node:os"
import { join } from "node:path"
import test from "node:test"
import { createNativeSources, inspectLaneEvidence, runToFile } from "../lib/investigation-evidence.mjs"

const path = "/repo/worktree"
const lane = {
  worktreePath: path, investigationCapture: "capture",
  authorSessionId: "author-aoe", reviewerSessionId: "reviewer-aoe",
  authorHarness: "opencode", reviewerHarness: "codex",
  authorEvidence: { status: "available", harness: "opencode", nativeSessionId: "ses_123" },
  reviewerEvidence: { status: "available", harness: "codex", traceRoot: "/traces" },
}

function fixture({ states = ["idle", "waiting"], current = lane, sources } = {}) {
  let calls = 0
  const aoe = { async runtimeSessions() {
    calls += 1
    return ["author", "reviewer"].map((role, index) => ({ session: lane[`${role}SessionId`], state: states[index] }))
  } }
  const state = { lane: () => current }
  return { state, aoe, sources: sources ?? { inspect: async ({ role }) => ({ status: "available", bytes: role === "author" ? 5 : 10 }) }, get calls() { return calls } }
}

test("checks both roles before and after collecting a transient source inventory", async () => {
  const f = fixture()
  const result = await inspectLaneEvidence({ ...f, worktreePath: path, now: () => new Date("2026-10-01T00:00:00Z") })
  assert.equal(result.asOf, "2026-10-01T00:00:00.000Z")
  assert.equal(result.roles.author.bytes, 5)
  assert.equal(result.roles.reviewer.bytes, 10)
  assert.equal(f.calls, 2)
})

test("rejects uncaptured and busy lanes before reading native sources", async () => {
  let inspections = 0
  const f = fixture({ states: ["running", "waiting"], sources: { inspect: async () => { inspections += 1 } } })
  await assert.rejects(inspectLaneEvidence({ ...f, worktreePath: path }), /author.*idle or waiting/)
  assert.equal(inspections, 0)
  await assert.rejects(inspectLaneEvidence({ ...fixture({ current: { ...lane, investigationCapture: "off" } }), worktreePath: path }), /not started with --investigate capture/)
})

test("preserves a missing role as a coverage gap and rejects changed attribution", async () => {
  const f = fixture({ sources: { inspect: async ({ role }) => {
    if (role === "reviewer") throw new Error("No Codex bundle could be reduced")
    return { status: "available", bytes: 7 }
  } } })
  const result = await inspectLaneEvidence({ ...f, worktreePath: path })
  assert.equal(result.roles.author.status, "available")
  assert.deepEqual(result.roles.reviewer, { harness: "codex", status: "unavailable", reason: "No Codex bundle could be reduced" })
  const changing = { lane: (() => { let n = 0; return () => ++n === 1 ? lane : { ...lane, reviewerSessionId: "replacement" } })() }
  await assert.rejects(inspectLaneEvidence({ ...f, state: changing, worktreePath: path }), /changed during collection/)
})

test("rejects a lane that becomes busy while native sources are collected", async () => {
  let checks = 0
  const f = fixture()
  f.aoe.runtimeSessions = async () => {
    checks += 1
    return [
      { session: lane.authorSessionId, state: checks === 1 ? "idle" : "running" },
      { session: lane.reviewerSessionId, state: "waiting" },
    ]
  }
  await assert.rejects(inspectLaneEvidence({ ...f, worktreePath: path }), /author.*idle or waiting/)
  assert.equal(checks, 2)
})

test("native collection writes to temporary files and removes them after success and failure", async () => {
  const outputs = []
  const sources = createNativeSources(async (command, args, output) => {
    outputs.push({ command, args, output })
    if (command === "opencode") await writeFile(output, '{"info":{"id":"ses_123"},"messages":[]}')
    else throw new Error("reducer failed")
  })
  const exported = await sources.inspect({ harness: "opencode", evidence: lane.authorEvidence })
  assert.equal(exported.bytes, 39)
  assert.equal(exported.messageCount, 0)
  assert.equal(outputs[0].command, "opencode")
  assert.deepEqual(outputs[0].args, ["export", "ses_123"])
  await assert.rejects(readdir(join(outputs[0].output, "..")), /ENOENT/)

  const root = await mkdtemp(join(tmpdir(), "tars-test-traces-"))
  try {
    await mkdir(join(root, "bundle-1"))
    await writeFile(join(root, "bundle-1", "manifest.json"), "{}")
    await assert.rejects(sources.inspect({ harness: "codex", evidence: { status: "available", harness: "codex", traceRoot: root } }), /No Codex bundle could be reduced/)
    assert.deepEqual(outputs[1].args.slice(0, 2), ["debug", "trace-reduce"])
    assert.equal(typeof outputs[1].output, "string", JSON.stringify(outputs[1]))
    await assert.rejects(readdir(join(outputs[1].output, "..")), /ENOENT/)
  } finally {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  }
})

test("native stdout goes directly to a regular file past the pipe boundary", async () => {
  const root = await mkdtemp(join(tmpdir(), "tars-test-export-"))
  try {
    const output = join(root, "export.json")
    await runToFile(process.execPath, ["-e", "process.stdout.write('x'.repeat(131072))"], output)
    assert.equal((await stat(output)).size, 131072)
  } finally {
    const { rm } = await import("node:fs/promises")
    await rm(root, { recursive: true, force: true })
  }
})
