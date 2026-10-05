import assert from "node:assert/strict"
import { readFile } from "node:fs/promises"
import test from "node:test"
import { classifyShell, indexCodex, indexOpenCode } from "../lib/investigation-index.mjs"

test("OpenCode index preserves direct read extent, search query, and compaction provenance", () => {
  const part = (id, fields) => ({ id, sessionID: "ses_one", messageID: "msg_one", ...fields })
  const native = { info: { id: "ses_one" }, messages: [{ info: { id: "msg_one", time: { created: 100 } }, parts: [
    part("p1", { type: "tool", tool: "read", state: { status: "completed", input: { filePath: "/repo/a.ts" },
      metadata: { display: { type: "file", path: "/repo/a.ts", text: "one\n", lineStart: 1, lineEnd: 1, totalLines: 4, truncated: true } }, time: { start: 101, end: 102 } } }),
    part("p2", { type: "tool", tool: "grep", state: { status: "completed", input: { pattern: "needle", path: "/repo" }, metadata: { matches: 1 } } }),
    part("p3", { type: "compaction", auto: false }),
  ] }] }
  const index = indexOpenCode(native, { role: "author", sessionId: "ses_one" })
  assert.equal(index.events[0].kind, "read")
  assert.equal(index.events[0].extent.full, false)
  assert.equal(index.events[0].durationMs, 1)
  assert.equal(index.events[0].pointer.partId, "p1")
  assert.equal(index.events[1].query, "needle")
  assert.equal(index.events[2].kind, "compaction")
  assert.equal(index.events[2].auto, false)
  assert.throws(() => indexOpenCode(native, { role: "author", sessionId: "ses_other" }), /does not match/)
})

test("Codex index reads keyed reducer records and orders installed compaction", () => {
  const native = { schema_version: 1, trace_id: "trace", rollout_id: "rollout", terminal_operations: {
    op1: { operation_id: "op1", tool_call_id: "call1", kind: "exec_command",
      execution: { started_at_unix_ms: 100, started_seq: 4, ended_at_unix_ms: 120, status: "completed" },
      request: { command: ["/bin/zsh", "-lc", "rtk sed -n '1,3p' src/a.ts"] },
      result: { exit_code: 0, formatted_output: "one\ntwo\nthree\n" } },
  }, tool_calls: { call1: { tool_call_id: "call1" }, edit1: { tool_call_id: "edit1", kind: { type: "apply_patch" },
    execution: { started_at_unix_ms: 130, status: "completed" } } },
  inference_calls: { inf1: { inference_call_id: "inf1", usage: { input_tokens: 42 } } },
  compactions: { c1: { installed_at_unix_ms: 150 } } }
  const index = indexCodex(native, { role: "reviewer", bundle: "trace-bundle" })
  assert.deepEqual(index.events.map((event) => event.kind), ["read", "other", "compaction"])
  assert.equal(index.events[0].confidence, "inferred")
  assert.equal(index.events[0].visible, true)
  assert.equal(index.events[0].extent.full, false)
  assert.equal(index.events[0].pointer.operationId, "op1")
  assert.equal(index.events[0].durationMs, 20)
  assert.equal(index.events[1].tool, "apply_patch")
  assert.equal(index.events[2].pointer.compactionId, "c1")
  assert.equal(index.usage[0].metrics.input_tokens, 42)
  assert.throws(() => indexCodex({ ...native, terminal_operations: { wrong: native.terminal_operations.op1 } }, { role: "reviewer", bundle: "x" }), /does not match/)
})

test("shell classification accepts only explicit, simple commands and keeps wrapper provenance", () => {
  const observed = classifyShell("rtk rg -n 'needle' src/a.ts", "8:needle\n", { completed: true, exitCode: 0 })
  assert.equal(observed.kind, "search")
  assert.equal(observed.query, "needle")
  assert.deepEqual(observed.wrappers, ["rtk"])
  assert.equal(observed.visible, true)
  assert.equal(classifyShell('rtk rg -n "easy buy|easy-buy" src/a.ts', '8:easy buy',
    { completed: true, exitCode: 0 }).query, "easy buy|easy-buy")
  const listing = classifyShell("rtk find src -name '*.ts'", "src/a.ts\n", { completed: true, exitCode: 0 })
  assert.equal(listing.kind, "filename-only")
  assert.equal(listing.visible, false)
  for (const command of ["cat a.ts | head -n 2", "cat a.ts > out", "cat $(printf a.ts)", "cat src/*.ts",
    "find src -exec cat {} \\;", "rtk proxy cat a.ts", "./script.sh", "cat a.ts b.ts"]) {
    assert.equal(classifyShell(command, "content", { completed: true, exitCode: 0 }).kind, "unknown", command)
  }
})

test("native read visibility requires the displayed file to match its target", () => {
  const native = { info: { id: "ses_one" }, messages: [{ info: { id: "msg_one" }, parts: [{
    id: "p1", sessionID: "ses_one", messageID: "msg_one", type: "tool", tool: "read",
    state: { status: "completed", input: { filePath: "a.ts" }, metadata: { display: { type: "file", path: "b.ts", text: "content" } } },
  }] }] }
  const event = indexOpenCode(native, { role: "author", sessionId: "ses_one" }).events[0]
  assert.equal(event.kind, "unknown")
  assert.equal(event.visible, false)
})

test("shell classifier preserves only supported observations across output and command variants", () => {
  const run = (command, output = "content", options = {}) => classifyShell(command, output,
    { completed: true, exitCode: 0, ...options })
  assert.deepEqual([run("rtk cat 'src/a b.ts'").kind, run("sed -n 2,5p src/a.ts").extent,
    run("head -n 4 src/a.ts").extent],
  ["read", { start: 2, end: 5, total: null, full: false },
    { start: 1, end: 4, total: null, full: false }])
  for (const options of [{ completed: false }, { exitCode: 1 }, { truncated: true }]) {
    assert.equal(run("cat src/a.ts", "content", options).visible, false)
  }
  assert.equal(run("cat src/a.ts", "").visible, false)
  assert.equal(run("rg -n needle src/a.ts", "src/a.ts:4:needle").visible, true)
  assert.equal(run("rg -n needle src/a.ts", "src/a.ts\n").visible, false)
  for (const command of ["cat a.ts && cat b.ts", "cat a.ts | head -n 1", "cat a.ts > out",
    "cat $(echo a.ts)", "cat `echo a.ts`", "cat a.ts b.ts", "alias r=cat", "./read.sh",
    "cat src/*.ts", "rtk proxy cat a.ts", "cat 'unterminated"]) {
    const result = run(command)
    assert.equal(result.kind, "unknown", command)
    assert.equal(result.visible, false, command)
    assert.equal(result.rawCommand, command, command)
  }
})

test("OpenCode event pointers and order survive an unknown command and compaction", () => {
  const native = { info: { id: "ses_one", directory: "/repo" }, messages: [{
    info: { id: "msg_one", time: { created: 100 } }, parts: [
      { id: "part_1", sessionID: "ses_one", messageID: "msg_one", type: "tool", tool: "bash",
        state: { status: "completed", input: { command: "cat a.ts && cat b.ts" }, output: "content",
          metadata: { exit: 0 }, time: { start: 101, end: 102 } } },
      { id: "part_2", sessionID: "ses_one", messageID: "msg_one", type: "compaction", auto: false },
    ],
  }] }
  const events = indexOpenCode(native, { role: "author", sessionId: "ses_one" }).events
  assert.deepEqual(events.map((event) => event.kind), ["unknown", "compaction"])
  assert.deepEqual(events.map((event) => event.pointer.partId), ["part_1", "part_2"])
  assert.deepEqual(events.map((event) => event.order), [0, 1])
  assert.equal(events[0].rawCommand, "cat a.ts && cat b.ts")
})

test("sanitized issue 75 native shapes retain pointers and expose compound-command gaps", async () => {
  const readFixture = async (name) => JSON.parse(await readFile(
    new URL(`./fixtures/native/${name}`, import.meta.url), "utf8"))
  const author = indexOpenCode(await readFixture("opencode-export.json"),
    { role: "author", sessionId: "ses_fixture" })
  assert.deepEqual(author.events.map((event) => event.kind), ["read", "unknown"])
  assert.equal(author.events[0].pointer.partId, "part_read")
  assert.equal(author.events[0].extent.full, false)
  assert.equal(author.events[1].pointer.partId, "part_bash")
  assert.match(author.events[1].rawCommand, /&&/)
  const reviewer = indexCodex(await readFixture("codex-reduced.json"),
    { role: "reviewer", bundle: "bundle_fixture" })
  assert.equal(reviewer.events.length, 1)
  assert.equal(reviewer.events[0].kind, "unknown")
  assert.equal(reviewer.events[0].pointer.operationId, "op_fixture")
  assert.equal(reviewer.events[0].cwd, "/repo")
  assert.match(reviewer.events[0].rawCommand[2], /&&/)
})
