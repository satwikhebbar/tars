import assert from "node:assert/strict"
import { readFile, readdir, stat, writeFile } from "node:fs/promises"
import { join } from "node:path"
import test from "node:test"
import { analystCommand, runInvestigationAnalyst, runAnalystProcess } from "../lib/investigation-analyst.mjs"
import { queryEvidence } from "../lib/investigation-query.mjs"
import { investigationFixture, reportAnswer, assignedContext } from "./helpers/investigation.mjs"

async function writeAnswer(command, changes = {}) {
  const { answerPath, contextPath } = assignedContext(command)
  const context = JSON.parse(await readFile(contextPath, "utf8"))
  await writeFile(answerPath, JSON.stringify(reportAnswer(context, changes)))
  return context
}

test("separate Codex analyst gets bounded overview, progressive CLI and file protocol with a lifetime lease", async (t) => {
  const fixture = await investigationFixture(t)
  let directory
  const answer = await runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, model: "gpt-test", runner: async (command) => {
    directory = command.cwd
    assert.notEqual(directory, fixture.root)
    assert.equal((await stat(directory)).mode & 0o777, 0o700)
    assert.equal(command.command, "codex"); assert(command.args.includes("workspace-write"))
    assert(!command.args.includes("--ephemeral")); assert(!command.args.includes("--add-dir"))
    assert(command.args.includes('approval_policy="never"'))
    assert(command.args.includes("sandbox_workspace_write.writable_roots=[]"))
    assert(command.args.includes("sandbox_workspace_write.exclude_slash_tmp=true"))
    assert(command.args.includes("--ignore-user-config")); assert(command.args.includes("--ignore-rules"))
    assert.equal(command.env.CODEX_ROLLOUT_TRACE_ROOT, undefined)
    assert(command.args.includes("gpt-test")); assert.equal(command.args.at(-1), "-")
    const context = await writeAnswer(command)
    assert.match(command.prompt, /get_event_details/); assert.match(command.prompt, /First overview page/)
    assert.match(command.prompt, /validate-report/); assert.match(command.prompt, /not authority/)
    await assert.rejects(fixture.cache.remove(fixture.snapshot.snapshotId), /in use|lease/i)
    const page = await queryEvidence({ cache: fixture.cache, snapshotId: context.snapshotId, readerLease: context.readerLease, method: "list_events" })
    assert.equal(page.events[0].eventId, "E1")
    assert.equal((await readdir(join(fixture.snapshot.directory, "leases"))).length, 1)
    return { sessionId: "analyst-session" }
  } })
  assert.equal(answer.scope.kind, "whole-lane")
  await assert.rejects(stat(directory), /ENOENT/)
  await fixture.cache.remove(fixture.snapshot.snapshotId)
})
test("one invalid answer is corrected in the same session with identical model and sandbox", async (t) => {
  const fixture = await investigationFixture(t)
  let count = 0, directory
  const answer = await runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, model: "gpt-test", runner: async (command) => {
    count++
    if (count === 1) {
      directory = command.cwd
      await writeAnswer(command, { citations: { c1: { kind: "event", eventId: "missing" } } })
      return { sessionId: "specific-session" }
    }
    assert.equal(command.cwd, directory)
    assert.deepEqual(command.args.slice(0, 3), ["exec", "resume", "specific-session"])
    assert(command.args.includes("sandbox_mode=workspace-write")); assert(command.args.includes("gpt-test"))
    assert.match(command.prompt, /Unknown cited event ID/)
    const context = JSON.parse(await readFile(join(directory, "context.json"), "utf8"))
    await writeFile(join(directory, "answer.json"), JSON.stringify(reportAnswer(context)))
    return { sessionId: "specific-session" }
  } })
  assert.equal(count, 2); assert.equal(answer.citations.c1.eventId, "E1")
})
test("missing answer file gets one correction using the thread ID captured from JSONL", async (t) => {
  const fixture = await investigationFixture(t)
  let count = 0
  await runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, runner: async (command) => {
    count++
    if (count === 1) await writeFile(command.output, JSON.stringify({ type: "thread.started", thread_id: "from-jsonl" }) + "\n")
    else {
      assert.equal(command.args[2], "from-jsonl")
      const context = JSON.parse(await readFile(join(command.cwd, "context.json"), "utf8"))
      await writeFile(join(command.cwd, "answer.json"), JSON.stringify(reportAnswer(context)))
      await writeFile(command.output, "")
    }
  } })
  assert.equal(count, 2)
})
test("persistent invalid report stops after one correction and removes directory/lease", async (t) => {
  const fixture = await investigationFixture(t)
  let count = 0, directory
  await assert.rejects(runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, runner: async (command) => {
    directory = command.cwd; count++
    await writeFile(join(directory, "answer.json"), "not JSON")
    return { sessionId: "same" }
  } }), /after correction/)
  assert.equal(count, 2); await assert.rejects(stat(directory), /ENOENT/)
  await fixture.cache.remove(fixture.snapshot.snapshotId)
})
test("no session ID prevents correction; process failure is not silently retried", async (t) => {
  const fixture = await investigationFixture(t)
  let count = 0
  for (const failProcess of [false, true]) {
    let directory
    await assert.rejects(runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, runner: async (command) => {
      directory = command.cwd; count++
      if (failProcess) throw new Error("Process failed")
      await writeFile(command.output, "{}\n"); await writeFile(join(command.cwd, "answer.json"), "{}")
    } }), failProcess ? /Process failed/ : /no session ID/)
    await assert.rejects(stat(directory), /ENOENT/)
    assert.equal((await readdir(join(fixture.snapshot.directory, "leases"))).length, 0)
  }
  assert.equal(count, 2)
})
test("both native sources are required before acquiring a lease or launching", async (t) => {
  const fixture = await investigationFixture(t, { author: { status: "available" }, reviewer: { status: "unavailable", reason: "missing trace" } })
  let calls = 0
  await assert.rejects(runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, runner: async () => calls++ }), /reviewer: missing trace/)
  assert.equal(calls, 0); await assert.rejects(stat(join(fixture.snapshot.directory, "leases")), /ENOENT/)
})
test("minor source gaps do not block a partial report", async (t) => {
  const fixture = await investigationFixture(t, { author: { status: "partial", gaps: ["unclassified commands"] }, reviewer: { status: "available" } })
  const answer = await runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, runner: async (command) => {
    await writeAnswer(command, { scope: { kind: "partial", descriptionMarkdown: "Limited command visibility." } })
    return { sessionId: "session" }
  } })
  assert.equal(answer.scope.kind, "partial")
})
test("ad hoc question uses common tools and generic validation without navigation instructions", async (t) => {
  const fixture = await investigationFixture(t)
  const question = { identity: { kind: "ad-hoc", text: "Assess workflow risk." }, instructions: "Assess workflow risk." }
  await runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, question, runner: async (command) => {
    assert.match(command.prompt, /Assess workflow risk/); assert(!command.prompt.includes("Compare repetition within each role"))
    await writeAnswer(command); return { sessionId: "s" }
  } })
})
test("pre-aborted investigation releases its lease and private run directory without launching", async (t) => {
  const fixture = await investigationFixture(t)
  const controller = new AbortController(); controller.abort()
  let calls = 0
  await assert.rejects(runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, signal: controller.signal, runner: async () => calls++ }), /interrupted/)
  assert.equal(calls, 0); await fixture.cache.remove(fixture.snapshot.snapshotId)
})
test("process runner streams prompt over stdin and JSONL to file, with failures and interruption", async (t) => {
  const { root } = await investigationFixture(t)
  const command = (script, name) => ({ command: process.execPath, args: ["-e", script], cwd: root, env: process.env, output: join(root, name), prompt: "assigned prompt" })
  const success = command('process.stdin.on("data", data=>console.log(JSON.stringify({prompt:data.toString()})))', "success")
  await runAnalystProcess(success)
  assert.equal(JSON.parse(await readFile(success.output, "utf8")).prompt, "assigned prompt")
  await assert.rejects(runAnalystProcess(command('console.error("failed");process.exit(2)', "failed")), /exited 2: failed/)
  const controller = new AbortController()
  const pending = runAnalystProcess(command("setInterval(()=>{},1000)", "abort"), controller.signal)
  setTimeout(() => controller.abort(), 100)
  await assert.rejects(pending, /interrupted/)
  await assert.rejects(runAnalystProcess(command("setInterval(()=>{},1000)", "timeout"), undefined, { timeoutMs: 50 }), /timed out/)
})
