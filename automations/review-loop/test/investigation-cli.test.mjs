import assert from "node:assert/strict"
import { execFile } from "node:child_process"
import { chmod, mkdir, readFile, readdir, realpath, writeFile } from "node:fs/promises"
import { join } from "node:path"
import { promisify } from "node:util"
import test from "node:test"
import { StateStore } from "../lib/state.mjs"
import { EvidenceSnapshots } from "../lib/investigation-snapshot.mjs"
import { investigationFixture } from "./helpers/investigation.mjs"
const exec = promisify(execFile)
const cli = new URL("../cli.mjs", import.meta.url).pathname

async function setup(t, { codexScript } = {}) {
  const fixture = await investigationFixture(t)
  const root = await realpath(fixture.root), bin = join(root, "bin"), worktree = join(root, "issue-75-cli"), calls = join(root, "calls")
  await mkdir(bin); await mkdir(worktree)
  const statePath = join(root, "state.sqlite"), state = new StateStore(statePath)
  await state.open()
  state.saveLane({ worktreePath: worktree, authorSessionId: "author", reviewerSessionId: "reviewer", state: "watching", maxRounds: 5,
    investigationCapture: "capture", authorHarness: "opencode", reviewerHarness: "codex", authorModel: "other/provider", reviewerModel: "gpt-reviewer" })
  const laneBefore = JSON.stringify(state.lane(worktree)); state.close()
  const snapshot = await fixture.cache.prepare({ laneId: JSON.stringify([worktree, ["author", "reviewer"]]), collect: async () => ({
    sources: [{ id: "s", metadata: {}, native: {} }], events: [{ id: "E1", sourceId: "s", role: "author", type: "message", position: 0, time: 1, blockId: "B", pointer: {}, attributes: {}, extra: { text: "task" } }],
    blocks: [{ id: "B", role: "author", start: 0, end: null }], coverage: { author: { status: "available" }, reviewer: { status: "available" } }, asOf: "2026-10-12T00:00:00Z", gaps: [] }) })
  const scripts = {
    aoe: `console.log(JSON.stringify([{session:"author",state:process.env.TEST_ACTIVITY??"idle"},{session:"reviewer",state:"waiting"}]))`,
    opencode: 'throw new Error("Should reuse cache, never export")',
    codex: `const fs=require("node:fs"),path=require("node:path");fs.appendFileSync(${JSON.stringify(calls)},JSON.stringify(process.argv.slice(2))+"\\n");const c=JSON.parse(fs.readFileSync("context.json","utf8")); const answer={schemaVersion:1,snapshotId:c.snapshotId,question:c.question,scope:{kind:"whole-lane",descriptionMarkdown:"Both roles."},summaryMarkdown:"Observed {{cite:c1}}.",findings:[],limitationsMarkdown:"Some native uncertainty.",conclusionMarkdown:"No supported problem found.",citations:{c1:{kind:"event",eventId:"E1"}}};fs.writeFileSync("answer.json",JSON.stringify(answer));console.log(JSON.stringify({type:"thread.started",thread_id:"new-analyst"}));`
  }
  if (codexScript) scripts.codex = codexScript
  for (const [name, script] of Object.entries(scripts)) { const path = join(bin, name); await writeFile(path, `#!${process.execPath}\n${script}`); await chmod(path, 0o700) }
  const run = (args = [], extras = {}) => exec(process.execPath, [cli, "lane", "investigate", "--issue", "75", "--state", statePath, ...args], {
    env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, XDG_CACHE_HOME: join(fixture.root, "cache"), ...extras } })
  return { ...fixture, snapshot, root, statePath, worktree, calls, laneBefore, run }
}

test("CLI reuses SQLite implicitly, selects Codex fallback, renders/exports and leaves lane untouched", async (t) => {
  const f = await setup(t)
  const output = join(f.root, "report.md")
  const { stdout, stderr } = await f.run(["--output", output])
  assert.match(stderr, /snapshot reused/); assert.match(stdout, /Observed \[E1\]/)
  assert.equal(await readFile(output, "utf8"), stdout)
  const calls = (await readFile(f.calls, "utf8")).trim().split("\n").map(JSON.parse)
  assert.equal(calls.length, 1); assert(calls[0].includes("gpt-reviewer")); assert(!calls[0].includes("other/provider"))
  const state = new StateStore(f.statePath); await state.open(); assert.equal(JSON.stringify(state.lane(f.worktree)), f.laneBefore); state.close()
  assert.equal((await readdir(join(f.snapshot.directory, "leases"))).length, 0)
  await assert.rejects(f.run(["--output", output]), /EEXIST/)
  assert.equal(await readFile(output, "utf8"), stdout)
  assert.equal((await readFile(f.calls, "utf8")).trim().split("\n").length, 1)
})
test("CLI supports ad hoc questions and explicit analyst model with no projection budget or block selection", async (t) => {
  const f = await setup(t)
  const { stdout } = await f.run(["--ad-hoc", "Assess workflow risk", "--report-guidance", "Explain uncertainty", "--analyst-model", "gpt-override"])
  assert.match(stdout, /Question: Assess workflow risk/)
  assert((await readFile(f.calls, "utf8")).includes("gpt-override"))
  for (const args of [["--max-analysis-tokens", "1"], ["--blocks", "B"], ["--question", "unknown"], ["--ad-hoc", "x", "--question", "navigation-efficiency"]]) await assert.rejects(f.run(args))
})
test("CLI requires quiet sessions even for reuse, and both source coverage before launching", async (t) => {
  const f = await setup(t)
  await assert.rejects(f.run([], { TEST_ACTIVITY: "running" }), /must be idle or waiting/)
  await assert.rejects(readFile(f.calls), /ENOENT/)
  const fresh = await f.cache.prepare({ laneId: f.snapshot.laneId, force: true, collect: async () => ({ sources: [], events: [], blocks: [],
    coverage: { author: { status: "available" }, reviewer: { status: "unavailable", reason: "missing trace" } }, asOf: "2026-10-12T00:00:00Z", gaps: ["reviewer unavailable"] }) })
  await assert.rejects(f.run(), /reviewer: missing trace/)
  await assert.rejects(readFile(f.calls), /ENOENT/)
  await f.cache.remove(fresh.snapshotId)
})


async function waitUntil(probe, message) {
  const deadline = Date.now() + 6000
  while (Date.now() < deadline) {
    if (await probe()) return
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  assert.fail(message)
}

function alive(pid) {
  try { process.kill(pid, 0); return true } catch (error) { if (error.code === "ESRCH") return false; throw error }
}

test("SIGINT and SIGTERM cancel the CLI analyst process group, clean resources and emit no report", { timeout: 20_000 }, async (t) => {
  for (const signal of ["SIGINT", "SIGTERM"]) {
    const f = await setup(t, { codexScript: `
      const fs=require("node:fs"),path=require("node:path"),{spawn}=require("node:child_process");
      const c=JSON.parse(fs.readFileSync("context.json","utf8"));
      const grandchild=spawn(process.execPath,["-e",'process.on("SIGTERM",()=>{});console.log("ready");setInterval(()=>{},1000)'],{stdio:["ignore","pipe","inherit"]});
      grandchild.stdout.once("data",()=>fs.writeFileSync(path.join(c.worktreePath,"started.json"),JSON.stringify({pid:process.pid,grandchild:grandchild.pid,directory:process.cwd()})));
      process.on("SIGTERM",()=>{});setInterval(()=>{},1000);
    ` })
    const output = join(f.root, "cancelled.md"), started = join(f.worktree, "started.json")
    const pending = f.run(["--output", output])
    // Install rejection handling before signalling the CLI.
    const result = pending.then(value => ({ value }), error => ({ error }))
    let record
    await waitUntil(async () => {
      try { record = JSON.parse(await readFile(started, "utf8")); return true } catch (error) { if (error.code === "ENOENT") return false; throw error }
    }, "analyst did not start")
    t.after(() => { for (const pid of [pending.child.pid, record.pid, record.grandchild]) { try { process.kill(pid, "SIGKILL") } catch {} } })
    assert(alive(record.pid)); assert(alive(record.grandchild))
    assert.equal(pending.child.kill(signal), true)
    const { error } = await result
    assert(error); assert.match(error.stderr, /Investigation interrupted/); assert.equal(error.stdout, "")
    await waitUntil(() => !alive(record.pid) && !alive(record.grandchild), "analyst descendants survived cancellation")
    await assert.rejects(readFile(output), /ENOENT/)
    await assert.rejects(realpath(record.directory), /ENOENT/)
    assert.deepEqual(await readdir(join(f.snapshot.directory, "leases")), [])
    const state = new StateStore(f.statePath); await state.open()
    assert.equal(JSON.stringify(state.lane(f.worktree)), f.laneBefore); state.close()
  }
})

test("failed export reports its destination error without stdout or leaked analyst resources", async (t) => {
  const f = await setup(t)
  const output = join(f.root, "missing-parent", "report.md")
  await assert.rejects(f.run(["--output", output]), error => {
    assert.match(error.stderr, /ENOENT/); assert.equal(error.stdout, ""); return true
  })
  assert.deepEqual(await readdir(join(f.snapshot.directory, "leases")), [])
  await assert.rejects(readFile(output), /ENOENT/)
  const state = new StateStore(f.statePath); await state.open()
  assert.equal(JSON.stringify(state.lane(f.worktree)), f.laneBefore); state.close()
})


test("unwritable export directory fails clearly and releases the reader lease", async (t) => {
  const f = await setup(t)
  const directory = join(f.root, "read-only")
  await mkdir(directory); await chmod(directory, 0o500)
  try {
    await assert.rejects(f.run(["--output", join(directory, "report.md")]), error => {
      assert.match(error.stderr, /EACCES/); assert.equal(error.stdout, ""); return true
    })
    assert.deepEqual(await readdir(join(f.snapshot.directory, "leases")), [])
    assert.deepEqual(await readdir(directory), [])
  } finally { await chmod(directory, 0o700) }
})

test("export remains exclusive if a destination appears after preflight", async (t) => {
  const f = await setup(t, { codexScript: `
    const fs=require("node:fs"),path=require("node:path");const c=JSON.parse(fs.readFileSync("context.json","utf8"));
    fs.writeFileSync(path.join(c.worktreePath,"raced.md"),"operator content");
    const a={schemaVersion:1,snapshotId:c.snapshotId,question:c.question,scope:{kind:"whole-lane",descriptionMarkdown:"Both roles."},
      summaryMarkdown:"Observed {{cite:c1}}.",findings:[],limitationsMarkdown:"",conclusionMarkdown:"No supported problem.",citations:{c1:{kind:"event",eventId:"E1"}}};
    fs.writeFileSync("answer.json",JSON.stringify(a));console.log(JSON.stringify({type:"thread.started",thread_id:"s"}));
  ` })
  const output = join(f.worktree, "raced.md")
  await assert.rejects(f.run(["--output", output]), /EEXIST/)
  assert.equal(await readFile(output, "utf8"), "operator content")
  assert.deepEqual(await readdir(join(f.snapshot.directory, "leases")), [])
})
