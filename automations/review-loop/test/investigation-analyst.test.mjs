import assert from "node:assert/strict"
import { mkdir, readFile, readdir, rm, stat, writeFile } from "node:fs/promises"
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


test("subprocess completes progressive paging, content/details retrieval and CLI self-validation", async (t) => {
  const fixture = await investigationFixture(t)
  const events = Array.from({ length: 40 }, (_, i) => ({ id: `E${i}`, sourceId: "s", role: "author", type: "message",
    position: i, time: i, blockId: "B", pointer: {}, attributes: {}, extra: { text: `task-${i}`, future: { flag: true } } }))
  const snapshot = await fixture.cache.prepare({ laneId: "protocol", collect: async () => ({
    sources: [{ id: "s", metadata: {}, native: {} }], events, blocks: [{ id: "B", role: "author", start: 0, end: null }],
    coverage: fixture.snapshot.coverage, asOf: fixture.snapshot.asOf }) })
  const cli = new URL("../cli.mjs", import.meta.url).pathname
  const script = `
    const assert=require("node:assert/strict"),fs=require("node:fs"),{execFileSync}=require("node:child_process");
    const c=JSON.parse(fs.readFileSync("context.json","utf8"));
    const query=(method,args=[])=>JSON.parse(execFileSync(process.execPath,[${JSON.stringify(cli)},"lane","evidence",method,
      "--cache-root",c.cacheRoot,"--snapshot-id",c.snapshotId,"--reader-lease",c.readerLease,...args],{encoding:"utf8"}));
    assert.equal(query("overview").blocks.length,1);
    let cursor,events=[],pages=0;
    do { const page=query("list_events",cursor?["--cursor",cursor]:[]);events.push(...page.events);cursor=page.nextCursor;pages++; } while(cursor);
    assert(pages>1);assert.equal(events.length,40);assert.equal(new Set(events.map(e=>e.eventId)).size,40);
    const e=events[0],field=e.contentFields[0].fieldId;
    assert.equal(query("get_event_content",["--event-id",e.eventId,"--field",field]).text,"task-0");
    const details=query("get_event_details",["--event-id",e.eventId,"--field-path","/extra/future"]);
    assert.equal(details.fields.find(f=>f.key==="flag").value,true);
    const a=${JSON.stringify(reportAnswer({ snapshotId: snapshot.snapshotId, question: fixture.question.identity }))};
    a.citations.c1.eventId=e.eventId;fs.writeFileSync("answer.json",JSON.stringify(a));
    const validation=JSON.parse(execFileSync(process.execPath,[${JSON.stringify(cli)},"lane","investigate","validate-report",
      "--file","answer.json","--context","context.json"],{encoding:"utf8"}));assert.equal(validation.valid,true);
    console.log(JSON.stringify({type:"thread.started",thread_id:"protocol-session"}));
  `
  const answer = await runInvestigationAnalyst({ ...fixture, snapshot, worktreePath: fixture.root, runner: async (command, signal) => {
    await runAnalystProcess({ ...command, command: process.execPath, args: ["-e", script] }, signal)
  } })
  assert.equal(answer.citations.c1.eventId, "E0")
  await fixture.cache.remove(snapshot.snapshotId)
})

test("failed, timed-out and missing-file corrections stop without a third attempt and clean up", async (t) => {
  const fixture = await investigationFixture(t)
  for (const failure of ["crash", "timeout", "missing"]) {
    let calls = 0, directory
    await assert.rejects(runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, runner: async (command) => {
      directory = command.cwd; calls++
      if (calls === 1) { await writeFile(join(directory, "answer.json"), "{}"); return { sessionId: "original" } }
      assert.equal(command.args[2], "original")
      if (failure === "crash") throw new Error("Correction crashed")
      if (failure === "timeout") return runAnalystProcess({ ...command, command: process.execPath, args: ["-e", "setInterval(()=>{},1000)"] }, undefined, { timeoutMs: 50 })
      await rm(join(directory, "answer.json")); return { sessionId: "original" }
    } }), failure === "crash" ? /Correction crashed/ : failure === "timeout" ? /timed out/ : /after correction.*ENOENT/)
    assert.equal(calls, 2); await assert.rejects(stat(directory), /ENOENT/)
    assert.deepEqual(await readdir(join(fixture.snapshot.directory, "leases")), [])
  }
})

test("changing context.json cannot change the snapshot or question used by final validation", async (t) => {
  const fixture = await investigationFixture(t)
  for (const mutation of [{ snapshotId: "substituted" }, { question: { kind: "ad-hoc", text: "Different task" } }]) {
    let calls = 0
    await assert.rejects(runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, runner: async (command) => {
      calls++
      const path = join(command.cwd, "context.json"), context = JSON.parse(await readFile(path, "utf8"))
      Object.assign(context, mutation)
      // The analyst owns its writable directory and could replace even a mode-400 file.
      await rm(path); await writeFile(path, JSON.stringify(context))
      await writeFile(join(command.cwd, "answer.json"), JSON.stringify(reportAnswer(context)))
      return { sessionId: "same" }
    } }), /after correction.*(does not match|Unknown question field)/)
    assert.equal(calls, 2)
    assert.deepEqual(await readdir(join(fixture.snapshot.directory, "leases")), [])
  }
})

test("force publishing newer evidence during analysis does not change its leased snapshot", async (t) => {
  const fixture = await investigationFixture(t)
  let fresh
  const answer = await runInvestigationAnalyst({ ...fixture, worktreePath: fixture.root, runner: async (command) => {
    fresh = await fixture.cache.prepare({ laneId: fixture.snapshot.laneId, force: true, collect: async () => ({
      sources: [], events: [], blocks: [], coverage: fixture.snapshot.coverage, asOf: "2026-10-12T01:00:00Z" }) })
    const context = await writeAnswer(command)
    const rows = await queryEvidence({ cache: fixture.cache, snapshotId: context.snapshotId, readerLease: context.readerLease, method: "list_events" })
    assert.equal(rows.events[0].eventId, "E1")
    assert.equal((await fixture.cache.prepare({ laneId: fixture.snapshot.laneId })).snapshotId, fresh.snapshotId)
    await assert.rejects(fixture.cache.remove(fixture.snapshot.snapshotId), /in use/)
    return { sessionId: "original" }
  } })
  assert.equal(answer.snapshotId, fixture.snapshot.snapshotId)
  assert.notEqual(answer.snapshotId, fresh.snapshotId)
  await fixture.cache.remove(fixture.snapshot.snapshotId); await fixture.cache.remove(fresh.snapshotId)
})

test("dispatch shell commands support spaces, apostrophes and Unicode in assigned paths", async (t) => {
  const fixture = await investigationFixture(t)
  const odd = join(fixture.root, "operator's repo 漢字")
  await mkdir(odd)
  const snapshot = await fixture.cache.prepare({ laneId: "odd", collect: async () => ({ sources: [], events: [], blocks: [], coverage: fixture.snapshot.coverage, asOf: fixture.snapshot.asOf }) })
  // Move the entire cache so both generated command prefixes must quote its path.
  const { rename } = await import("node:fs/promises")
  await rename(fixture.cache.root, join(odd, "cache's files")); fixture.cache.root = join(odd, "cache's files")
  await runInvestigationAnalyst({ ...fixture, snapshot, worktreePath: odd, runner: async (command) => {
    const prefix = command.prompt.match(/Evidence CLI prefix[^\n]*\n([^\n]+)/)[1]
    const validate = command.prompt.match(/Self-validate[^\n]*\n([^\n]+)/)[1]
    const context = await writeAnswer(command, { findings: [], summaryMarkdown: "No events.", citations: {} })
    assert.equal(context.worktreePath, odd)
    const script = `const {execSync}=require("node:child_process");
      const overview=JSON.parse(execSync(${JSON.stringify(prefix + " overview")},{encoding:"utf8"}));
      if(overview.snapshotId!==${JSON.stringify(snapshot.snapshotId)})throw Error("Wrong snapshot");
      const result=JSON.parse(execSync(${JSON.stringify(validate)},{encoding:"utf8"}));if(!result.valid)throw Error("Invalid");`
    await runAnalystProcess({ ...command, command: process.execPath, args: ["-e", script] })
    return { sessionId: "quoted" }
  } })
})
