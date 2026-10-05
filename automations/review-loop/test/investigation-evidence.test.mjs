import assert from "node:assert/strict"
import { mkdtemp, mkdir, readdir, rm, stat, writeFile } from "node:fs/promises"
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

test("rejects missing and dead AoE sessions before inspecting evidence", async () => {
  for (const runtime of [
    [{ session: lane.authorSessionId, state: "idle" }],
    [{ session: lane.authorSessionId, state: "idle" }, { session: lane.reviewerSessionId, state: "dead" }],
  ]) {
    let inspections = 0
    const f = fixture({ sources: { inspect: async () => { inspections += 1 } } })
    f.aoe.runtimeSessions = async () => runtime
    await assert.rejects(inspectLaneEvidence({ ...f, worktreePath: path }), /reviewer.*idle or waiting/)
    assert.equal(inspections, 0)
  }
})

test("reports a failed Codex bundle without losing a successful bundle", async () => {
  const root = await mkdtemp(join(tmpdir(), "tars-test-traces-"))
  const outputs = []
  try {
    for (const name of ["bundle-a", "bundle-b"]) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, "manifest.json"), "{}")
    }
    const sources = createNativeSources(async (_command, args, output) => {
      outputs.push(output)
      if (args[2].endsWith("bundle-b")) throw new Error("reducer failed")
      await writeFile(output, "reduced")
    })
    const result = await sources.inspect({ harness: "codex", evidence: { ...lane.reviewerEvidence, traceRoot: root } })
    assert.equal(result.status, "partial")
    assert.equal(result.bundleCount, 2)
    assert.equal(result.reducedBytes, 7)
    assert.match(result.gaps[0], /bundle-b: reducer failed/)
    assert.equal(result.gaps.length, 1)
    await assert.rejects(readdir(join(outputs[0], "..")), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("invalid OpenCode exports become a role gap without hiding reviewer evidence", async () => {
  for (const [name, payload, reason] of [
    ["empty", "", /OpenCode export was empty/],
    ["malformed", "{", /JSON/],
    ["wrong session", '{"info":{"id":"ses_other"},"messages":[]}', /does not match native session/],
    ["missing messages", '{"info":{"id":"ses_123"}}', /does not match native session/],
  ]) {
    const outputs = []
    const sources = createNativeSources(async (_command, _args, output) => {
      outputs.push(output)
      await writeFile(output, payload)
    })
    const f = fixture({ sources: { inspect: ({ role }) => role === "author"
      ? sources.inspect({ harness: "opencode", evidence: lane.authorEvidence })
      : Promise.resolve({ status: "available", reducedBytes: 9 }) } })
    const result = await inspectLaneEvidence({ ...f, worktreePath: path })
    assert.equal(result.roles.author.status, "unavailable", name)
    assert.match(result.roles.author.reason, reason, name)
    assert.equal(result.roles.reviewer.reducedBytes, 9, name)
    await assert.rejects(readdir(join(outputs[0], "..")), /ENOENT/, name)
  }
})

test("OpenCode exports at the parse limit are checked, while larger exports are partial", async () => {
  const limit = 16 * 1024 * 1024
  const base = '{"info":{"id":"ses_123"},"messages":[]}'
  for (const [size, expected] of [[limit, "available"], [limit + 1, "partial"]]) {
    let output
    const sources = createNativeSources(async (_command, _args, path) => {
      output = path
      await writeFile(path, base + " ".repeat(size - Buffer.byteLength(base)))
    })
    const result = await sources.inspect({ harness: "opencode", evidence: lane.authorEvidence })
    assert.equal(result.status, expected)
    assert.equal(result.bytes, size)
    if (expected === "available") assert.equal(result.messageCount, 0)
    else assert.match(result.gaps[0], /16 MiB diagnostic parse limit/)
    await assert.rejects(readdir(join(output, "..")), /ENOENT/)
  }
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

test("optional index is built from temporary native files and discarded with them", async () => {
  let exportedPath
  const sources = createNativeSources(async (_command, _args, output) => {
    exportedPath = output
    await writeFile(output, JSON.stringify({ info: { id: "ses_123" }, messages: [{
      info: { id: "msg_1" }, parts: [{ id: "part_1", sessionID: "ses_123", messageID: "msg_1",
        type: "tool", tool: "read", state: { status: "completed", input: { filePath: "a.ts" },
          metadata: { display: { type: "file", path: "a.ts", text: "content", lineStart: 1, lineEnd: 1, totalLines: 1 } } } }],
    }] }))
  })
  const result = await sources.inspect({ role: "author", harness: "opencode", evidence: lane.authorEvidence, includeIndex: true })
  assert.equal(result.segments[0].events[0].kind, "read")
  assert.equal(result.segments[0].events[0].extent.full, true)
  await assert.rejects(readdir(join(exportedPath, "..")), /ENOENT/)
})

test("index includes previous OpenCode sessions and labels a missing segment", async () => {
  const captured = { ...lane, authorEvidence: { ...lane.authorEvidence,
    previous: [{ status: "available", harness: "opencode", nativeSessionId: "ses_old" },
      { status: "available", harness: "opencode", nativeSessionId: "ses_missing" }] } }
  const f = fixture({ current: captured, sources: { inspect: async ({ evidence, role }) => {
    if (evidence.nativeSessionId === "ses_missing") throw new Error("export missing")
    return { status: "available", segments: [{ segmentId: evidence.nativeSessionId ?? role, events: [] }] }
  } } })
  const result = await inspectLaneEvidence({ ...f, worktreePath: path, includeIndex: true })
  assert.equal(result.roles.author.status, "partial")
  assert.deepEqual(result.roles.author.segments.map((segment) => segment.segmentId), ["ses_old", "ses_123"])
  assert.match(result.roles.author.gaps[0], /prior segment 2: export missing/)
})

test("indexed Codex collection keeps a good bundle when another reducer output is malformed", async () => {
  const root = await mkdtemp(join(tmpdir(), "tars-test-traces-"))
  const outputs = []
  try {
    for (const name of ["bundle-a", "bundle-b"]) {
      await mkdir(join(root, name))
      await writeFile(join(root, name, "manifest.json"), "{}")
    }
    const sources = createNativeSources(async (_command, args, output) => {
      outputs.push(output)
      await writeFile(output, args[2].endsWith("bundle-a")
        ? JSON.stringify({ schema_version: 1, trace_id: "trace", rollout_id: "rollout",
          terminal_operations: {}, compactions: {} }) : "{invalid")
    })
    const result = await sources.inspect({ role: "reviewer", harness: "codex",
      evidence: { ...lane.reviewerEvidence, traceRoot: root }, includeIndex: true })
    assert.equal(result.status, "partial")
    assert.equal(result.segments.length, 1)
    assert.equal(result.bundleCount, 2)
    assert.match(result.gaps[0], /bundle-b:.*JSON/)
    assert.equal(result.reducedBytes, Buffer.byteLength(JSON.stringify({ schema_version: 1,
      trace_id: "trace", rollout_id: "rollout", terminal_operations: {}, compactions: {} })))
    await assert.rejects(readdir(join(outputs[0], "..")), /ENOENT/)
  } finally { await rm(root, { recursive: true, force: true }) }
})

test("indexed collection keeps the usable role and identifies an unavailable role", async () => {
  const f = fixture({ sources: { inspect: async ({ role }) => role === "author"
    ? { status: "available", segments: [{ segmentId: "ses_123", events: [
      { kind: "read", visible: true, path: "/repo/a.ts", pointer: { partId: "p1" }, time: 100 },
    ] }] }
    : Promise.reject(new Error("trace missing")) } })
  const result = await inspectLaneEvidence({ ...f, worktreePath: path, includeIndex: true })
  assert.equal(result.roles.author.status, "available")
  assert.equal(result.roles.author.segments[0].events[0].pointer.partId, "p1")
  assert.equal(result.roles.reviewer.status, "unavailable")
  assert.match(result.roles.reviewer.reason, /trace missing/)
  assert.equal(result.roles.author.segments[0].events[0].blockId, "author:initial")
})
